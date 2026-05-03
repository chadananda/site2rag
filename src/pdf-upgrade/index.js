// PDF upgrade loop: dequeue, dedup check, re-OCR, rebuild, score. Exports: (none, run as daemon). Deps: backfill, lang-detect, summarize, reocr, rebuild, score, db
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { loadConfig, getMirrorRoot, mirrorDir } from '../config.js';
import { openDb } from '../db.js';
import { ocrAvailableBackend, reocrDocument } from './reocr.js';
import { rebuildPdf } from './rebuild.js';
import { scorePdf } from './score.js';
import { backfillHostsFromMirror } from './backfill.js';
import { detectLanguageForImagePdfs } from './lang-detect.js';
import { summarizeTopPending } from './summarize.js';

const TICK_INTERVAL_MS = 60 * 1000;
const SUMMARIZE_INTERVAL_MS = 15 * 1000;
const OCR_DOC_CONCURRENCY = 4;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256file = (path) => sha256(readFileSync(path));
const log = (msg) => console.log(`[pdf-upgrade] ${new Date().toISOString().slice(0,19)} ${msg}`);

/** Check all other site DBs for an already-upgraded PDF with matching content hash. */
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

/** Process one queued PDF: dedup check → re-OCR → rebuild → score → MD export. */
const upgradeDocument = async (db, domain, row, allDomains = [], ocrBackend = 'boss', siteConfig = null) => {
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
    const contentHash = sha256file(page.local_path);
    const dup = findUpgradedDuplicate(contentHash, allDomains, domain);
    if (dup) {
      const hash = sha256(page.url).slice(0, 16);
      const upgradedDir = join(mirrorDir(domain), '.upgraded');
      mkdirSync(upgradedDir, { recursive: true });
      const outputPath = join(upgradedDir, `x${hash}.pdf`);
      copyFileSync(dup.upgraded_pdf_path, outputPath);
      const improvement = (dup.after_score || 0) - (row.before_score || 0);
      db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
        .run(new Date().toISOString(), outputPath, dup.after_score, improvement, dup.pages_processed, `${dup.method}+dedup`, row.url);
      try {
        const dupMetrics = await scorePdf(outputPath);
        db.prepare(`UPDATE pdf_quality SET composite_score=?, has_text_layer=?, readable_pages_pct=?, avg_chars_per_page=?, word_quality_estimate=?, excerpt=? WHERE url=?`)
          .run(dupMetrics.composite_score, dupMetrics.has_text_layer, dupMetrics.readable_pages_pct, dupMetrics.avg_chars_per_page, dupMetrics.word_quality_estimate, dupMetrics.excerpt, row.url);
      } catch {}
      log(`Dedup hit: ${row.url} → reused from another site (${contentHash.slice(0, 8)}…)`);
      if (siteConfig) {
        try {
          const { exportTextPdf } = await import('../export-doc.js');
          await exportTextPdf(db, siteConfig, { ...page, local_path: outputPath, content_hash: sha256file(outputPath) });
        } catch (e) { log(`MD export failed (dedup): ${row.url}: ${e.message}`); }
      }
      return;
    }

    db.prepare('UPDATE pdf_quality SET content_hash=? WHERE url=?').run(contentHash, row.url);
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

    let ocrResults;
    try {
      ocrResults = await reocrDocument(page.local_path, domain, contentHash, numPages, (n, total) => {
        if (n % 5 === 0 || n === total) log(`  page ${n}/${total}`);
      }, ocrBackend, db, page.url);
    } catch (err) {
      throw new Error(`reocr failed: ${err.message}`);
    }

    const hash = sha256(page.url).slice(0, 16);
    const upgradedDir = join(mirrorDir(domain), '.upgraded');
    mkdirSync(upgradedDir, { recursive: true });
    const outputPath = join(upgradedDir, `x${hash}.pdf`);
    const { success, method, error } = await rebuildPdf(page.local_path, outputPath, ocrResults, meta);
    if (!success) throw new Error(error);

    const afterMetrics = await scorePdf(outputPath);
    const improvement = afterMetrics.composite_score - row.before_score;
    db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, before_score=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
      .run(new Date().toISOString(), outputPath, row.before_score || 0, afterMetrics.composite_score, improvement, numPages, method, row.url);
    db.prepare(`UPDATE pdf_quality SET composite_score=?, has_text_layer=?, readable_pages_pct=?, avg_chars_per_page=?, word_quality_estimate=?, excerpt=? WHERE url=?`)
      .run(afterMetrics.composite_score, afterMetrics.has_text_layer, afterMetrics.readable_pages_pct, afterMetrics.avg_chars_per_page, afterMetrics.word_quality_estimate, afterMetrics.excerpt, row.url);
    log(`Done: ${row.url} score ${(row.before_score||0).toFixed(2)} → ${afterMetrics.composite_score.toFixed(2)} (+${improvement.toFixed(2)}) via ${method}`);
    if (siteConfig) {
      try {
        const { exportTextPdf } = await import('../export-doc.js');
        await exportTextPdf(db, siteConfig, { ...page, local_path: outputPath, content_hash: sha256file(outputPath) });
      } catch (e) { log(`MD export failed: ${row.url}: ${e.message}`); }
    }
  } catch (err) {
    log(`Failed: ${row.url}: ${err.message}`);
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(new Date().toISOString(), err.message, row.url);
  }
};

const tick = async () => {
  const { sites } = loadConfig();
  if (!sites.length) return;

  const openDbs = sites.map(site => ({ db: openDb(new URL(site.url).hostname), domain: new URL(site.url).hostname }));

  for (const { db, domain } of openDbs) {
    await backfillHostsFromMirror(db, domain);
    await detectLanguageForImagePdfs(db, domain);
  }

  const ocrBackend = await ocrAvailableBackend();
  if (!ocrBackend) {
    log('No OCR backend available (boss unreachable, no ANTHROPIC_API_KEY), skipping');
    for (const { db } of openDbs) { try { db.close(); } catch {} }
    return;
  }
  if (ocrBackend === 'claude') log('Boss unavailable, using Claude vision API for OCR');

  const candidates = [];
  for (const { db, domain } of openDbs) {
    const rows = db.prepare(`
      SELECT q.*, pq.composite_score as before_score
      FROM pdf_upgrade_queue q
      LEFT JOIN pdf_quality pq ON q.url = pq.url
      WHERE q.status='pending'
      ORDER BY q.priority DESC
      LIMIT ?`).all(OCR_DOC_CONCURRENCY);
    const sc = sites.find(s => new URL(s.url).hostname === domain) || null;
    for (const row of rows) candidates.push({ db, domain, row, siteConfig: sc });
  }
  candidates.sort((a, b) => (b.row.priority || 0) - (a.row.priority || 0));
  const batch = candidates.slice(0, OCR_DOC_CONCURRENCY);

  if (batch.length) {
    const now = new Date().toISOString();
    for (const { db, row } of batch) {
      db.prepare("UPDATE pdf_upgrade_queue SET status='processing', started_at=? WHERE url=?").run(now, row.url);
    }
    const allDomains = openDbs.map(o => o.domain);
    await Promise.all(batch.map(({ db, domain, row, siteConfig }) => upgradeDocument(db, domain, row, allDomains, ocrBackend, siteConfig)));
  } else {
    log('No pending items');
  }

  for (const { db } of openDbs) { try { db.close(); } catch {} }
};

const resetStuckProcessing = () => {
  try {
    const { sites } = loadConfig();
    for (const site of sites) {
      const domain = new URL(site.url).hostname;
      const db = openDb(domain);
      const n = db.prepare("UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL WHERE status='processing'").run().changes;
      if (n) log(`Reset ${n} stuck processing docs to pending`);
      try { db.close(); } catch {}
    }
  } catch {}
};
resetStuckProcessing();

log('PDF upgrade worker started');
const run = async () => { await tick(); setTimeout(run, TICK_INTERVAL_MS); };

const summarizeLoop = async () => {
  try {
    const { sites } = loadConfig();
    for (const site of sites) {
      const domain = new URL(site.url).hostname;
      const db = openDb(domain);
      await summarizeTopPending(db, domain);
      try { db.close(); } catch {}
    }
  } catch {}
  setTimeout(summarizeLoop, SUMMARIZE_INTERVAL_MS);
};

run();
setTimeout(summarizeLoop, 5000);
