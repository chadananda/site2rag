// PDF upgrade queue worker -- processes one document per tick from pdf_upgrade_queue.
// Run via PM2 as a long-lived daemon; processes worst-scoring PDFs first.
import { existsSync, copyFileSync, mkdirSync } from 'fs';
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
      const displayTitle = title || (slug.length > 3 ? slug : null);
      if (!displayTitle && !row.excerpt && !row.source_url) { done++; continue; }
      let prompt = 'You are cataloging a PDF document. Based only on the metadata provided, write:\n1. One sentence describing what this document likely contains.\n2. Author: [name if determinable, otherwise Unknown]\n\n';
      if (displayTitle) prompt += `Title: ${displayTitle}\n`;
      prompt += `URL: ${row.url}\n`;
      if (row.source_url) prompt += `Found on: ${row.source_url}\n`;
      if (row.excerpt) prompt += `Text excerpt: ${row.excerpt.slice(0, 500)}\n`;
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 120,
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
    // Get page count from quality score row
    const quality = db.prepare('SELECT pages FROM pdf_quality WHERE url=?').get(row.url);
    const numPages = quality?.pages || 1;

    // Re-OCR via boss
    let ocrResults;
    try {
      ocrResults = await reocrDocument(page.local_path, domain, sha256(page.local_path), numPages, (n, total) => {
        if (n % 5 === 0 || n === total) log(`  page ${n}/${total}`);
      });
    } catch (err) {
      throw new Error(`reocr failed: ${err.message}`);
    }

    // Rebuild PDF with text layer -- store under _upgraded/ in mirror so lnker-server can serve it
    const slug = page.path_slug || page.url.replace(/[^a-z0-9]/gi, '_').slice(-60);
    const upgradedDir = join(mirrorDir(domain), '_upgraded');
    mkdirSync(upgradedDir, { recursive: true });
    const outputPath = join(upgradedDir, `${slug}.pdf`);
    const { success, method, error } = await rebuildPdf(page.local_path, outputPath, ocrResults);

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

/** Main tick -- check boss, pick next item, process, rebuild report. */
const tick = async () => {
  const { sites } = loadConfig();
  if (!sites.length) return;

  const available = await bossAvailable();
  if (!available) {
    log('Boss unavailable, skipping tick');
    return;
  }

  // Process one domain at a time -- find highest-priority pending item across all sites
  let bestRow = null, bestDomain = null, bestDb = null;
  const openDbs = [];

  for (const site of sites) {
    const domain = new URL(site.url).hostname;
    const db = openDb(domain);
    openDbs.push({ db, domain });
    const row = db.prepare(`
      SELECT q.*, pq.composite_score as before_score
      FROM pdf_upgrade_queue q
      LEFT JOIN pdf_quality pq ON q.url = pq.url
      WHERE q.status='pending'
      ORDER BY q.priority DESC
      LIMIT 1
    `).get();
    if (row && (!bestRow || row.priority > bestRow.priority)) {
      bestRow = row;
      bestDomain = domain;
      bestDb = db;
    }
  }

  if (bestRow && bestDb) {
    // Summarize top pending items before starting the long OCR job
    await summarizeTopPending(bestDb, bestDomain);
    await processOne(bestDb, bestDomain, bestRow);
  } else {
    log('No pending items');
    // Still summarize if there are unsummarized queue items
    for (const { db, domain } of openDbs) {
      await summarizeTopPending(db, domain);
    }
  }

  // Close all dbs
  for (const { db } of openDbs) { try { db.close(); } catch {} }
};

// Main loop
log('PDF upgrade worker started');
const run = async () => {
  await tick();
  setTimeout(run, TICK_INTERVAL_MS);
};
run();
