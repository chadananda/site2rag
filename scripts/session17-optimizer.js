#!/usr/bin/env node
// Session 17: New language exploration — German, Turkish, English historical scans.
// Goals: find cheapest viable strategy per language; confirm Arabic regression at 0.720.
// Exports: none (standalone script). Deps: pipeline/client, db, mirror-crawl, fs
//
// Usage: ANTHROPIC_API_KEY=... PIPELINE_URL=http://localhost:49900 node scripts/session17-optimizer.js
// Results: tmp/session17-results.jsonl (per-run), tmp/session17-summary.json (aggregate)

import { PipelineClient } from '../src/pipeline/client.js';
import { openDb } from '../src/db.js';
import { urlToMirrorPath } from '../src/mirror-crawl.js';
import { existsSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 20 * 60 * 1000;
const RESULTS_JSONL = 'tmp/session17-results.jsonl';
const SUMMARY_JSON = 'tmp/session17-summary.json';

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

mkdirSync('tmp', { recursive: true });

// ─────────────────────────── variant definitions ───────────────────────────

const ARA_REGRESSION = [
  { id: 'surya_multi_haiku_ara', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', s3MultiEngine: ['surya'] } },
];

const GERMAN_VARIANTS = [
  { id: 'haiku_no_ocr',          config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  { id: 'haiku_deu',             config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'deu' } },
  { id: 'surya_multi_haiku_deu', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'deu', s3MultiEngine: ['surya'] } },
];

const TURKISH_VARIANTS = [
  { id: 'haiku_tur',             config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'tur' } },
  { id: 'surya_multi_haiku_ara', config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', s3MultiEngine: ['surya'] } },
];

const ENGLISH_VARIANTS = [
  { id: 'haiku_no_ocr', config: { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' } },
  { id: 'haiku_eng',    config: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'eng' } },
];

// ─────────────────────────── receipt analysis ──────────────────────────────

function stageChain(receipt) {
  if (!receipt?.metrics?.stages) return '(no stages)';
  return receipt.metrics.stages
    .map(s => {
      const score = s.quality_after != null ? s.quality_after.toFixed(3) : '?';
      const delta = s.quality_delta != null && s.quality_delta > 0.001
        ? `+${s.quality_delta.toFixed(3)}`
        : s.quality_delta != null && s.quality_delta < -0.001
          ? s.quality_delta.toFixed(3)
          : '';
      return `${s.stage}(${score}${delta ? ',' + delta : ''})`;
    })
    .join(' → ');
}

function keyDecisions(receipt) {
  if (!receipt?.metrics?.decisions) return [];
  return receipt.metrics.decisions
    .filter(d => ['surya_batch','lang','contrast','engine','skip'].some(k => d.key?.includes(k)))
    .map(d => `${d.key}=${d.value}`);
}

function recoverableErrors(receipt) {
  if (!receipt?.metrics?.errors) return [];
  return receipt.metrics.errors
    .filter(e => e.recoverable !== false)
    .map(e => `[${e.stage}] ${e.message?.slice(0,60)}`);
}

function weakStages(receipt) {
  if (!receipt?.metrics?.stages) return [];
  return receipt.metrics.stages
    .filter(s => s.quality_delta != null && s.quality_delta < 0.005 && !['s0','s7','s8'].includes(s.stage))
    .map(s => s.stage);
}

// ─────────────────────────── print one variant result ─────────────────────

function printDocResult(doc, variant, receipt, elapsed, error) {
  const score  = receipt?.quality?.final ?? 0;
  const cost   = receipt?.totals?.cost_usd ?? 0;
  const delta  = score - doc.baselineScore;
  const sign   = delta >= 0 ? '+' : '';
  const errList = recoverableErrors(receipt);
  const dec    = keyDecisions(receipt);
  const weak   = weakStages(receipt);

  log(`  [${variant.id}] score=${score.toFixed(3)} (${sign}${delta.toFixed(3)}) cost=$${cost.toFixed(4)} time=${elapsed}s`);
  log(`    chain: ${stageChain(receipt)}`);
  if (dec.length)   log(`    decisions: ${dec.join(', ')}`);
  if (errList.length) log(`    recoverable errors: ${errList.join(' | ')}`);
  if (weak.length)  log(`    weak stages (Δ<0.005): ${weak.join(', ')}`);
  if (error)        log(`    FATAL: ${error}`);
}

// ─────────────────────────── per-document cross-variant assessment ─────────

function assessDocument(doc, results) {
  const valid = results.filter(r => r.ok);
  if (!valid.length) { log('  ASSESSMENT: all variants failed'); return; }

  const best = valid.reduce((a, b) => a.score > b.score ? a : b);
  const delta = best.score - doc.baselineScore;
  const rating = delta >= 0.15 ? 'STRENGTH' : delta >= 0.03 ? 'NEUTRAL' : 'WEAKNESS';

  // Cost-efficiency: best quality-per-dollar
  const eff = valid
    .filter(r => r.cost > 0)
    .map(r => ({ id: r.variantId, ratio: r.score / r.cost }))
    .sort((a, b) => b.ratio - a.ratio)[0];

  log(`\n  ── ASSESSMENT ──────────────────────────────`);
  log(`  ${rating}: best=${best.variantId} score=${best.score.toFixed(3)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} from baseline=${doc.baselineScore.toFixed(3)})`);
  if (eff) log(`  cost-efficient pick: ${eff.id} (score/dollar=${eff.ratio.toFixed(1)})`);

  // Recurring error patterns across variants
  const allErrors = results.flatMap(r => (r.receipt ? recoverableErrors(r.receipt) : []));
  const stageErrors = {};
  allErrors.forEach(e => {
    const m = e.match(/^\[(\w+)\]/);
    if (m) stageErrors[m[1]] = (stageErrors[m[1]] || 0) + 1;
  });
  const recurring = Object.entries(stageErrors).filter(([,c]) => c >= 2).map(([s,c]) => `${s}(${c}x)`);
  if (recurring.length) log(`  recurring errors: ${recurring.join(', ')}`);

  // Variant ranking
  const ranked = valid.sort((a, b) => b.score - a.score)
    .map(r => `${r.variantId}=${r.score.toFixed(3)}`)
    .join(', ');
  log(`  variant ranking: ${ranked}`);
  log(`  ───────────────────────────────────────────`);
}

// ─────────────────────────── run one variant ──────────────────────────────

async function runVariant(doc, variant) {
  const t0 = Date.now();
  try {
    const jobId = await client.submitJob({
      pdfPath: doc.localPath, sourceUrl: doc.url,
      meta: { language: doc.language, title: doc.id },
      config: variant.config, importance: 5,
    });
    const job = await client.waitForJob(jobId, { timeout: JOB_TIMEOUT });
    const receipt = job.receipt
      ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt)
      : null;
    const score   = receipt?.quality?.final ?? 0;
    const cost    = receipt?.totals?.cost_usd ?? 0;
    const elapsed = Math.round((Date.now() - t0) / 1000);

    printDocResult(doc, variant, receipt, elapsed, null);

    // Persist raw result
    appendFileSync(RESULTS_JSONL, JSON.stringify({
      ts: new Date().toISOString(), category: doc.category, docId: doc.id,
      variantId: variant.id, score, cost, elapsed,
      delta: score - doc.baselineScore,
      baseline: doc.baselineScore, pages: doc.pages,
      stageChain: stageChain(receipt),
      decisions: keyDecisions(receipt),
      recoverableErrors: recoverableErrors(receipt),
    }) + '\n');

    return { ok: true, variantId: variant.id, score, cost, elapsed, receipt };
  } catch (e) {
    log(`  [${variant.id}] FAILED — ${e.message.slice(0,80)}`);
    appendFileSync(RESULTS_JSONL, JSON.stringify({
      ts: new Date().toISOString(), category: doc.category, docId: doc.id,
      variantId: variant.id, score: 0, cost: 0, elapsed: 0,
      delta: -doc.baselineScore, baseline: doc.baselineScore, pages: doc.pages,
      error: e.message.slice(0,120),
    }) + '\n');
    return { ok: false, variantId: variant.id, score: 0, cost: 0, elapsed: 0, receipt: null };
  }
}

// ─────────────────────────── run one category ─────────────────────────────

async function runCategory(name, docs, variants) {
  log(`\n${'='.repeat(60)}`);
  log(`${name}`);
  log(`docs=${docs.length}  variants=${variants.length}`);
  if (!docs.length) { log('  No docs found — skipping'); return []; }

  const categoryResults = [];

  for (const doc of docs) {
    log(`\n--- ${doc.id} (${doc.pages}pp, baseline=${doc.baselineScore.toFixed(3)}, ${doc.language}) ---`);
    const results = [];
    for (const v of variants) {
      const r = await runVariant(doc, v);
      results.push(r);
    }
    assessDocument(doc, results);
    categoryResults.push({ docId: doc.id, results });
  }

  // Category summary
  const allValid = categoryResults.flatMap(d => d.results.filter(r => r.ok));
  if (allValid.length) {
    const byVariant = {};
    allValid.forEach(r => {
      if (!byVariant[r.variantId]) byVariant[r.variantId] = [];
      byVariant[r.variantId].push(r.score);
    });
    log(`\n  ── Category summary ──`);
    Object.entries(byVariant).forEach(([vid, scores]) => {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      log(`  ${vid.padEnd(30)} avg=${avg.toFixed(3)} (n=${scores.length})`);
    });
  }

  return categoryResults;
}

// ─────────────────────────── health check ─────────────────────────────────

async function healthCheck() {
  try {
    const res = await fetch(`${PIPELINE_URL}/health`);
    const h = await res.json();
    log(`Pipeline: status=${h.status} version=${h.version} queue=${h.queue_depth}`);
    if (h.missing_required?.length) {
      log(`FATAL: missing required tools: ${h.missing_required.join(', ')}`);
      process.exit(1);
    }
    const missing = Object.entries(h.deps ?? {}).filter(([,v]) => !v.ok).map(([k]) => k);
    if (missing.length) log(`  optional tools missing: ${missing.join(', ')}`);
  } catch (e) {
    log(`FATAL: pipeline server unreachable at ${PIPELINE_URL} — ${e.message}`);
    process.exit(1);
  }
}

// ─────────────────────────── main ─────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

  log('Session 17: New language/corpus exploration');
  await healthCheck();

  const db = openDb('bahai-library.com');

  function makeDoc(url, pages, category, language, baselineScore, domain = 'bahai-library.com') {
    return {
      id: category + '_' + url.split('/').pop().replace(/[^a-z0-9]/gi, '_').slice(0, 30),
      category, url, localPath: urlToMirrorPath(domain, url),
      language, hasTextLayer: false, pages, baselineScore,
    };
  }

  // Arabic regression reference
  const araRefRows = db.prepare(
    `SELECT url, pages FROM pdf_quality WHERE ai_language='arabic' AND has_text_layer=0
     AND composite_score=1.0 AND pages BETWEEN 5 AND 7 ORDER BY pages LIMIT 2`
  ).all();
  const araRefDocs = araRefRows
    .map(r => makeDoc(r.url, r.pages, 'ara_ref', 'arabic', 0.720))
    .filter(d => existsSync(d.localPath));

  // German image PDFs
  const germanRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='german'
     AND has_text_layer=0 AND pages BETWEEN 1 AND 8 ORDER BY composite_score DESC LIMIT 4`
  ).all();
  const germanDocs = germanRows
    .map(r => makeDoc(r.url, r.pages, 'german', 'german', r.composite_score ?? 0))
    .filter(d => existsSync(d.localPath));

  // Turkish Ottoman
  const turkishRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='turkish'
     AND has_text_layer=0 AND pages BETWEEN 2 AND 10 ORDER BY composite_score DESC LIMIT 3`
  ).all();
  const turkishDocs = turkishRows
    .map(r => makeDoc(r.url, r.pages, 'turkish', 'turkish', r.composite_score ?? 0))
    .filter(d => existsSync(d.localPath));

  // English historical scans (challenging, low baseline)
  const englishRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='english'
     AND has_text_layer=0 AND composite_score < 0.5 AND pages BETWEEN 2 AND 6
     ORDER BY composite_score ASC LIMIT 3`
  ).all();
  const englishDocs = englishRows
    .map(r => makeDoc(r.url, r.pages, 'eng_scan', 'english', r.composite_score ?? 0))
    .filter(d => existsSync(d.localPath));

  // Corpus language survey
  const langSurvey = db.prepare(
    `SELECT ai_language, count(*) as n, avg(composite_score) as avg_score, avg(pages) as avg_pages
     FROM pdf_quality WHERE has_text_layer=0 AND ai_language IS NOT NULL
     GROUP BY ai_language ORDER BY n DESC`
  ).all();

  log(`Arabic regression refs=${araRefDocs.length}  German=${germanDocs.length}  Turkish=${turkishDocs.length}  English scans=${englishDocs.length}`);
  log('\nCorpus language survey (image PDFs):');
  langSurvey.forEach(r =>
    log(`  ${(r.ai_language || 'unknown').padEnd(14)} n=${String(r.n).padStart(4)}  avg_score=${r.avg_score?.toFixed(3)}  avg_pages=${r.avg_pages?.toFixed(1)}`)
  );

  const allResults = {};

  allResults.arabic = await runCategory(
    'Arabic regression (surya_multi_haiku_ara — expected ≈ 0.720)',
    araRefDocs, ARA_REGRESSION
  );
  allResults.german = await runCategory(
    'German image PDFs (cheapest viable strategy)',
    germanDocs, GERMAN_VARIANTS
  );
  allResults.turkish = await runCategory(
    'Turkish Ottoman (Arabic-script pre-1928)',
    turkishDocs, TURKISH_VARIANTS
  );
  allResults.english = await runCategory(
    'English historical scans (low-baseline challenge)',
    englishDocs, ENGLISH_VARIANTS
  );

  // Final summary
  log('\n' + '='.repeat(60));
  log('Session 17 COMPLETE');
  log(`Results written to: ${RESULTS_JSONL}`);
  log('Key questions answered:');
  log('  1. Does haiku_no_ocr or haiku_deu win for German? → see German category summary');
  log('  2. Does Arabic strategy generalize to Ottoman Turkish? → see Turkish category summary');
  log('  3. English historical: any improvement? → see English category summary');

  writeFileSync(SUMMARY_JSON, JSON.stringify({
    ts: new Date().toISOString(),
    docCounts: {
      arabic: araRefDocs.length, german: germanDocs.length,
      turkish: turkishDocs.length, english: englishDocs.length,
    },
    langSurvey,
    results: allResults,
  }, null, 2));
  log(`Summary JSON: ${SUMMARY_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
