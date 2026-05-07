#!/usr/bin/env node
// Session 17: Arabic regression + French/English first pass on bahai-library.com corpus.
// Corpus reality: arabic(23), french(21, all 1pp), persian(14, all at 1.0), english(12)
// Goals: confirm Arabic 0.720 regression; test French 1-pagers; improve English low-scorers.
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
const JOB_TIMEOUT = 60 * 60 * 1000; // 60min — 20min was too short for 27pp+ docs
const RESULTS_JSONL = 'tmp/session17-results.jsonl';
const SUMMARY_JSON = 'tmp/session17-summary.json';

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

mkdirSync('tmp', { recursive: true });

// ─────────────────────────── variant definitions ───────────────────────────

// Arabic: confirmed strategy — surya batch + haiku vision + region detection
const ARA_VARIANTS = [
  { id: 'surya_multi_haiku_ara', config: { skip: ['s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', s3MultiEngine: ['surya'] } },
];

// French: include s2 region detection so vision works on blocks not full pages
const FRENCH_VARIANTS = [
  { id: 'haiku_fra',             config: { skip: ['s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra' } },
  { id: 'surya_multi_haiku_fra', config: { skip: ['s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fra', s3MultiEngine: ['surya'] } },
];

// English: include s2 region detection; compare Tesseract vs Surya
const ENGLISH_VARIANTS = [
  { id: 'haiku_eng',             config: { skip: ['s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'eng' } },
  { id: 'surya_multi_haiku_eng', config: { skip: ['s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'eng', s3MultiEngine: ['surya'] } },
];

// ─────────────────────────── receipt analysis ──────────────────────────────

// Receipt structure: stages/decisions/errors at top level; quality scores in quality.per_stage
function stageChain(receipt) {
  if (!receipt?.stages?.length) return '(no stages)';
  const perStage = receipt.quality?.per_stage ?? {};
  const stageNames = receipt.stages.map(s => s.stage);
  return receipt.stages.map((s, i) => {
    const q = perStage[s.stage];
    const prev = i === 0 ? (receipt.quality?.baseline?.composite_score ?? 0)
      : (perStage[stageNames[i - 1]] ?? 0);
    const delta = q != null ? q - prev : null;
    const qStr = q != null ? q.toFixed(3) : '?';
    const dStr = delta != null && Math.abs(delta) > 0.001
      ? (delta > 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3)) : '';
    const note = s.notes ? ` [${s.notes}]` : '';
    return `${s.stage}(${qStr}${dStr}${note})`;
  }).join(' → ');
}

function keyDecisions(receipt) {
  if (!receipt?.decisions?.length) return [];
  return receipt.decisions
    .filter(d => d.decision && !['baseline_computed'].includes(d.decision))
    .map(d => `${d.stage}:${d.decision}=${typeof d.value === 'number' ? d.value.toFixed(3) : d.value}`);
}

function recoverableErrors(receipt) {
  if (!receipt?.errors?.length) return [];
  return receipt.errors
    .filter(e => e.recoverable !== false)
    .map(e => `[${e.stage}] ${(e.error ?? e.message ?? '').slice(0, 70)}`);
}

function weakStages(receipt) {
  if (!receipt?.stages?.length) return [];
  const perStage = receipt.quality?.per_stage ?? {};
  const stageNames = receipt.stages.map(s => s.stage);
  return receipt.stages
    .filter((s, i) => {
      if (['s0','s7','s8'].includes(s.stage)) return false;
      const q = perStage[s.stage] ?? 0;
      const prev = i === 0 ? (receipt.quality?.baseline?.composite_score ?? 0)
        : (perStage[stageNames[i - 1]] ?? 0);
      return (q - prev) < 0.005;
    })
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

  // Arabic: 2 regression refs (known 0.720) + 1 low-scorer (kharman, 0.620)
  const araRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='arabic'
     AND has_text_layer=0 AND pages BETWEEN 5 AND 30 ORDER BY composite_score LIMIT 4`
  ).all();
  const araDocs = araRows
    .map(r => makeDoc(r.url, r.pages, 'arabic', 'arabic', 0))
    .filter(d => existsSync(d.localPath));

  // French: 1-pagers are all we have — test anyway, results tell us baseline for future
  const frenchRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='french'
     AND has_text_layer=0 ORDER BY pages, composite_score LIMIT 3`
  ).all();
  const frenchDocs = frenchRows
    .map(r => makeDoc(r.url, r.pages, 'french', 'french', 0))
    .filter(d => existsSync(d.localPath));

  // English: take low-scoring image PDFs, relax page constraint
  const englishRows = db.prepare(
    `SELECT url, pages, composite_score FROM pdf_quality WHERE ai_language='english'
     AND has_text_layer=0 AND pages >= 10 ORDER BY composite_score ASC LIMIT 2`
  ).all();
  const englishDocs = englishRows
    .map(r => makeDoc(r.url, r.pages, 'eng_scan', 'english', 0))
    .filter(d => existsSync(d.localPath));

  // Corpus language survey
  const langSurvey = db.prepare(
    `SELECT ai_language, count(*) as n, avg(composite_score) as avg_score, avg(pages) as avg_pages
     FROM pdf_quality WHERE has_text_layer=0 AND ai_language IS NOT NULL
     GROUP BY ai_language ORDER BY n DESC`
  ).all();

  log(`Arabic=${araDocs.length}  French=${frenchDocs.length}  English=${englishDocs.length}`);
  log('\nCorpus language survey (image PDFs):');
  langSurvey.forEach(r =>
    log(`  ${(r.ai_language || 'unknown').padEnd(14)} n=${String(r.n).padStart(4)}  avg_score=${r.avg_score?.toFixed(3)}  avg_pages=${r.avg_pages?.toFixed(1)}`)
  );

  const allResults = {};

  allResults.arabic = await runCategory(
    'Arabic image PDFs (surya_multi_haiku_ara — regression + low-scorer)',
    araDocs, ARA_VARIANTS
  );
  allResults.french = await runCategory(
    'French image PDFs (first pass — 1-pagers)',
    frenchDocs, FRENCH_VARIANTS
  );
  allResults.english = await runCategory(
    'English image scans (no-OCR vs Tesseract vs Surya)',
    englishDocs, ENGLISH_VARIANTS
  );

  // Final summary
  log('\n' + '='.repeat(60));
  log('Session 17 COMPLETE');
  log(`Results written to: ${RESULTS_JSONL}`);
  log('Key questions answered:');
  log('  1. Arabic regression holding at ~0.720? → see Arabic category summary');
  log('  2. French 1-pagers: best strategy? → see French category summary');
  log('  3. English image scans: surya vs no-OCR? → see English category summary');

  writeFileSync(SUMMARY_JSON, JSON.stringify({
    ts: new Date().toISOString(),
    docCounts: { arabic: araDocs.length, french: frenchDocs.length, english: englishDocs.length },
    langSurvey,
    results: allResults,
  }, null, 2));
  log(`Summary JSON: ${SUMMARY_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
