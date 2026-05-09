#!/usr/bin/env node
// Session 16: Verify surya_multi_haiku universality on clean Arabic docs.
// Key question: Does surya_multi_haiku_ara consistently give 0.720 on clean Arabic docs?
// If yes → single universal strategy for all Arabic/Persian image PDFs.
//
// Also: verify score on 3 large clean Arabic docs (15-16pp) to check for regression.
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session16-optimizer.js

import { PipelineClient } from '../src/pipeline/client.js';
import { openDb } from '../src/db.js';
import { urlToMirrorPath } from '../src/mirror-crawl.js';
import { existsSync } from 'fs';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 20 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

function makeDoc(url, pages, category, language, baselineScore, domain = 'bahai-library.com') {
  return {
    id: category + '_' + url.split('/').pop().replace(/[^a-z0-9]/gi,'_').slice(0,30),
    category, url, localPath: urlToMirrorPath(domain, url),
    language, hasTextLayer: false, pages, baselineScore,
  };
}

// Universal strategy to test
const UNIVERSAL = [
  { id: 'surya_multi_haiku_ara', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', s3MultiEngine: ['surya'] } },
];

const UNIVERSAL_FAS = [
  { id: 'surya_multi_haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas', s3MultiEngine: ['surya'] } },
];

async function runVariant(doc, variant) {
  const t0 = Date.now();
  try {
    const jobId = await client.submitJob({
      pdfPath: doc.localPath, sourceUrl: doc.url,
      meta: { language: doc.language, title: doc.id },
      config: variant.config, importance: 5,
    });
    const job = await client.waitForJob(jobId, { timeout: JOB_TIMEOUT });
    const receipt = job.receipt ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt) : null;
    const score = receipt?.quality?.final ?? 0;
    const cost = receipt?.totals?.cost_usd ?? 0;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const errors = receipt?.metrics?.errors?.length ?? 0;
    const delta = score - doc.baselineScore;
    log(`  ${variant.id}: score=${score.toFixed(3)} (${delta >= 0 ? '+' : ''}${delta.toFixed(3)}) cost=$${cost.toFixed(4)} time=${elapsed}s${errors > 0 ? ' ERR=' + errors : ''}`);
    return { ok: true, score, cost, elapsed };
  } catch (e) {
    log(`  ${variant.id}: FAILED — ${e.message.slice(0,80)}`);
    return { ok: false, score: 0, cost: 0 };
  }
}

async function runCategory(docs, variants, name) {
  log(`\n${'='.repeat(55)}`);
  log(`${name} (${docs.length} docs, ${variants.length} variants)`);
  const scores = [];
  for (const doc of docs) {
    log(`\n--- ${doc.id.slice(0,50)} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}) ---`);
    for (const v of variants) {
      const r = await runVariant(doc, v);
      if (r.ok) scores.push(r.score);
    }
  }
  if (scores.length > 1) {
    const mean = scores.reduce((a, b) => a + b) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    log(`\nSummary: mean=${mean.toFixed(3)} min=${min.toFixed(3)} max=${max.toFixed(3)} n=${scores.length}`);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  const db = openDb('bahai-library.com');

  // Clean Arabic kharman docs (8-10pp, all should be 0.720 baseline)
  const arabicCleanRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 10 ORDER BY pages`
  ).all();
  const arabicCleanDocs = arabicCleanRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_clean', 'arabic', 0.720))
    .filter(d => existsSync(d.localPath));

  // Large clean Arabic docs (15-16pp)
  const arabicLargeRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages > 12 ORDER BY pages LIMIT 2`
  ).all();
  const arabicLargeDocs = arabicLargeRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_large', 'arabic', 0.720))
    .filter(d => existsSync(d.localPath));

  // Persian clean docs (5-9pp)
  const persianCleanRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='persian' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 10 ORDER BY pages`
  ).all();
  const persianCleanDocs = persianCleanRows
    .map(r => makeDoc(r.url, r.pages, 'persian_clean', 'persian', 0.709))
    .filter(d => existsSync(d.localPath));

  log('Session 16: Universal strategy verification — surya_multi_haiku on clean docs');
  log(`Arabic clean: ${arabicCleanDocs.length}, Arabic large: ${arabicLargeDocs.length}, Persian clean: ${persianCleanDocs.length}`);

  await runCategory(arabicCleanDocs, UNIVERSAL, 'Arabic clean 8-10pp (surya_multi_haiku, baseline=0.720)');
  await runCategory(arabicLargeDocs, UNIVERSAL, 'Arabic large 15-16pp (surya_multi_haiku, baseline=0.720)');
  await runCategory(persianCleanDocs, UNIVERSAL_FAS, 'Persian clean 5-9pp (surya_multi_haiku, baseline=0.709)');

  log('\n' + '='.repeat(55));
  log('Session 16 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
