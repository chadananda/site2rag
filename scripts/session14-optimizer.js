#!/usr/bin/env node
// Session 14: Lang classification audit + mixed-content Sonnet verification.
// Key questions:
//   1. Are "Arabic" kharman docs actually Persian-language? (haiku_fas vs haiku_ara_lang)
//   2. Does Sonnet improve mixed-content docs (Persian 8pp, Arabic 11pp)?
//      Prediction: Persian 8pp 0.677→0.699, Arabic 11pp 0.653→0.689 (Sonnet handles photo pages)
//   3. Do large "Arabic" docs (15-16pp) score higher with haiku_fas?
//
// Context: kharman = "Gleanings from the Threshing Floor of Literature and Art"
// This is a Persian cultural journal — "Arabic" DB classification may be wrong.
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session14-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
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

// Does haiku_fas beat haiku_ara_lang on DB-classified "Arabic" kharman docs?
const ARABIC_LANG_AUDIT = [
  { id: 'haiku_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas' } },
];

// Does Sonnet improve mixed-content docs by handling photo/English pages better?
const SONNET_MIXED = [
  { id: 'sonnet_fas', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'fas' } },
];

const SONNET_ARA = [
  { id: 'sonnet_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
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

  // "Arabic" kharman docs (small, 8-10pp) — test haiku_fas for lang audit
  const arabicSmallRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 10 ORDER BY pages`
  ).all();
  const arabicSmallDocs = arabicSmallRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_kharman', 'arabic', 1.0))
    .filter(d => existsSync(d.localPath));

  // "Arabic" large docs (15-16pp, confirmed 0.720 with ara) — test haiku_fas
  const arabicLargeRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages > 10 ORDER BY pages LIMIT 3`
  ).all();
  const arabicLargeDocs = arabicLargeRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_large', 'arabic', 1.0))
    .filter(d => existsSync(d.localPath));

  // Persian 8pp (mixed content, haiku_fas=0.677) — test Sonnet
  const persian8ppRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='persian' AND has_text_layer=0
     AND composite_score=1.0 AND pages=8 LIMIT 1`
  ).all();
  const persian8ppDocs = persian8ppRows
    .map(r => makeDoc(r.url, r.pages, 'persian_mixed', 'persian', 0.677))
    .filter(d => existsSync(d.localPath));

  // Arabic 11pp (mixed content, haiku_ara_lang=0.653) — test Sonnet
  const arabic11ppRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages=11 LIMIT 1`
  ).all();
  const arabic11ppDocs = arabic11ppRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_mixed', 'arabic', 0.653))
    .filter(d => existsSync(d.localPath));

  log('Session 14: Lang classification audit + Sonnet on mixed-content docs');
  log(`Arabic small: ${arabicSmallDocs.length}, Arabic large: ${arabicLargeDocs.length}, Persian 8pp: ${persian8ppDocs.length}, Arabic 11pp: ${arabic11ppDocs.length}`);

  // Lang audit: do "Arabic" kharman docs score better with haiku_fas?
  await runCategory(arabicSmallDocs, ARABIC_LANG_AUDIT, '"Arabic" kharman small docs with haiku_fas (lang audit)');
  await runCategory(arabicLargeDocs, ARABIC_LANG_AUDIT, '"Arabic" kharman large docs with haiku_fas (lang audit)');

  // Sonnet on mixed-content docs
  await runCategory(persian8ppDocs, SONNET_MIXED, 'Persian 8pp mixed-content (Sonnet_fas prediction: 0.699)');
  await runCategory(arabic11ppDocs, SONNET_ARA, 'Arabic 11pp mixed-content (Sonnet_ara prediction: 0.689)');

  log('\n' + '='.repeat(55));
  log('Session 14 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
