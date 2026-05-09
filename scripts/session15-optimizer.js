#!/usr/bin/env node
// Session 15: Multi-engine Surya-only on mixed-content docs + new doc categories.
// Key questions:
//   1. Does Surya-only multi-engine improve mixed-content docs cheaply?
//      - Arabic 11pp: haiku=0.653, sonnet=0.720. Can surya_multi_haiku beat 0.653?
//      - Persian 8pp: haiku=0.677, sonnet=0.699. Can surya_multi_haiku beat 0.677?
//   2. Can we find new document categories to optimize (German, Spanish, English scans)?
//   3. Does surya help Latin-script docs (French, English scans) via ensemble agreement?
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session15-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { openDb } from '../../src/db.js';
import { urlToMirrorPath } from '../../src/mirror-crawl.js';
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

// ─────────────────────────── variant definitions ───────────────────────────

// Surya-only multi-engine + Haiku — faster than EasyOCR+Surya, tests if Surya helps
const SURYA_MULTI_HAIKU_ARA = [
  { id: 'surya_multi_haiku_ara', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', s3MultiEngine: ['surya'] } },
];

const SURYA_MULTI_HAIKU_FAS = [
  { id: 'surya_multi_haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas', s3MultiEngine: ['surya'] } },
];

// German: first test — haiku_no_ocr vs haiku_deu_lang
const GERMAN_VARIANTS = [
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  { id: 'haiku_deu', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'deu' } },
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
    const s3ms = Math.round((receipt?.stages?.s3?.duration_ms ?? 0) / 1000);
    log(`  ${variant.id}: score=${score.toFixed(3)} cost=$${cost.toFixed(4)} time=${elapsed}s s3=${s3ms}s${errors > 0 ? ' ERR=' + errors : ''}`);
    return { ok: true, score, cost, elapsed };
  } catch (e) {
    log(`  ${variant.id}: FAILED — ${e.message.slice(0,80)}`);
    return { ok: false, score: 0, cost: 0 };
  }
}

async function runCategory(docs, variants, name) {
  log(`\n${'='.repeat(55)}`);
  log(`${name} (${docs.length} docs, ${variants.length} variants)`);
  for (const doc of docs) {
    log(`\n--- ${doc.id.slice(0,50)} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}) ---`);
    for (const v of variants) {
      await runVariant(doc, v);
    }
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  const db = openDb('bahai-library.com');

  // Arabic 11pp mixed-content (haiku=0.653, sonnet=0.720)
  const arabic11ppRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages=11 LIMIT 1`
  ).all();
  const arabic11ppDocs = arabic11ppRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_mixed', 'arabic', 0.653))
    .filter(d => existsSync(d.localPath));

  // Persian 8pp mixed-content (haiku=0.677, sonnet=0.699)
  const persian8ppRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='persian' AND has_text_layer=0
     AND composite_score=1.0 AND pages=8 LIMIT 1`
  ).all();
  const persian8ppDocs = persian8ppRows
    .map(r => makeDoc(r.url, r.pages, 'persian_mixed', 'persian', 0.677))
    .filter(d => existsSync(d.localPath));

  // German image PDFs (first exploration)
  const germanRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='german'
     AND has_text_layer=0 AND pages BETWEEN 1 AND 5 ORDER BY composite_score DESC LIMIT 2`
  ).all();
  const germanDocs = germanRows
    .map(r => makeDoc(r.url, r.pages, 'german_scan', 'german', r.composite_score ?? 0))
    .filter(d => existsSync(d.localPath));

  log('Session 15: Surya-only multi-engine on mixed content + German exploration');
  log(`Arabic 11pp: ${arabic11ppDocs.length}, Persian 8pp: ${persian8ppDocs.length}, German: ${germanDocs.length}`);

  // Surya multi-engine on mixed-content Arabic 11pp
  await runCategory(arabic11ppDocs, SURYA_MULTI_HAIKU_ARA, 'Arabic 11pp mixed (surya_multi_haiku vs baseline 0.653)');

  // Surya multi-engine on mixed-content Persian 8pp
  await runCategory(persian8ppDocs, SURYA_MULTI_HAIKU_FAS, 'Persian 8pp mixed (surya_multi_haiku vs baseline 0.677)');

  // German: first exploration
  if (germanDocs.length > 0) {
    await runCategory(germanDocs, GERMAN_VARIANTS, 'German scan (first exploration)');
  } else {
    log('No German image PDFs found in DB');
  }

  log('\n' + '='.repeat(55));
  log('Session 15 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
