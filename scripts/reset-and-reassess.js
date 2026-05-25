#!/usr/bin/env node
// Reset and reassess PDFs for a single site domain.
// Clears: upgrade queue, quality scores, PDF export records, upgraded PDF files.
// Then re-extracts text + re-scores all downloaded PDFs. Does NOT queue for upgrade.
// Usage: node scripts/reset-and-reassess.js <domain>

import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { openDb } from '../src/db.js';
import { getMirrorRoot, mdDir } from '../src/config.js';
import { scorePdf, saveQualityScore, wordQuality } from '../src/pdf-upgrade/score.js';
import { exportTextPdf, buildFrontmatter } from '../src/export-doc.js';
import { upsertExport } from '../src/db.js';
import { createHash } from 'crypto';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const domain = process.argv[2];
if (!domain) { console.error('Usage: node scripts/reset-and-reassess.js <domain>'); process.exit(1); }

const mirrorRoot = getMirrorRoot();
const metaDir = join(mirrorRoot, domain, '_meta');
const dbPath = join(metaDir, 'site.sqlite');
if (!existsSync(dbPath)) { console.error(`No DB found at ${dbPath}`); process.exit(1); }

const db = openDb(domain);

console.log(`\n=== Reset & Reassess: ${domain} ===\n`);

// 1. Delete upgraded PDF files
const reocrDir = join(metaDir, 'reocr');
if (existsSync(reocrDir)) {
  const files = readdirSync(reocrDir);
  console.log(`Deleting ${files.length} upgraded PDF files from ${reocrDir}...`);
  for (const f of files) rmSync(join(reocrDir, f));
}

// 2. Clear upgrade queue and quality scores
const queueCount = db.prepare('SELECT COUNT(*) as n FROM pdf_upgrade_queue').get().n;
console.log(`Clearing ${queueCount} upgrade queue entries...`);
db.prepare('DELETE FROM pdf_upgrade_queue').run();

const qualCount = db.prepare('SELECT COUNT(*) as n FROM pdf_quality').get().n;
console.log(`Clearing ${qualCount} quality score records...`);
db.prepare('DELETE FROM pdf_quality').run();

// 3. Clear PDF export records (keep HTML exports)
const expCount = db.prepare("SELECT COUNT(*) as n FROM exports WHERE url IN (SELECT url FROM pages WHERE mime_type='application/pdf')").get().n;
console.log(`Clearing ${expCount} PDF export records...`);
db.prepare("DELETE FROM exports WHERE url IN (SELECT url FROM pages WHERE mime_type='application/pdf')").run();

// 4. Re-score and re-export all PDFs
const pdfPages = db.prepare("SELECT * FROM pages WHERE gone=0 AND mime_type='application/pdf' AND local_path IS NOT NULL").all();
console.log(`\nRe-assessing ${pdfPages.length} PDFs...\n`);

const stats = { scored: 0, exported: 0, stub: 0, failed: 0 };
const TIMEOUT_MS = 30_000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

// Minimal siteConfig for exportTextPdf
const siteConfig = { domain, ocr: { min_text_chars_per_page: 50 }, document: { backlink_format: 'both', backlink_granularity: 'paragraph' } };

for (let i = 0; i < pdfPages.length; i++) {
  const page = pdfPages[i];
  process.stdout.write(`[${i + 1}/${pdfPages.length}] ${basename(page.url)} ... `);

  if (!existsSync(page.local_path)) {
    console.log('missing file, skip');
    stats.failed++;
    continue;
  }

  try {
    // Score
    const metrics = await withTimeout(scorePdf(page.local_path), TIMEOUT_MS).catch(() => null);
    if (metrics) {
      saveQualityScore(db, page.url, page.content_hash, metrics);
      stats.scored++;
    }

    // Export text — writes MD with whatever text is available, flags low quality
    const wrote = await exportTextPdf(db, siteConfig, page);
    if (wrote) {
      stats.exported++;
      const wq = metrics?.word_quality_estimate ?? '?';
      const composite = metrics?.composite_score ?? '?';
      const hasText = metrics?.has_text_layer ?? '?';
      const method = db.prepare('SELECT conversion_method FROM exports WHERE url=?').get(page.url)?.conversion_method;
      console.log(`${method} | wq=${wq} composite=${composite} hasText=${hasText}`);
    } else {
      // Truly unparseable (image PDF, no text layer at all) — write stub
      const outDir = mdDir(domain);
      mkdirSync(outDir, { recursive: true });
      const mdPath = join(outDir, `${page.path_slug}.md`);
      const stub = buildFrontmatter({
        source_url: page.url, domain,
        title: page.url.split('/').pop().replace(/\.\w+$/, ''),
        fetched_at: page.last_seen_at, content_hash: page.content_hash,
        mime_type: page.mime_type, mirror_path: page.local_path,
        url_path: new URL(page.url).pathname, page_role: 'document',
        ocr_used: false, upgrade_pending: true,
        composite_score: metrics?.composite_score ?? null,
        word_quality_estimate: metrics?.word_quality_estimate ?? null,
      });
      writeFileSync(mdPath, stub, 'utf8');
      upsertExport(db, {
        url: page.url, md_path: mdPath, source_hash: page.content_hash,
        md_hash: `sha256:${sha256(Buffer.from(stub))}`, exported_at: new Date().toISOString(),
        conversion_method: 'stub', word_count: 0,
        ocr_used: 0, ocr_engines: null, reconciler: null, pages: metrics?.pages ?? null,
        agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'ok', error: null
      });
      stats.stub++;
      console.log(`stub (image-only PDF) | composite=${metrics?.composite_score ?? '?'}`);
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    stats.failed++;
  }
}

console.log(`\n=== Done ===`);
console.log(`Scored: ${stats.scored} | Exported: ${stats.exported} | Stub: ${stats.stub} | Failed: ${stats.failed}`);
console.log(`\nConversion method breakdown:`);
const methods = db.prepare("SELECT conversion_method, COUNT(*) as n FROM exports WHERE url IN (SELECT url FROM pages WHERE mime_type='application/pdf') GROUP BY conversion_method ORDER BY n DESC").all();
for (const m of methods) console.log(`  ${m.conversion_method || 'null'}: ${m.n}`);

console.log(`\nQuality score distribution:`);
const dist = db.prepare(`
  SELECT
    SUM(CASE WHEN composite_score >= 0.8 THEN 1 ELSE 0 END) as high,
    SUM(CASE WHEN composite_score >= 0.6 AND composite_score < 0.8 THEN 1 ELSE 0 END) as medium,
    SUM(CASE WHEN composite_score < 0.6 THEN 1 ELSE 0 END) as low,
    SUM(CASE WHEN has_text_layer=1 AND word_quality_estimate >= 0.8 THEN 1 ELSE 0 END) as perfect_text,
    SUM(CASE WHEN has_text_layer=1 AND word_quality_estimate < 0.8 THEN 1 ELSE 0 END) as garbage_text,
    SUM(CASE WHEN has_text_layer=0 THEN 1 ELSE 0 END) as image_pdf
  FROM pdf_quality
`).get();
console.log(`  High quality (>=0.8): ${dist.high}`);
console.log(`  Medium (0.6-0.8):     ${dist.medium}`);
console.log(`  Low (<0.6):           ${dist.low}`);
console.log(`  Text layer, clean:    ${dist.perfect_text}`);
console.log(`  Text layer, garbage:  ${dist.garbage_text}`);
console.log(`  Image PDF (no text):  ${dist.image_pdf}`);

db.close();
