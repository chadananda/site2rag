#!/usr/bin/env node
// Session 7: Push past quality metric ceilings + explore untested combinations.
// Key questions:
//   1. Can we push French past 75% with better synthesis approach?
//   2. Is EasyOCR better than Tesseract for Arabic?
//   3. Does Sonnet with no OCR prompt produce better Arabic text?
//   4. Does 200 DPI vs 150 DPI matter for synthesis quality?
//   5. Can Persian/Farsi printed text be improved?
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session7-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 10 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ─────────────────────────── variant definitions ───────────────────────────

// Question 1: French — can we do better than 0.750 with different approaches?
// The 0.750 ceiling is the word-count metric. Try approaches that produce MORE words
// or higher-confidence output.
const FRENCH_DEEP = [
  // Our proven best (baseline for comparison)
  { id: 'haiku_unpaper_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra', preprocessing: { unpaper: true } } },
  // Multi-engine: fra + eng combined (both produce output, AI picks best)
  { id: 'haiku_multi_fra_eng', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Engine: 'multi', s3Lang: 'fra', preprocessing: { unpaper: true } } },
  // Higher DPI Haiku + fra (200 DPI synthesis vs current 150 DPI)
  // Note: 200 DPI at 150 DPI synthesis still uses 150 DPI — but 300 DPI Tesseract gives more words
  { id: 'haiku_400dpi_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra', rasterDpi: 400, preprocessing: { unpaper: true } } },
  // Skip Tesseract entirely — send 300 DPI image to Haiku with explicit French prompt
  { id: 'haiku_no_ocr_fra', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Contrast + unpaper + fra
  { id: 'haiku_contrast_unpaper_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra', preprocessing: { unpaper: true, forceContrast: true } } },
];

// Question 2: Arabic — does higher quality image (200 DPI vs 150 DPI for synthesis) help?
// Also test: what happens with a very different prompt approach?
const ARABIC_DEEP = [
  // Our proven best (baseline)
  { id: 'haiku_unpaper', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', preprocessing: { unpaper: true } } },
  // Try: Skip ALL preprocessing, raw scan → Haiku
  { id: 'haiku_raw', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' } },
  // Sonnet with no OCR (image only, no Tesseract garbage)
  { id: 'sonnet_no_ocr_unpaper', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet', preprocessing: { unpaper: true } } },
  // Test with contrast enhancement (different from unpaper)
  { id: 'haiku_contrast', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', preprocessing: { forceContrast: true } } },
  // Haiku + contrast + unpaper (most aggressive preprocessing)
  { id: 'haiku_contrast_unpaper', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', preprocessing: { unpaper: true, forceContrast: true } } },
];

// Question 3: Persian (100% baseline) — can we verify this is actually right?
// Also try English text PDFs with different spellfix configs
const PERSIAN_VERIFY = [
  // Verify the 100% claim
  { id: 'baseline', config: { skip: ['s2','s4','s7','s8'] } },
  // With Haiku synthesis (should it help?)
  { id: 'haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
];

// Question 4: English text PDFs — can s6 spellfix improve them beyond 83-85%?
const ENGLISH_TEXT = [
  // Baseline (text PDF, s0 should auto-skip OCR)
  { id: 'baseline', config: {} },
  // Force run OCR anyway (override s0 early exit) + spellfix
  { id: 'force_s3_spellfix', config: { skip: ['s2','s4','s5','s7','s8'] } },
  // Haiku synthesis on top (even for text PDFs)
  { id: 'haiku_synthesis', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' } },
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

  log('Session 7: Deep optimization and gap coverage');
  log(`Corpus loaded: ${corpus.map(d => d.category).join(', ')}`);

  const french  = corpus.filter(d => d.category === 'french_scan');
  const arabic  = corpus.filter(d => d.category === 'arabic_scan');
  const persian = corpus.filter(d => d.category === 'persian_scan');
  const engText = corpus.filter(d => d.category === 'english_text_good');

  await runCategory(french,  FRENCH_DEEP,    'French deep (push past 75%)');
  await runCategory(arabic,  ARABIC_DEEP,    'Arabic deep (alternative approaches)');
  await runCategory(persian, PERSIAN_VERIFY, 'Persian verify (is 100% real?)');
  await runCategory(engText, ENGLISH_TEXT,   'English text PDF (spellfix potential)');

  log('\n' + '='.repeat(55));
  log('Session 7 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
