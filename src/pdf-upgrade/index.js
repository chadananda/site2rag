// PDF upgrade queue worker -- processes one document per tick from pdf_upgrade_queue.
// Run via PM2 as a long-lived daemon; processes worst-scoring PDFs first.
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import { cpus } from 'os';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, getMirrorRoot, mirrorDir, metaDir } from '../config.js';
import { openDb } from '../db.js';
import { ocrAvailableBackend, reocrDocument } from './reocr.js';
import { identifyDocument } from './identify.js';
import { rebuildPdf } from './rebuild.js';
import { scorePdf, saveQualityScore } from './score.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between docs
const SUMMARIZE_BATCH = 10; // Haiku summaries to generate per tick
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256file = (path) => sha256(readFileSync(path));

/**
 * Check all other site DBs for an already-upgraded PDF with the same content hash.
 * Returns { upgraded_pdf_path, after_score, score_improvement, pages_processed, method } or null.
 */
const findUpgradedDuplicate = (contentHash, allDomains, skipDomain) => {
  for (const domain of allDomains) {
    if (domain === skipDomain) continue;
    let db;
    try {
      const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
      if (!existsSync(dbPath)) continue;
      db = openDb(domain);
      const hit = db.prepare(`
        SELECT u.upgraded_pdf_path, u.after_score, u.score_improvement, u.pages_processed, u.method
        FROM pdf_upgrade_queue u
        JOIN pdf_quality pq ON u.url=pq.url
        WHERE pq.content_hash=? AND u.status='done' AND u.upgraded_pdf_path IS NOT NULL
        LIMIT 1`).get(contentHash);
      if (hit && existsSync(hit.upgraded_pdf_path)) return hit;
    } catch {} finally { try { db?.close(); } catch {} }
  }
  return null;
};

const log = (msg) => console.log(`[pdf-upgrade] ${new Date().toISOString().slice(0,19)} ${msg}`);

/**
 * Scan all local HTML pages in the mirror and populate hosts table with PDF link anchor text.
 * Runs once per DB (guarded by site_meta key). This gives the summarizer title context for
 * every PDF that was linked from a spidered page.
 */
const backfillHostsFromMirror = async (db, domain) => {
  const already = db.prepare("SELECT value FROM site_meta WHERE key='hosts_backfilled_at'").get();
  if (already) return;

  const { load } = await import('cheerio');
  const htmlPages = db.prepare(
    "SELECT url, local_path FROM pages WHERE mime_type LIKE 'text/html%' AND local_path IS NOT NULL AND gone=0"
  ).all();

  let inserted = 0;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO hosts (host_url, hosted_url, hosted_title, detected_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  const insertMany = db.transaction((rows) => { for (const r of rows) insert.run(...r); });

  for (const { url: hostUrl, local_path } of htmlPages) {
    if (!existsSync(local_path)) continue;
    let html;
    try { html = readFileSync(local_path, 'utf8'); } catch { continue; }
    if (!html.includes('.pdf')) continue; // fast skip

    const $ = load(html);
    const batch = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.toLowerCase().includes('.pdf')) return;
      let hostedUrl;
      try { hostedUrl = new URL(href, hostUrl).toString().split('#')[0]; } catch { return; }
      if (!hostedUrl.toLowerCase().endsWith('.pdf')) return;
      const text = $(el).text().trim() || href.split('/').pop();
      batch.push([hostUrl, hostedUrl, text, now]);
    });
    if (batch.length) { insertMany(batch); inserted += batch.length; }
  }

  db.prepare("INSERT OR REPLACE INTO site_meta (key, value) VALUES ('hosts_backfilled_at', ?)").run(now);
  log(`Backfilled hosts: ${inserted} PDF links from ${htmlPages.length} HTML pages`);
};

/**
 * Identify language (and optionally topic) for image PDFs with no text layer.
 * Three-stage cascade per tick, cheapest first:
 *   1. Free: Unicode scan of anchor text + host page paragraph around the link
 *   2. Cheap boss scan: single page rasterized at 1.5×, asks "Language: / Topic:" (≤40 tokens)
 *   3. If still unknown: mark as 'unknown' and heavily deprioritize in queue
 *
 * Runs free-detection on up to FREE_BATCH docs. Boss scan limited to BOSS_BATCH.
 * Unknown-after-scan docs get LANG_PRIORITY.unknown (0.30) so they don't block known ones.
 */
const FREE_BATCH = 200;
const IDENTIFY_BATCH = 40;   // parallel Tesseract+Haiku jobs per tick

const detectLanguageForImagePdfs = async (db, domain) => {
  const { detectLanguage, LANG_PRIORITY } = await import('./score.js');

  const saveAndReprioritize = (url, langKey, topic) => {
    db.prepare('UPDATE pdf_quality SET ai_language=? WHERE url=?').run(langKey, url);
    if (topic) {
      // Store topic as a rough ai_summary if no better one exists yet
      const existing = db.prepare('SELECT ai_summary FROM pdf_quality WHERE url=?').get(url);
      if (!existing?.ai_summary) db.prepare('UPDATE pdf_quality SET ai_summary=? WHERE url=?').run(topic, url);
    }
    const queueRow = db.prepare("SELECT priority, before_score FROM pdf_upgrade_queue WHERE url=? AND status='pending'").get(url);
    if (queueRow) {
      const score = db.prepare('SELECT composite_score FROM pdf_quality WHERE url=?').get(url)?.composite_score ?? 0.5;
      const mult = LANG_PRIORITY[langKey] ?? LANG_PRIORITY.unknown;
      db.prepare('UPDATE pdf_upgrade_queue SET priority=? WHERE url=?').run((1 - score) * mult, url);
    }
  };

  // Stage 1 — free Unicode detection (fast, no boss needed)
  const freeRows = db.prepare(`
    SELECT pq.url, pq.pdf_title, pq.excerpt,
           h.hosted_title, hp.local_path as host_local_path, p.local_path
    FROM pdf_quality pq
    LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON pq.url=h.hosted_url
    LEFT JOIN pages hp ON h.host_url=hp.url
    LEFT JOIN pages p ON pq.url=p.url
    WHERE (pq.ai_language IS NULL OR pq.ai_language='unknown')
      AND (pq.has_text_layer=0 OR pq.has_text_layer IS NULL)
    LIMIT ?`).all(FREE_BATCH);

  let freeDetected = 0;
  for (const row of freeRows) {
    // Try anchor text + title
    const titleSample = [row.hosted_title, row.pdf_title, row.excerpt].filter(Boolean).join(' ');
    let langKey = detectLanguage(titleSample);
    if (langKey === 'unknown' || !langKey) {
      // Try host page paragraph around the link
      if (row.host_local_path && existsSync(row.host_local_path)) {
        try {
          const html = readFileSync(row.host_local_path, 'utf8').slice(0, 80_000);
          const filename = row.url.split('/').pop();
          const idx = html.indexOf(filename);
          const snippet = idx >= 0 ? html.slice(Math.max(0, idx - 800), idx + 800) : html.slice(0, 4000);
          const text = snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          langKey = detectLanguage(text);
        } catch {}
      }
    }
    if (langKey && langKey !== 'unknown') {
      saveAndReprioritize(row.url, langKey, null);
      log(`Lang (free): ${row.url} → ${langKey}`);
      freeDetected++;
    } else {
      // Mark as 'unknown' (explicit) so boss-scan stage can find and deprioritize
      db.prepare('UPDATE pdf_quality SET ai_language=? WHERE url=?').run('unknown', row.url);
      saveAndReprioritize(row.url, 'unknown', null); // applies 0.30 multiplier
    }
  }
  if (freeDetected) log(`Lang free scan: ${freeDetected}/${freeRows.length} identified`);

  // Stage 2 — multi-stage identify pipeline: Tesseract + Haiku + Boss vision, run in parallel
  const identifyRows = db.prepare(`
    SELECT pq.url, pq.pdf_title, pq.excerpt,
           h.hosted_title, hp.local_path as host_local_path, p.local_path
    FROM pdf_quality pq
    JOIN pages p ON pq.url=p.url
    LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON pq.url=h.hosted_url
    LEFT JOIN pages hp ON h.host_url=hp.url
    WHERE pq.ai_language='unknown'
      AND (pq.has_text_layer=0 OR pq.has_text_layer IS NULL)
      AND p.local_path IS NOT NULL
    ORDER BY COALESCE((SELECT priority FROM pdf_upgrade_queue WHERE url=pq.url), 0) DESC
    LIMIT ?`).all(IDENTIFY_BATCH);

  const concurrency = Math.max(4, Math.floor(cpus().length / 2));
  let identified = 0;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Concurrency pool — run up to `concurrency` identify jobs simultaneously
  const queue = identifyRows.filter(r => existsSync(r.local_path));
  const runOne = async (row) => {
    try {
      let hostPageSnippet = '';
      if (row.host_local_path && existsSync(row.host_local_path)) {
        try {
          const html = readFileSync(row.host_local_path, 'utf8').slice(0, 80_000);
          const filename = row.url.split('/').pop();
          const idx = html.indexOf(filename);
          hostPageSnippet = idx >= 0
            ? html.slice(Math.max(0, idx - 400), idx + 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            : '';
        } catch {}
      }
      const metadata = { hostedTitle: row.hosted_title || null, pdfTitle: row.pdf_title || null, excerpt: row.excerpt || null, hostPageSnippet };
      const result = await identifyDocument(row.local_path, metadata, db, row.url, apiKey);
      if (result.langKey && result.langKey !== 'unknown') {
        saveAndReprioritize(row.url, result.langKey, result.summary);
        log(`Lang (${result.stage}): ${row.url} → ${result.langKey}${result.summary ? ' / ' + result.summary.slice(0, 60) : ''}`);
        identified++;
      } else {
        saveAndReprioritize(row.url, 'unknown', null);
      }
    } catch (e) {
      log(`Identify failed: ${row.url}: ${e.message}`);
    }
  };

  // Run in chunks of `concurrency`
  for (let i = 0; i < queue.length; i += concurrency) {
    await Promise.all(queue.slice(i, i + concurrency).map(runOne));
  }
  if (identifyRows.length) log(`Identify pipeline: ${identified}/${identifyRows.length} resolved (concurrency=${concurrency})`);
};

/** Generate Haiku AI summaries for the top N pending queue items that don't have one yet. */
const summarizeTopPending = async (db, domain) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const rows = db.prepare(`
    SELECT q.url, pq.pdf_title, pq.excerpt, h.hosted_title, h.host_url as source_url
    FROM pdf_upgrade_queue q
    JOIN pdf_quality pq ON q.url = pq.url
    LEFT JOIN hosts h ON q.url = h.hosted_url
    WHERE q.status = 'pending' AND pq.ai_summarized_at IS NULL
    ORDER BY q.priority DESC
    LIMIT ?`).all(SUMMARIZE_BATCH);
  if (!rows.length) return;

  const client = new Anthropic({ apiKey });
  let done = 0;
  for (const row of rows) {
    try {
      const title = row.hosted_title || row.pdf_title || null;
      const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
      const displayTitle = title || (slug.length > 3 && !/^\d+$/.test(slug.trim()) ? slug : null);
      if (!displayTitle && !row.excerpt && !row.source_url) {
        db.prepare('UPDATE pdf_quality SET ai_summarized_at=? WHERE url=?').run(new Date().toISOString(), row.url);
        done++; continue;
      }
      const prompt = `Metadata for a PDF document:\n${[
        displayTitle && `Title: ${displayTitle}`,
        `URL: ${row.url}`,
        row.source_url && `Source page: ${row.source_url}`,
        row.excerpt && `Excerpt: ${row.excerpt.slice(0, 500)}`
      ].filter(Boolean).join('\n')}\n\nRespond with exactly two plain-text lines (no markdown, no numbering):\nLine 1: one sentence describing this document.\nLine 2: Author: [full name, or Unknown]`;
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = msg.content[0]?.text || '';
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const summary = lines[0] || null;
      const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
      const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
      db.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_summarized_at=? WHERE url=?')
        .run(summary, author, new Date().toISOString(), row.url);
      done++;
    } catch (e) {
      log(`summarize failed: ${row.url}: ${e.message}`);
    }
  }
  if (done) log(`Summarized ${done} pending docs via Haiku`);
};

/** Process one queued PDF document. allDomains used for cross-site dedup check. */
const processOne = async (db, domain, row, allDomains = [], ocrBackend = 'boss') => {
  const mirrorRoot = getMirrorRoot();

  // Look up the page to get local_path
  const page = db.prepare('SELECT * FROM pages WHERE url=?').get(row.url);
  if (!page || !page.local_path || !existsSync(page.local_path)) {
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(new Date().toISOString(), 'local_path missing', row.url);
    return;
  }

  db.prepare("UPDATE pdf_upgrade_queue SET status='processing', started_at=? WHERE url=?")
    .run(new Date().toISOString(), row.url);
  log(`Processing: ${row.url} (priority ${row.priority.toFixed(2)})`);

  try {
    // Compute content hash for dedup and as OCR cache key
    const contentHash = sha256file(page.local_path);

    // Cross-site dedup: if another site already upgraded an identical document, reuse the file
    const dup = findUpgradedDuplicate(contentHash, allDomains, domain);
    if (dup) {
      // Copy upgraded file to this domain's .upgraded dir so it's domain-local
      const hash = sha256(page.url).slice(0, 16);
      const upgradedDir = join(mirrorDir(domain), '.upgraded');
      mkdirSync(upgradedDir, { recursive: true });
      const outputPath = join(upgradedDir, `x${hash}.pdf`);
      copyFileSync(dup.upgraded_pdf_path, outputPath);
      const improvement = (dup.after_score || 0) - (row.before_score || 0);
      db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
        .run(new Date().toISOString(), outputPath, dup.after_score, improvement, dup.pages_processed, `${dup.method}+dedup`, row.url);
      log(`Dedup hit: ${row.url} → reused from another site (${contentHash.slice(0, 8)}…)`);
      return;
    }

    // Store content hash so future dedup checks can find this document
    db.prepare('UPDATE pdf_quality SET content_hash=? WHERE url=?').run(contentHash, row.url);

    // Get quality data and metadata for embedding
    const quality = db.prepare(`
      SELECT pq.pages, pq.pdf_title, pq.ai_summary, pq.ai_author, h.hosted_title, h.host_url as source_url
      FROM pdf_quality pq LEFT JOIN hosts h ON pq.url=h.hosted_url WHERE pq.url=?`).get(row.url);
    const numPages = quality?.pages || 1;
    const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
    const meta = {
      title:   quality?.hosted_title || quality?.pdf_title || (slug.length > 3 && !/^\d+$/.test(slug) ? slug : null) || undefined,
      author:  quality?.ai_author && quality.ai_author !== 'Unknown' ? quality.ai_author : undefined,
      subject: quality?.ai_summary || undefined,
      keywords: ['site2rag', domain, ...(quality?.source_url ? [quality.source_url] : []), row.url]
    };

    // Re-OCR via boss — use content hash as cache key so identical PDFs share OCR cache
    let ocrResults;
    try {
      ocrResults = await reocrDocument(page.local_path, domain, contentHash, numPages, (n, total) => {
        if (n % 5 === 0 || n === total) log(`  page ${n}/${total}`);
      }, ocrBackend);
    } catch (err) {
      throw new Error(`reocr failed: ${err.message}`);
    }

    // Flat hash-named storage — browser gets original filename via Content-Disposition on download
    const hash = sha256(page.url).slice(0, 16);
    const upgradedDir = join(mirrorDir(domain), '.upgraded');
    mkdirSync(upgradedDir, { recursive: true });
    const outputPath = join(upgradedDir, `x${hash}.pdf`);
    const { success, method, error } = await rebuildPdf(page.local_path, outputPath, ocrResults, meta);

    if (!success) throw new Error(error);

    // Score the upgraded PDF
    const afterMetrics = await scorePdf(outputPath);
    const improvement = afterMetrics.composite_score - row.before_score;

    db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
      .run(new Date().toISOString(), outputPath, afterMetrics.composite_score, improvement, numPages, method, row.url);

    log(`Done: ${row.url} score ${(row.before_score||0).toFixed(2)} → ${afterMetrics.composite_score.toFixed(2)} (+${improvement.toFixed(2)}) via ${method}`);
  } catch (err) {
    log(`Failed: ${row.url}: ${err.message}`);
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(new Date().toISOString(), err.message, row.url);
  }
};

/** Main tick -- backfill hosts, summarize, then OCR-process if boss is available. */
const tick = async () => {
  const { sites } = loadConfig();
  if (!sites.length) return;

  const openDbs = [];
  for (const site of sites) {
    const domain = new URL(site.url).hostname;
    openDbs.push({ db: openDb(domain), domain });
  }

  // Backfill + summarize + language detection run regardless of boss availability
  for (const { db, domain } of openDbs) {
    await backfillHostsFromMirror(db, domain);
    await summarizeTopPending(db, domain);
    await detectLanguageForImagePdfs(db, domain);
  }

  // OCR processing requires boss or Claude vision API
  const ocrBackend = await ocrAvailableBackend();
  if (!ocrBackend) {
    log('No OCR backend available (boss unreachable, no ANTHROPIC_API_KEY), skipping');
    for (const { db } of openDbs) { try { db.close(); } catch {} }
    return;
  }
  if (ocrBackend === 'claude') log('Boss unavailable, using Claude vision API for OCR');

  let bestRow = null, bestDomain = null, bestDb = null;
  for (const { db, domain } of openDbs) {
    const row = db.prepare(`
      SELECT q.*, pq.composite_score as before_score
      FROM pdf_upgrade_queue q
      LEFT JOIN pdf_quality pq ON q.url = pq.url
      WHERE q.status='pending'
      ORDER BY q.priority DESC
      LIMIT 1
    `).get();
    if (row && (!bestRow || row.priority > bestRow.priority)) {
      bestRow = row; bestDomain = domain; bestDb = db;
    }
  }

  if (bestRow && bestDb) {
    const allDomains = openDbs.map(o => o.domain);
    await processOne(bestDb, bestDomain, bestRow, allDomains, ocrBackend);
  } else {
    log('No pending items');
  }

  for (const { db } of openDbs) { try { db.close(); } catch {} }
};

// Main loop
log('PDF upgrade worker started');
const run = async () => {
  await tick();
  setTimeout(run, TICK_INTERVAL_MS);
};
run();
