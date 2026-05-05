#!/usr/bin/env node
// Re-queue ALL PDFs through the new pipeline with score-based priority.
// Easiest (high score, text PDFs) processed first; hard (image/Arabic/CJK) last.
// Resets ALL queue entries so everything runs through the new pipeline.
import { openDb } from '../src/db.js';
import { getMirrorRoot } from '../src/config.js';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const HARD_SCRIPT = /^(ar|ara|fa|fas|per|zh|chi|ja|jpn|ko|kor)/i;

function computeImportance(score, language) {
  const isHard = HARD_SCRIPT.test(language ?? '');
  if (score == null) return 3;
  if (score < 0.20 || (isHard && score < 0.60)) return 4;
  if (score < 0.40) return 3;
  if (score < 0.70) return 2;
  return 1;
}

function computePriority(importance, score, pages) {
  const tier = (5 - importance) * 1000;
  const scoreFactor = (score ?? 0.5) * 100;
  const pageBonus = Math.min(pages ?? 0, 500) * 0.1;
  return tier + scoreFactor + pageBonus;
}

function getSiteDbs() {
  const root = getMirrorRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(d => ({ domain: d, dbPath: join(root, d, '_meta', 'site.sqlite') }))
    .filter(s => existsSync(s.dbPath));
}

function ensureColumns(db) {
  // Ensure columns exist that may not be in older DBs
  const cols = db.prepare("PRAGMA table_info(pdf_upgrade_queue)").all().map(c => c.name);
  if (!cols.includes('importance'))  db.exec("ALTER TABLE pdf_upgrade_queue ADD COLUMN importance INT DEFAULT 1");
  if (!cols.includes('receipt_json')) db.exec("ALTER TABLE pdf_upgrade_queue ADD COLUMN receipt_json TEXT");
  if (!cols.includes('priority') || typeof cols.priority === 'undefined') {
    try { db.exec("ALTER TABLE pdf_upgrade_queue ADD COLUMN priority REAL"); } catch {}
  }
}

let totalQueued = 0, totalReset = 0;

for (const { domain } of getSiteDbs()) {
  const db = openDb(domain);
  try {
    ensureColumns(db);

    const pdfs = db.prepare(`
      SELECT q.url, q.composite_score, q.ai_language, q.pages, u.status
      FROM pdf_quality q
      JOIN pages p ON q.url = p.url AND p.gone = 0
      LEFT JOIN pdf_upgrade_queue u ON q.url = u.url
      WHERE p.mime_type = 'application/pdf'
    `).all();

    const now = new Date().toISOString();
    let siteQueued = 0, siteReset = 0;

    for (const pdf of pdfs) {
      const importance = computeImportance(pdf.composite_score, pdf.ai_language);
      const priority = computePriority(importance, pdf.composite_score, pdf.pages);

      if (!pdf.status) {
        db.prepare(`INSERT OR IGNORE INTO pdf_upgrade_queue
            (url, status, priority, importance, queued_at)
          VALUES (?, 'pending', ?, ?, ?)`
        ).run(pdf.url, priority, importance, now);
        siteQueued++;
      } else {
        db.prepare(`UPDATE pdf_upgrade_queue
          SET status='pending', priority=?, importance=?,
              error=NULL, started_at=NULL, finished_at=NULL, receipt_json=NULL
          WHERE url=?`
        ).run(priority, importance, pdf.url);
        siteReset++;
      }
    }

    console.log(`${domain}: ${siteQueued} newly queued, ${siteReset} reset to pending`);
    totalQueued += siteQueued; totalReset += siteReset;
  } finally { db.close(); }
}

console.log(`\nTotal: ${totalQueued + totalReset} pending (${totalQueued} new + ${totalReset} reset)`);
