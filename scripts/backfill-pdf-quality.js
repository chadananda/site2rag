#!/usr/bin/env node
// One-shot: rescore upgraded PDFs where pdf_quality.composite_score is stale (< 50% of after_score).
import Database from 'better-sqlite3';
import { existsSync } from 'fs';

const DB = process.argv[2];
if (!DB) { console.error('Usage: node backfill-pdf-quality.js <path-to-site.sqlite>'); process.exit(1); }

const db = new Database(DB);
const stale = db.prepare(`
  SELECT q.url, u.after_score, u.upgraded_pdf_path
  FROM pdf_quality q JOIN pdf_upgrade_queue u ON q.url=u.url
  WHERE u.status='done' AND q.composite_score < u.after_score * 0.5
`).all();

if (!stale.length) { console.log('Nothing to backfill.'); process.exit(0); }
console.log(`Backfilling ${stale.length} rows...`);

for (const row of stale) {
  if (!row.upgraded_pdf_path || !existsSync(row.upgraded_pdf_path)) {
    console.log(`  SKIP (no file): ${row.url}`);
    continue;
  }
  // Set has_text_layer=1, composite_score=after_score, readable_pages_pct=1.0 (OCR covers all pages)
  db.prepare(`UPDATE pdf_quality SET has_text_layer=1, composite_score=?, readable_pages_pct=1.0, word_quality_estimate=? WHERE url=?`)
    .run(row.after_score, row.after_score, row.url);
  console.log(`  Updated: ${row.url.split('/').pop()} → ${(row.after_score*100).toFixed(0)}%`);
}
console.log('Done.');
