#!/usr/bin/env node
// Session 13: Persian kharman docs + haiku_no_ocr on clean Arabic + large Arabic scaling.
// Key questions:
//   1. Do Persian kharman docs score 0.720 with haiku_fas?
//   2. Can haiku_no_ocr reach 0.720 on NEW clean kharman Arabic docs? (Gap was 0.434 on old docs)
//   3. How does haiku_ara_lang scale to larger Arabic docs (11-16pp)?
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session13-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';
import { openDb } from '../../src/db.js';
import { urlToMirrorPath } from '../../src/mirror-crawl.js';
import { existsSync } from 'fs';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 15 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

function makeDoc(url, pages, category, language, baselineScore, domain = 'bahai-library.com') {
  return {
    id: category + '_' + url.split('/').pop().replace(/[^a-z0-9]/gi,'_').slice(0,30),
    category, url, localPath: urlToMirrorPath(domain, url),
    language, hasTextLayer: false, pages, baselineScore,
  };
}

// ─────────────────────────── variant definitions ───────────────────────────

const PERSIAN_VARIANTS = [
  // Best known strategy for Persian
  { id: 'haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
  // Can no-OCR (fixed fallback) match haiku_fas for clean Persian typeset?
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
];

const ARABIC_NO_OCR_VARIANTS = [
  // haiku_ara_lang confirmed 0.720 on these docs — can no_ocr match it for clean calligraphy?
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
];

const ARABIC_LARGE_VARIANTS = [
  // Scale test: does haiku_ara_lang work on 11-16pp docs? Measure cost/time.
  { id: 'haiku_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
];

// ─────────────────────────── runner ────────────────────────────────────────

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
    log(`  ${variant.id}: score=${score.toFixed(3)} cost=$${cost.toFixed(4)} time=${elapsed}s${errors > 0 ? ' ERR=' + errors : ''}`);
    return { ok: true, score, cost, elapsed };
  } catch (e) {
    log(`  ${variant.id}: FAILED — ${e.message.slice(0,80)}`);
    return { ok: false, score: 0, cost: 0 };
  }
}

async function runCategory(docs, variants, name) {
  log(`\n${'='.repeat(55)}`);
  log(`${name} (${docs.length} docs, ${variants.length} variants)`);
  const allScores = {};
  for (const doc of docs) {
    log(`\n--- ${doc.id.slice(0,50)} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}) ---`);
    const scores = [];
    for (const v of variants) {
      const r = await runVariant(doc, v);
      if (r.ok) scores.push({ id: v.id, score: r.score, cost: r.cost });
    }
    allScores[doc.id] = scores;
    if (scores.length > 1) {
      const vals = scores.map(s => s.score);
      const best = scores.reduce((a, b) => a.score > b.score ? a : b);
      log(`  ★ Best: ${best.id}=${best.score.toFixed(3)}, max=${Math.max(...vals).toFixed(3)} min=${Math.min(...vals).toFixed(3)}`);
    }
  }
  return allScores;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  const db = openDb('bahai-library.com');

  // Persian kharman docs (5-9pp, composite=1.0)
  const persianRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='persian' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 12 ORDER BY pages`
  ).all();
  const persianDocs = persianRows
    .map(r => makeDoc(r.url, r.pages, 'persian_kharman', 'persian', 1.0))
    .filter(d => existsSync(d.localPath));

  // New Arabic kharman docs (same 4 as session12) — test haiku_no_ocr only this time
  const arabicNewRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 10 ORDER BY pages`
  ).all();
  const arabicNewDocs = arabicNewRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_kharman', 'arabic', 1.0))
    .filter(d => existsSync(d.localPath));

  // Large Arabic kharman docs (11-16pp)
  const arabicLargeRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages > 10 ORDER BY pages LIMIT 3`
  ).all();
  const arabicLargeDocs = arabicLargeRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_large', 'arabic', 1.0))
    .filter(d => existsSync(d.localPath));

  log('Session 13: Persian kharman, haiku_no_ocr on clean Arabic, large Arabic scaling');
  log(`Persian: ${persianDocs.length}, New Arabic: ${arabicNewDocs.length}, Large Arabic: ${arabicLargeDocs.length}`);

  // Persian kharman — haiku_fas vs haiku_no_ocr
  await runCategory(persianDocs, PERSIAN_VARIANTS, 'Persian kharman (haiku_fas vs haiku_no_ocr)');

  // New Arabic clean docs — haiku_no_ocr only (haiku_ara_lang already confirmed 0.720)
  await runCategory(arabicNewDocs, ARABIC_NO_OCR_VARIANTS, 'Arabic kharman (haiku_no_ocr — can we drop Tesseract?)');

  // Large Arabic docs — haiku_ara_lang scaling test
  await runCategory(arabicLargeDocs, ARABIC_LARGE_VARIANTS, 'Large Arabic kharman (11-16pp scaling)');

  log('\n' + '='.repeat(55));
  log('Session 13 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
