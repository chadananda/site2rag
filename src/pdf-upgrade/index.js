// PDF upgrade queue worker -- processes one document per tick from pdf_upgrade_queue.
// Run via PM2 as a long-lived daemon; processes worst-scoring PDFs first.
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, getMirrorRoot, mirrorDir, metaDir } from '../config.js';
import { openDb } from '../db.js';
import { bossAvailable, reocrDocument } from './reocr.js';
import { rebuildPdf } from './rebuild.js';
import { scorePdf, saveQualityScore } from './score.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between docs
const SUMMARIZE_BATCH = 10; // Haiku summaries to generate per tick
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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

/** Process one queued PDF document. */
const processOne = async (db, domain, row) => {
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

    // Re-OCR via boss
    let ocrResults;
    try {
      ocrResults = await reocrDocument(page.local_path, domain, sha256(page.local_path), numPages, (n, total) => {
        if (n % 5 === 0 || n === total) log(`  page ${n}/${total}`);
      });
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

  // Backfill + summarize run regardless of boss availability
  for (const { db, domain } of openDbs) {
    await backfillHostsFromMirror(db, domain);
    await summarizeTopPending(db, domain);
  }

  // OCR processing requires boss
  const available = await bossAvailable();
  if (!available) {
    log('Boss unavailable, skipping OCR processing');
    for (const { db } of openDbs) { try { db.close(); } catch {} }
    return;
  }

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
    await processOne(bestDb, bestDomain, bestRow);
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
