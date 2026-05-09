#!/usr/bin/env node
// Session 10: Test improved Arabic prompt (explicit "always Arabic script" rule).
// Key insight from Session 9: s1 preprocessing is a stub — all preprocessing variants
// have been running identically. Prior preprocessing conclusions were noise.
//
// New Arabic prompt explicitly forbids English fallback, should reduce 0.35-scoring pages.
// Hypothesis: improved prompt → haiku_ara_lang consistently near 0.72 (fewer 0.35 pages).
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session10-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 10 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ─────────────────────────── variant definitions ───────────────────────────

// Run haiku_ara_lang 3 times to measure variance with new improved prompt.
// Also test: sonnet_ara_lang (does Sonnet benefit more from better prompt?)
// Also verify Persian haiku_fas still works (prompt change shouldn't affect fas path)
const ARABIC_PROMPT_TEST = [
  // haiku_ara_lang run 1 (new prompt)
  { id: 'haiku_ara_lang_r1', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  // haiku_ara_lang run 2 (same config — measure variance)
  { id: 'haiku_ara_lang_r2', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  // haiku_ara_lang run 3 (same config — need 3 runs for reliable mean)
  { id: 'haiku_ara_lang_r3', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  // Sonnet with ara_lang + improved prompt (does Sonnet+better_prompt > Haiku+better_prompt?)
  { id: 'sonnet_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
  // haiku no OCR + ara_lang in meta (test if improved prompt helps no-OCR path)
  // This tests if meta.language fallback now works better with the richer prompt
  { id: 'haiku_no_ocr_meta_ara', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
];

// Verify Persian haiku_fas still works (prompt for fas should be same as ara now)
const PERSIAN_VERIFY = [
  { id: 'haiku_fas_r1', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
  { id: 'haiku_fas_r2', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
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
    const perPage = receipt?.decisions?.filter(d => d.stage === 's5' && d.decision?.startsWith('page_')).map(d => d.value) ?? [];
    const errors = receipt?.metrics?.errors?.length ?? 0;
    log(`  ${variant.id}: score=${score.toFixed(3)} cost=$${cost.toFixed(4)} time=${elapsed}s pages=${JSON.stringify(perPage)}${errors > 0 ? ' ERR=' + errors : ''}`);
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
    log(`\n--- ${doc.id} (${doc.pages}pp) ---`);
    const scores = [];
    for (const v of variants) {
      const r = await runVariant(doc, v);
      if (r.ok) scores.push({ id: v.id, score: r.score });
    }
    allScores[doc.id] = scores;
    const scoreVals = scores.map(s => s.score);
    if (scoreVals.length > 0) {
      const mean = scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length;
      const max = Math.max(...scoreVals);
      const min = Math.min(...scoreVals);
      log(`  Stats: mean=${mean.toFixed(3)} max=${max.toFixed(3)} min=${min.toFixed(3)} range=${(max-min).toFixed(3)}`);
    }
  }
  return allScores;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }
  const corpus = await buildCorpus({ domain: 'bahai-library.com' });

  log('Session 10: Improved Arabic prompt test + variance measurement');

  const arabic  = corpus.filter(d => d.category === 'arabic_scan');
  const persian = corpus.filter(d => d.category === 'persian_scan');

  await runCategory(arabic,  ARABIC_PROMPT_TEST, 'Arabic (improved prompt test, 3 runs for variance)');
  await runCategory(persian, PERSIAN_VERIFY,     'Persian (verify haiku_fas still works)');

  log('\n' + '='.repeat(55));
  log('Session 10 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
