#!/usr/bin/env node
// Session 9: Verify lang propagation mechanism + push Arabic past 0.614.
// Session 8 breakthrough: s3Lang='ara' propagates page._lang → Arabic prompt.
// Key questions:
//   1. Can haiku_ara_lang + contrast push past 0.614?
//   2. Does haiku_ara_lang + unpaper beat 0.614? (contrast OK, unpaper usually hurts)
//   3. Can we verify why haiku_no_ocr gives 0.414 despite meta.language='ar'?
//      → Test: haiku with forced lang via meta but no s3
//   4. Does repeated haiku_ara_lang vary? (measure score variance)
//   5. Can we push French past 0.750 ceiling with a better quality metric?
//      → Test: only 1 variant, track token count from receipt if available
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session9-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 10 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ─────────────────────────── variant definitions ───────────────────────────

// Q1-Q4: Arabic — can we push past 0.614?
// Current best: haiku_ara_lang = 0.614 (arabic_17) / 0.646 (arabic_16)
const ARABIC_FINE = [
  // Confirmed best (baseline for Session 9)
  { id: 'haiku_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  // ara_lang + contrast (contrast was neutral before with haiku_raw, maybe better now?)
  { id: 'haiku_ara_contrast', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', preprocessing: { forceContrast: true } } },
  // ara_lang + unpaper (unpaper hurts without ara_lang; does ara_lang mitigate that?)
  { id: 'haiku_ara_unpaper', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', preprocessing: { unpaper: true } } },
  // ara_lang + both preprocessing
  { id: 'haiku_ara_contrast_unpaper', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', preprocessing: { unpaper: true, forceContrast: true } } },
  // Run haiku_ara_lang twice to measure variance (scores should be similar if consistent)
  { id: 'haiku_ara_lang_v2', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  // Sonnet + ara_lang (Haiku=Sonnet for Arabic in Sessions 6-7, but that was without proper lang)
  { id: 'sonnet_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
];

// Q5: English scan — now that we know lang propagation matters, does eng_lang explicit help?
// Prior: haiku_synthesis gave 0.644 (worse than s3 baseline 0.95-0.97)
// But: what if s3 is already giving 'eng' lang? Let's verify.
// Also test: skip everything but s5 with explicit eng prompt — pure vision
const ENGLISH_SCAN_PROBE = [
  // Prior best (s3 baseline, no AI synthesis)
  { id: 'ocr_only', config: { skip: ['s2','s4','s5','s7','s8'] } },
  // Haiku synthesis (expected: worse than OCR, confirmed in Session 6)
  { id: 'haiku_eng', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'eng' } },
  // Haiku no OCR (pure vision, English prompt via meta lang)
  { id: 'haiku_vision_only', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
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

  log('Session 9: Arabic fine-tuning, lang propagation verification, English scan probe');

  const arabic  = corpus.filter(d => d.category === 'arabic_scan');
  const engScan = corpus.filter(d => d.category === 'english_scan_ok');

  await runCategory(arabic,  ARABIC_FINE,       'Arabic fine-tuning (push past 0.614)');
  await runCategory(engScan, ENGLISH_SCAN_PROBE, 'English scan (lang propagation verification)');

  log('\n' + '='.repeat(55));
  log('Session 9 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
