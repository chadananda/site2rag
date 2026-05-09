#!/usr/bin/env node
// Session 11: Verify meta.language fallback fix + find cheapest strategies.
// Two bugs fixed before this session:
//   1. Improved Arabic prompt (explicit "always Arabic script" rule)
//   2. Fixed fallback lang: now handles 'arabic'/'persian'/'french' (full names)
//
// Key questions:
//   1. Does haiku_no_ocr now work for Arabic with fixed fallback? (expected ~0.60)
//   2. Does haiku_no_ocr work for Persian with fixed fallback? (expected ~0.70)
//   3. Does haiku_no_ocr work for French with fixed fallback? (expected 0.750)
//   4. Can haiku_no_ocr match haiku_ara_lang cheapness + quality?
//   5. Can Sonnet_no_ocr for Arabic achieve 0.720 (like sonnet_ara_lang on arabic_16)?
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session11-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 10 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ─────────────────────────── variant definitions ───────────────────────────

// Test the fixed fallback + improved prompt for all language categories
// All of these skip s3 (no OCR) — now the meta.language fallback should work
const NO_OCR_FIXED = [
  // Arabic: skip s3, rely on meta.language='arabic' → fallback 'ara' → Arabic prompt
  { id: 'haiku_no_ocr_arabic', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' }, lang: 'arabic_scan' },
  // Same but Sonnet (can it achieve 0.720 without even running Tesseract?)
  { id: 'sonnet_no_ocr_arabic', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet' }, lang: 'arabic_scan' },
];

const ARABIC_VARIANTS = [
  // Fixed no-OCR path (should now work like haiku_ara_lang but cheaper — no Tesseract)
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Best prior approach for comparison
  { id: 'haiku_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  // Sonnet no OCR (cheapest path to high quality?)
  { id: 'sonnet_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet' } },
];

const PERSIAN_VARIANTS = [
  // Fixed no-OCR for Persian (should now use 'fas' prompt without running Tesseract)
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Best prior approach
  { id: 'haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
];

const FRENCH_VARIANTS = [
  // Fixed no-OCR for French (should now use 'fra' prompt)
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Best prior approach
  { id: 'haiku_no_ocr_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra' } },
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
  const results = {};
  for (const doc of docs) {
    log(`\n--- ${doc.id} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}) ---`);
    results[doc.id] = { baseline: doc.baselineScore, best: null, bestScore: doc.baselineScore };
    for (const v of variants) {
      const r = await runVariant(doc, v);
      if (r.ok && r.score > results[doc.id].bestScore) {
        results[doc.id].bestScore = r.score;
        results[doc.id].best = v.id;
      }
    }
    const best = results[doc.id];
    if (best.best) {
      log(`  ★ BEST: ${best.best} = ${(best.bestScore * 100).toFixed(1)}%`);
    } else {
      log(`  ★ No improvement over baseline`);
    }
  }
  return results;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }
  const corpus = await buildCorpus({ domain: 'bahai-library.com' });

  log('Session 11: Fixed fallback lang verification — no-OCR should now work for all languages');

  const arabic  = corpus.filter(d => d.category === 'arabic_scan');
  const persian = corpus.filter(d => d.category === 'persian_scan');
  const french  = corpus.filter(d => d.category === 'french_scan');

  await runCategory(arabic,  ARABIC_VARIANTS,  'Arabic (no-OCR fixed, compare to haiku_ara_lang)');
  await runCategory(persian, PERSIAN_VARIANTS,  'Persian (no-OCR fixed, compare to haiku_fas)');
  await runCategory(french,  FRENCH_VARIANTS,   'French (no-OCR fixed, compare to haiku_no_ocr_fra)');

  log('\n' + '='.repeat(55));
  log('Session 11 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
