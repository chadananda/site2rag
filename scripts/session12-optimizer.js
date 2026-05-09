#!/usr/bin/env node
// Session 12: Expand testing to new Arabic docs + Sonnet variance on arabic_17.
// New Arabic docs: 4 kharman Persian PDFs (8-10pp, image, composite=1.00).
// Key questions:
//   1. Sonnet variance on arabic_17 — is 0.643 reliable?
//   2. Do new Arabic docs (9-10pp) score better with haiku_ara_lang?
//   3. Does haiku_no_ocr generalize to more French pages?
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node session12-optimizer.js

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';
import { openDb } from '../../src/db.js';
import { urlToMirrorPath } from '../../src/mirror-crawl.js';
import { existsSync } from 'fs';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 12 * 60 * 1000;

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

function makeDoc(url, pages, category, language, baselineScore, domain = 'bahai-library.com') {
  return {
    id: category + '_' + url.split('/').pop().replace(/[^a-z0-9]/gi,'_').slice(0,30),
    category, url, localPath: urlToMirrorPath(domain, url),
    language, hasTextLayer: false, pages, baselineScore,
  };
}

// ─────────────────────────── variant definitions ───────────────────────────

const ARABIC_VARIANTS = [
  { id: 'haiku_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara' } },
  { id: 'sonnet_ara_lang', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
];

const ARABIC_17_VARIANTS = [
  // 3 Sonnet runs to measure variance
  { id: 'sonnet_r1', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
  { id: 'sonnet_r2', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
  { id: 'sonnet_r3', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'sonnet', s3Lang: 'ara' } },
];

const FRENCH_VARIANTS = [
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
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
    log(`\n--- ${doc.id.slice(0, 50)} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}) ---`);
    const scores = [];
    for (const v of variants) {
      const r = await runVariant(doc, v);
      if (r.ok) scores.push({ id: v.id, score: r.score, cost: r.cost });
    }
    allScores[doc.id] = scores;
    if (scores.length > 1) {
      const vals = scores.map(s => s.score);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      log(`  Stats: mean=${mean.toFixed(3)} max=${Math.max(...vals).toFixed(3)} min=${Math.min(...vals).toFixed(3)}`);
    }
  }
  return allScores;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  const corpus = await buildCorpus({ domain: 'bahai-library.com' });
  const arabic17 = corpus.filter(d => d.id.includes('_17'));
  const arabic16 = corpus.filter(d => d.id.includes('_16'));

  // Load new Arabic docs from DB
  const db = openDb('bahai-library.com');
  const newArabicRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 10 ORDER BY pages`
  ).all();
  const newArabicDocs = newArabicRows
    .map(r => makeDoc(r.url, r.pages, 'arabic_scan_new', 'arabic', 1.0))
    .filter(d => existsSync(d.localPath));

  // Load more French docs (untested pages)
  const frenchRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='french'
     AND has_text_layer=0 AND pages=1 ORDER BY composite_score DESC LIMIT 6`
  ).all();
  const frenchDocs = frenchRows
    .map(r => makeDoc(r.url, r.pages, 'french_scan_new', 'french', r.composite_score ?? 0))
    .filter(d => existsSync(d.localPath))
    .slice(0, 4);

  log('Session 12: New Arabic docs, Sonnet variance on arabic_17, French generalization');
  log(`New Arabic docs: ${newArabicDocs.length}, New French docs: ${frenchDocs.length}`);

  // Sonnet variance on Arabic 17 (confirm 0.643 is consistent)
  await runCategory(arabic17, ARABIC_17_VARIANTS, 'Arabic 17 (Sonnet variance, 3 runs)');

  // New Arabic docs — both haiku and sonnet
  await runCategory(newArabicDocs, ARABIC_VARIANTS, 'New Arabic docs (haiku_ara_lang vs sonnet)');

  // French generalization — verify haiku_no_ocr works on more French pages
  await runCategory(frenchDocs, FRENCH_VARIANTS, 'French new pages (haiku_no_ocr generalization)');

  log('\n' + '='.repeat(55));
  log('Session 12 COMPLETE');
}

main().catch(e => { console.error(e); process.exit(1); });
