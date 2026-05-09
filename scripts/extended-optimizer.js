#!/usr/bin/env node
// Extended optimization test — systematic coverage of combinations not yet tried.
// Covers: Arabic (Sonnet), French (Sonnet + higher DPI), English scan (synthesis),
//         image-only synthesis (skip OCR), 200 DPI synthesis.
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node extended-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 8 * 60 * 1000; // 8 min per job

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ─────────────────────────── variant definitions ───────────────────────────

// Note: All variants skip s4/s7/s8 (Marker, archival PDF, export) for speed.
// s3 + s5 haiku = fast OCR comparison + AI synthesis
// skip s3 = image-only (no Tesseract text sent to AI)

const ARABIC_VARIANTS = [
  // Best haiku variant from Session 5
  { id: 'haiku_baseline',    config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' } },
  // Skip Tesseract entirely — send clean image to AI (no OCR garbage)
  { id: 'haiku_no_ocr',      config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  // Sonnet instead of Haiku (better Arabic/Persian capability)
  { id: 'sonnet_baseline',   config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet' } },
  // Sonnet, no OCR
  { id: 'sonnet_no_ocr',     config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet' } },
  // Haiku + unpaper (best preprocessing from Session 5)
  { id: 'haiku_unpaper',     config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', preprocessing: { unpaper: true } } },
  // Sonnet + unpaper
  { id: 'sonnet_unpaper',    config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', preprocessing: { unpaper: true } } },
];

const FRENCH_VARIANTS = [
  // Session 5 best: unpaper + fra model + haiku synthesis
  { id: 'haiku_unpaper_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra', preprocessing: { unpaper: true } } },
  // Push with Sonnet synthesis
  { id: 'sonnet_fra',        config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'fra' } },
  // Sonnet + unpaper
  { id: 'sonnet_unpaper_fra',config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'fra', preprocessing: { unpaper: true } } },
  // Skip OCR, Sonnet image-only (French scan, Tesseract errors might confuse AI)
  { id: 'sonnet_no_ocr',     config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'sonnet' } },
  // High DPI + fra + Sonnet
  { id: 'sonnet_400dpi_fra', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'fra', rasterDpi: 400 } },
];

const ENGLISH_SCAN_VARIANTS = [
  // Apply Haiku synthesis on top of good OCR (95-97% baseline)
  { id: 'haiku_synthesis',   config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' } },
  // Sonnet synthesis (overkill for good docs but validates ceiling)
  { id: 'sonnet_synthesis',  config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet' } },
  // High DPI + Haiku
  { id: 'haiku_400dpi',      config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', rasterDpi: 400 } },
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
    log(`  ${variant.id}: score=${score.toFixed(3)} cost=$${cost.toFixed(4)} time=${elapsed}s${errors > 0 ? ' ERRORS=' + errors : ''}`);
    return { ok: true, score, cost, elapsed };
  } catch (e) {
    log(`  ${variant.id}: FAILED — ${e.message.slice(0,80)}`);
    return { ok: false, score: 0, cost: 0 };
  }
}

async function runCategory(docs, variants, categoryName) {
  log(`\n${'='.repeat(60)}`);
  log(`CATEGORY: ${categoryName} (${docs.length} docs, ${variants.length} variants)`);

  const results = {};
  for (const doc of docs) {
    log(`\n--- ${doc.id} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}) ---`);
    results[doc.id] = { baseline: doc.baselineScore, variants: {} };

    for (const variant of variants) {
      const r = await runVariant(doc, variant);
      results[doc.id].variants[variant.id] = r;
    }

    // Summary for this doc
    const best = Object.entries(results[doc.id].variants)
      .filter(([,r]) => r.ok)
      .sort((a, b) => b[1].score - a[1].score)[0];
    if (best) {
      const gain = best[1].score - doc.baselineScore;
      log(`  ★ BEST: ${best[0]} = ${(best[1].score * 100).toFixed(1)}% (${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(1)}% vs baseline)`);
    }
  }
  return results;
}

async function main() {
  if (!API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  const corpus = await buildCorpus({ domain: 'bahai-library.com' });
  const arabic = corpus.filter(d => d.category === 'arabic_scan');
  const french = corpus.filter(d => d.category === 'french_scan');
  const engScan = corpus.filter(d => d.category === 'english_scan_ok');

  log(`Corpus: ${arabic.length} Arabic, ${french.length} French, ${engScan.length} English scan`);
  log(`Running extended optimization. Each variant: s3 (Tesseract) + s5 (AI synthesis)`);
  log(`Synthesis DPI: 150 (within Anthropic 5MB limit)`);

  const allResults = {};

  allResults.arabic = await runCategory(arabic, ARABIC_VARIANTS, 'Arabic (handwritten manuscripts)');
  allResults.french = await runCategory(french, FRENCH_VARIANTS, 'French (historical newspaper scans)');
  allResults.english_scan = await runCategory(engScan, ENGLISH_SCAN_VARIANTS, 'English scan (good baseline 95-97%)');

  // Final summary
  log('\n' + '='.repeat(60));
  log('FINAL SUMMARY');
  log('='.repeat(60));
  for (const [cat, catResults] of Object.entries(allResults)) {
    log(`\n${cat}:`);
    for (const [docId, docResult] of Object.entries(catResults)) {
      const best = Object.entries(docResult.variants)
        .filter(([,r]) => r.ok && r.score > docResult.baseline)
        .sort((a, b) => b[1].score - a[1].score)[0];
      if (best) {
        log(`  ${docId}: +${((best[1].score - docResult.baseline) * 100).toFixed(1)}% via ${best[0]}`);
      } else {
        log(`  ${docId}: no improvement over baseline ${(docResult.baseline * 100).toFixed(1)}%`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
