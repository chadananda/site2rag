#!/usr/bin/env node
// Session 18: Distributed OCR diagnostic — 8 short docs, one at a time.
// Answers: (1) worker load distribution, (2) optimization opportunities,
// (3) text quality, (4) pipeline improvement ideas, (5) best pipeline ever?
// Usage: PIPELINE_URL=http://tower-nas:49900 node scripts/session18-optimizer.js
// Results: tmp/session18-results.jsonl, tmp/session18-report.md

import { PipelineClient } from '../src/pipeline/client.js';
import { existsSync, appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'fs';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://tower-nas:49900';
const LOG_URL      = process.env.LOG_URL ?? 'ssh://tower-nas';  // for log fetch
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 30 * 60 * 1000;
const RESULTS_JSONL = 'tmp/session18-results.jsonl';
const REPORT_MD     = 'tmp/session18-report.md';

mkdirSync('tmp', { recursive: true });

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

// ── Test corpus ─────────────────────────────────────────────────────────────
// 8 docs: mix of Arabic/Persian TOC pages, English journals, one hybrid.
// All short (1-5 pages estimated). One at a time, no variants — full pipeline.

const DOCS = [
  // Arabic/Persian image TOCs — 1pp, small, should hit surya → jafar/boss
  { id: 'inba-v095-toc',   lang: 'arabic',  path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659038082-inba_v095-toc.pdf',   notes: '1pp Arabic TOC' },
  { id: 'inba-v073-toc',   lang: 'arabic',  path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659038119-inba_v073-toc.pdf',   notes: '1pp Arabic TOC' },
  { id: 'bab-inba-060',    lang: 'arabic',  path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1676160641-bab-inba-060_index.pdf', notes: '1pp Arabic index' },
  { id: 'bab-inba-043',    lang: 'arabic',  path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1676160645-bab-inba-043_index.pdf', notes: '1pp Arabic index' },
  // The challenging INBA v11 TOC — 3pp landscape Persian manuscript
  { id: 'inba-v011-toc',   lang: 'arabic',  path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659038283-inba_v011-toc.pdf',   notes: '3pp landscape Persian' },
  // English UK Bahá'í journals — scanned, multi-page, different OCR challenge
  { id: 'uk-journal-9',    lang: 'english', path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659032854-uk-journal-no-9.pdf',  notes: 'English journal ~5pp' },
  { id: 'uk-journal-12',   lang: 'english', path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659032793-uk-journal-no-12.pdf', notes: 'English journal ~5pp' },
  // Hybrid: monajjem web help — unknown script, small
  { id: 'monajjem-help',   lang: 'unknown', path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1770167208-monajjemwebhelp.pdf',  notes: 'Unknown script, small' },
];

// ── Receipt analysis ─────────────────────────────────────────────────────────

function stageChain(receipt) {
  if (!receipt?.stages?.length) return '(none)';
  const perStage = receipt.quality?.per_stage ?? {};
  const baseline = receipt.quality?.baseline?.composite_score ?? 0;
  return receipt.stages.map((s, i) => {
    const q = perStage[s.stage] ?? null;
    const stages = receipt.stages;
    const prev = i === 0 ? baseline : (perStage[stages[i-1].stage] ?? baseline);
    const delta = q != null ? q - prev : null;
    const dStr = delta != null && Math.abs(delta) > 0.001
      ? (delta > 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3)) : '';
    const n = s.notes ? ` [${s.notes.slice(0,40)}]` : '';
    return `${s.stage}(${q != null ? q.toFixed(3) : '?'}${dStr}${n})`;
  }).join(' → ');
}

function stageTimings(receipt) {
  if (!receipt?.stages?.length) return {};
  return Object.fromEntries(receipt.stages.map(s => [s.stage, s.duration_ms]));
}

function stageCosts(receipt) {
  if (!receipt?.stages?.length) return {};
  return Object.fromEntries(receipt.stages.map(s => [s.stage, s.cost_usd ?? 0]));
}

function totalTokens(receipt) {
  if (!receipt?.totals) return { in: 0, out: 0 };
  return { in: receipt.totals.tokens_in ?? 0, out: receipt.totals.tokens_out ?? 0 };
}

// ── Worker routing extraction (from pipeline server logs via SSH) ─────────────

async function fetchRoutingLogs(since) {
  // Returns recent [tool-runner] routing lines from pipeline-server.out.log
  const { execSync } = await import('child_process');
  try {
    const lines = execSync(
      `ssh tower-nas "grep '\\[tool-runner\\]' /tank/site2rag/logs/pipeline-server.out.log | tail -50"`,
      { timeout: 10000, encoding: 'utf8' }
    );
    return lines.trim().split('\n').filter(l => l.includes('[tool-runner]'));
  } catch { return []; }
}

// ── Run one document ─────────────────────────────────────────────────────────

async function runDoc(doc) {
  log(`\n${'─'.repeat(60)}`);
  log(`Doc: ${doc.id}  (${doc.notes})`);
  log(`Path: ${doc.path}`);

  const t0 = Date.now();
  const beforeRoutingLines = await fetchRoutingLogs();

  let jobId, job, receipt, error;
  try {
    jobId = await client.submitJob({
      pdfPath: doc.path,
      meta: { language: doc.lang },
      importance: 8,
    });
    log(`  submitted → job=${jobId}`);
    job = await client.waitForJob(jobId, { timeout: JOB_TIMEOUT });
    receipt = job.receipt
      ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt)
      : null;
  } catch (e) {
    error = e.message;
    log(`  FAILED: ${error}`);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const afterRoutingLines = await fetchRoutingLogs();

  // Diff routing lines to find new ones from this job
  const newRouting = afterRoutingLines.filter(l => !beforeRoutingLines.includes(l));

  // Extract summary
  const q = receipt?.quality ?? {};
  const baseline = q.baseline?.composite_score ?? 0;
  const final = q.final ?? 0;
  const gain = q.gain ?? (final - baseline);
  const cost = receipt?.totals?.cost_usd ?? 0;
  const pages = receipt?.page_count ?? '?';
  const lang = q.baseline?.language ?? doc.lang;
  const earlyExit = receipt?.stages?.some(s => (s.notes ?? '').includes('early_exit'));
  const timings = stageTimings(receipt);
  const costs = stageCosts(receipt);
  const tok = totalTokens(receipt);
  const errors = receipt?.metrics?.errors ?? receipt?.errors ?? [];

  // Print results
  log(`  pages=${pages} lang=${lang} baseline=${baseline.toFixed(3)} final=${final.toFixed(3)} gain=${gain >= 0 ? '+' : ''}${gain.toFixed(3)}`);
  log(`  cost=$${cost.toFixed(4)} time=${elapsed}s earlyExit=${earlyExit ?? false}`);
  log(`  chain: ${stageChain(receipt)}`);

  if (newRouting.length) {
    log(`  worker routing:`);
    newRouting.forEach(l => log(`    ${l.split(' ').slice(-1)[0]}`));
  } else {
    log(`  worker routing: (none logged — all local or early-exit)`);
  }

  const slowStages = Object.entries(timings)
    .filter(([s, ms]) => ms > 5000 && !['s7'].includes(s))
    .sort((a,b) => b[1]-a[1])
    .map(([s,ms]) => `${s}=${(ms/1000).toFixed(1)}s`);
  if (slowStages.length) log(`  slow stages: ${slowStages.join(', ')}`);

  if (errors.length) {
    log(`  errors: ${errors.slice(0,3).map(e => (e.error||e.message||String(e)).slice(0,60)).join(' | ')}`);
  }

  const result = {
    ts: new Date().toISOString(),
    id: doc.id, lang: doc.lang, notes: doc.notes,
    pages, baseline, final, gain, cost, elapsed,
    earlyExit, lang_detected: lang,
    timings, costs, tokens: tok,
    routing: newRouting,
    errors: errors.slice(0,5).map(e => String(e.error||e.message||e).slice(0,100)),
    stageChain: stageChain(receipt),
    jobId, error: error ?? null,
  };

  appendFileSync(RESULTS_JSONL, JSON.stringify(result) + '\n');
  return result;
}

// ── Final report ─────────────────────────────────────────────────────────────

function writeReport(results) {
  const ok = results.filter(r => !r.error);
  const avgGain = ok.reduce((s,r) => s + r.gain, 0) / (ok.length || 1);
  const totalCost = results.reduce((s,r) => s + r.cost, 0);
  const avgTime = ok.reduce((s,r) => s + r.elapsed, 0) / (ok.length || 1);

  // Worker routing summary
  const allRouting = results.flatMap(r => r.routing ?? []);
  const workerHits = {};
  allRouting.forEach(l => {
    const m = l.match(/routing (\w+) → (\S+)/);
    if (m) {
      const key = `${m[1]}@${m[2]}`;
      workerHits[key] = (workerHits[key] || 0) + 1;
    }
    if (l.includes('no available worker')) {
      workerHits['LOCAL_FALLBACK'] = (workerHits['LOCAL_FALLBACK'] || 0) + 1;
    }
  });

  // Quality breakdown by language
  const byLang = {};
  ok.forEach(r => {
    const l = r.lang_detected || r.lang;
    if (!byLang[l]) byLang[l] = [];
    byLang[l].push(r);
  });

  // Bottleneck stages
  const stageTimes = {};
  ok.forEach(r => Object.entries(r.timings).forEach(([s,ms]) => {
    if (!stageTimes[s]) stageTimes[s] = [];
    stageTimes[s].push(ms);
  }));
  const avgStageTimes = Object.entries(stageTimes)
    .map(([s, arr]) => [s, arr.reduce((a,b)=>a+b,0)/arr.length])
    .sort((a,b) => b[1]-a[1]);

  const lines = [
    `# Session 18: Distributed OCR Diagnostic Report`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    `- Docs tested: ${results.length} (${ok.length} ok, ${results.length - ok.length} failed)`,
    `- Avg gain: ${(avgGain*100).toFixed(1)}%  Total cost: $${totalCost.toFixed(4)}  Avg time: ${avgTime.toFixed(0)}s`,
    ``,
    `## 1. Worker Load Distribution`,
    Object.keys(workerHits).length
      ? Object.entries(workerHits).map(([k,n]) => `- ${k}: ${n} calls`).join('\n')
      : '- No worker routing logged (all docs early-exited or ran locally)',
    ``,
    `## 2. Stage Bottlenecks (avg ms)`,
    avgStageTimes.slice(0,8).map(([s,ms]) => `- ${s}: ${ms.toFixed(0)}ms avg`).join('\n'),
    ``,
    `## 3. Quality by Language`,
    Object.entries(byLang).map(([l, rs]) => {
      const g = rs.reduce((s,r)=>s+r.gain,0)/rs.length;
      const f = rs.reduce((s,r)=>s+r.final,0)/rs.length;
      return `- ${l} (n=${rs.length}): avg final=${f.toFixed(3)} avg gain=${g>=0?'+':''}${g.toFixed(3)}`;
    }).join('\n'),
    ``,
    `## 4. Per-Document Results`,
    results.map(r => [
      `### ${r.id} (${r.notes})`,
      `baseline=${r.baseline.toFixed(3)} → final=${r.final.toFixed(3)} (${r.gain>=0?'+':''}${r.gain.toFixed(3)}) cost=$${r.cost.toFixed(4)} time=${r.elapsed}s pages=${r.pages}`,
      `chain: ${r.stageChain}`,
      r.routing?.length ? `routing: ${r.routing.map(l=>l.split('[tool-runner]')[1]||l).join(' | ')}` : '',
      r.errors?.length ? `errors: ${r.errors.join(' | ')}` : '',
    ].filter(Boolean).join('\n')).join('\n\n'),
    ``,
    `## 5. Pipeline Analysis`,
    `### Optimization Opportunities`,
    `(See per-doc timings above — stages with avg >5s are candidates)`,
    ``,
    `### Is This the Best OCR Pipeline Ever Built?`,
    `Strengths:`,
    `- Multi-engine cascade: Tesseract → Surya → Boss vision → Azure/Google/Claude`,
    `- Language-adaptive: auto-detects script, routes to appropriate OCR engine`,
    `- Quality-gated early exit: cheap baseline check avoids processing good docs`,
    `- Distributed: surya routed to GPU workers; fallback to local if all busy`,
    `- Cost-controlled: cloud LLM only when local pipeline can't get clean result`,
    ``,
    `Weaknesses to investigate (from this session):`,
    `- Timeout race condition (tool-runner 5s vs /workers response time with dead nodes) — FIXED`,
    `- Worker health TTL (60s) may be too long if a node goes down mid-batch`,
    `- No feedback loop: pipeline doesn't tell the upgrader which docs need re-try with diff config`,
    `- surya on Arabic: results pending from this session`,
  ];

  writeFileSync(REPORT_MD, lines.join('\n'));
  log(`\nReport written to ${REPORT_MD}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Clear results file for fresh session
if (existsSync(RESULTS_JSONL)) {
  writeFileSync(RESULTS_JSONL, '');
  log(`Cleared ${RESULTS_JSONL}`);
}

log(`Pipeline: ${PIPELINE_URL}`);
log(`Docs: ${DOCS.length}`);

// Wait for queue to clear before starting
log(`\nChecking queue...`);
const health = await (await fetch(`${PIPELINE_URL}/health`)).json();
if (health.queue_depth > 0) {
  log(`Queue has ${health.queue_depth} jobs — waiting for it to drain...`);
  let depth = health.queue_depth;
  while (depth > 0) {
    await new Promise(r => setTimeout(r, 15000));
    const h = await (await fetch(`${PIPELINE_URL}/health`)).json();
    depth = h.queue_depth;
    log(`  queue: ${depth} remaining`);
  }
  log(`Queue clear — starting tests`);
}

const results = [];
for (const doc of DOCS) {
  const result = await runDoc(doc);
  results.push(result);
  // Brief pause between docs
  await new Promise(r => setTimeout(r, 2000));
}

writeReport(results);

log(`\n${'='.repeat(60)}`);
log(`DONE: ${results.length} docs processed`);
log(`Total cost: $${results.reduce((s,r)=>s+r.cost,0).toFixed(4)}`);
log(`Results: ${RESULTS_JSONL}`);
log(`Report:  ${REPORT_MD}`);
