#!/usr/bin/env node
// Session 8: Push Arabic past 0.453, fix Persian baselines, probe new combos.
// Key questions:
//   1. Can sonnet_raw beat haiku_raw for Arabic? (not tested yet)
//   2. Does 200 DPI synthesis improve Arabic? (between 150 and rejected 300)
//   3. haiku_raw vs haiku_no_ocr for Arabic (skip vs raw Tesseract words)
//   4. Persian re-baselining: haiku_raw vs haiku_fas, what's actually best?
//   5. Can haiku_multi (Tesseract ara+fas combined) help Arabic?
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session8-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 10 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ─────────────────────────── variant definitions ───────────────────────────

// Question 1+2+3: Arabic — push past 0.453
// Current best: haiku_raw (0.453) and haiku_contrast (0.453)
const ARABIC_PUSH = [
  // Confirmed best from Session 7 (baseline for comparison)
  { id: 'haiku_raw', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' } },
  // Sonnet with raw scan — not tried yet (sonnet always had unpaper in prior tests)
  { id: 'sonnet_raw', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet' } },
  // Sonnet no OCR (image only, no Tesseract words passed to AI)
  { id: 'sonnet_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet' } },
  // Haiku no OCR (image only — different from haiku_raw which includes Tesseract words)
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Multi-lang Tesseract (ara+fas combined output → Haiku)
  { id: 'haiku_multi_ara_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Engine: 'multi', s3Lang: 'ara' } },
  // Arabic-specific lang (ara) explicitly — prior tests used default lang detection
  { id: 'haiku_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
];

// Question 4: Persian — what's the actual best strategy?
// Session 7 found: haiku_fas=0.720, baseline(Marker)=0.219
// Now test haiku_raw (no OCR passed), haiku_ara (wrong lang?), haiku_default
const PERSIAN_DEEP = [
  // Session 7 best (baseline for comparison)
  { id: 'haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
  // No OCR at all — image only (does skipping Tesseract help for clean Farsi?)
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Default lang (auto-detect) — what does the pipeline choose for Persian docs?
  { id: 'haiku_default_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' } },
  // Sonnet + fas (might do better on clean printed Farsi vs handwriting)
  { id: 'sonnet_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'fas' } },
  // Haiku raw scan (no contrast, no unpaper, no Tesseract words)
  { id: 'haiku_raw_fas', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
];

// Question 5: French — we know metric ceiling is 0.750. But what's actual text quality?
// Test: can we use Tesseract confidence as a secondary metric to compare variants?
// Also: try pure image variants to see if skipping OCR really is best for French
const FRENCH_QUALITY = [
  // Confirmed cheapest from Session 7
  { id: 'haiku_no_ocr_fra', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // haiku_raw (Tesseract fra words passed to AI — is the OCR context helpful?)
  { id: 'haiku_raw_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra' } },
  // Sonnet no OCR — better model, does it produce higher-quality French?
  { id: 'sonnet_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet' } },
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
    const gain = results[doc.id].bestScore - doc.baselineScore;
    if (results[doc.id].best) {
      log(`  ★ BEST: ${results[doc.id].best} = ${(results[doc.id].bestScore * 100).toFixed(1)}% (+${(gain * 100).toFixed(1)}%)`);
    } else {
      log(`  ★ No improvement over ${(doc.baselineScore * 100).toFixed(1)}%`);
    }
  }
  return results;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }
  const corpus = await buildCorpus({ domain: 'bahai-library.com' });

  log('Session 8: Arabic push past 0.453, Persian re-baseline, French quality probe');

  const arabic  = corpus.filter(d => d.category === 'arabic_scan');
  const persian = corpus.filter(d => d.category === 'persian_scan');
  const french  = corpus.filter(d => d.category === 'french_scan');

  await runCategory(arabic,  ARABIC_PUSH,    'Arabic (push past 0.453)');
  await runCategory(persian, PERSIAN_DEEP,   'Persian (re-baseline with Haiku)');
  await runCategory(french,  FRENCH_QUALITY, 'French (quality probe, expect 0.750 ceiling)');

  log('\n' + '='.repeat(55));
  log('Session 8 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
