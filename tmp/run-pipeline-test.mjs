#!/usr/bin/env node
// Deep pipeline test runner — submits 4 docs to tower-nas pipeline server, analyzes each receipt.
// Usage: node tmp/run-pipeline-test.mjs

const PIPELINE_URL = 'http://tower-nas:49900';
const POLL_MS      = 3000;
const TIMEOUT_MIN  = 20;

const DOCS = [
  { file: 'memorandum-25-august-1989-on-john-the-baptist.pdf', lang: 'en', label: 'English 2p (adib)', oldScore: 0.84 },
  { file: 'amanat_kashan_55-56.pdf',                           lang: 'fa', label: 'Persian 2p (adib)', oldScore: 0.74 },
  { file: 'vasaya_02.pdf',                                     lang: 'en', label: 'English 5p (BL)',   oldScore: 0.74 },
  { file: 'seven-valleys-zh.pdf',                              lang: 'zh', label: 'Chinese 13p (BL)',  oldScore: 0.65 },
];

const pct = n => n == null ? ' n/a  ' : (n * 100).toFixed(1).padStart(5) + '%';
const usd = n => n > 0 ? ('$' + n.toFixed(4)).padStart(8) : '  $0.0000';
const pad = (s, n) => String(s ?? '').padEnd(n);

async function post(path, body) {
  const r = await fetch(PIPELINE_URL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function get(path) {
  const r = await fetch(PIPELINE_URL + path);
  return r.json();
}

async function pollUntilDone(jobId) {
  const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await get('/jobs/' + jobId);
    if (job.status === 'done' || job.status === 'error') return job;
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error('timeout after ' + TIMEOUT_MIN + 'min');
}

function analyzeReceipt(job, doc) {
  const receipt = job.receipt ?? {};
  const quality = receipt.quality ?? {};
  const totals  = receipt.totals ?? {};
  const stages  = receipt.stages ?? [];

  const baseScore  = quality.baseline?.composite_score;
  const finalScore = quality.final;
  const delta = finalScore != null && doc.oldScore != null ? finalScore - doc.oldScore : null;

  console.log('\n' + '═'.repeat(80));
  console.log('DOC: ' + doc.label);
  console.log('─'.repeat(80));
  console.log('Quality: baseline=' + pct(baseScore) + '  final=' + pct(finalScore) + '  old=' + pct(doc.oldScore) + '  Δ=' + (delta != null ? ((delta>=0?'+':'') + (delta*100).toFixed(1) + '%') : 'n/a'));
  console.log('Cost:   ' + usd(totals.cost_usd ?? 0) + '  tokens_in=' + (totals.tokens_in ?? 0) + '  tokens_out=' + (totals.tokens_out ?? 0));
  console.log('Words:  ' + (totals.words_total ?? '?') + '   pages=' + (receipt.page_count ?? '?'));

  console.log('\n  Stages:');
  for (const s of stages) {
    const note = s.notes && s.notes !== 'null' ? '  → ' + s.notes : '';
    const ms   = s.duration_ms ? '(' + (s.duration_ms/1000).toFixed(1) + 's)' : '';
    const cost = s.cost_usd > 0 ? usd(s.cost_usd) : '';
    console.log('    ' + pad(s.stage, 4) + ' ' + pad(s.status, 8) + ' ' + ms.padEnd(10) + cost + note);
  }

  const errors = receipt.errors ?? [];
  if (errors.length) {
    console.log('\n  Errors (' + errors.length + '):');
    for (const e of errors) {
      console.log('    [' + e.stage + '] ' + (e.recoverable ? 'WARN' : 'ERROR') + ': ' + (e.message ?? '').slice(0, 120));
    }
  }

  const suggestions = (receipt.suggestions ?? []).filter(s => s.priority !== 'low');
  if (suggestions.length) {
    console.log('\n  Suggestions:');
    for (const sg of suggestions) {
      console.log('    [' + sg.priority + '] ' + sg.category + ': ' + sg.suggestion);
    }
  }

  return { baseScore, finalScore, delta, cost: totals.cost_usd ?? 0, errors };
}

async function checkWorkers() {
  console.log('=== Worker Roster ===');
  const data = await get('/workers');
  const workers = data.workers ?? [];
  let anyBad = false;
  for (const w of workers) {
    const h = w.health ?? {};
    const avail = h.available;
    const engines = Object.entries(h.tools ?? {})
      .filter(([k,v]) => v && ['py:easyocr','py:paddleocr','py:doctr','py:kraken','surya_ocr'].includes(k))
      .map(([k]) => k.replace('py:',''));
    const gpu = Object.entries(h.tools ?? {}).filter(([k,v]) => v && k.startsWith('gpu:')).map(([k]) => k);
    const status = avail === true ? '✅' : avail === false ? '❌' : '⚪';
    console.log('  ' + status + ' ' + pad(h.hostname ?? w.hostname, 28) + ' cores=' + pad(h.cpu_cores ?? '?', 3) + ' engines=[' + engines.join(',') + '] gpu=[' + (gpu.join(',') || 'none') + ']');
    if (avail === false) anyBad = true;
  }
  return { workers, anyBad };
}

const healthData = await get('/health');
if (healthData.status !== 'ok') {
  console.error('Pipeline server unhealthy: missing=' + JSON.stringify(healthData.missing_required));
  process.exit(1);
}
console.log('Pipeline server: ' + healthData.status + ' ✅');
console.log();

const { workers, anyBad } = await checkWorkers();
if (anyBad) console.warn('\n⚠  Some workers unavailable (high load). Proceeding.\n');

const results = [];

for (const doc of DOCS) {
  const pdfPath = '/tank/site2rag/tmp/test-pdfs/' + doc.file;
  console.log('\n▶ Submitting: ' + doc.label + ' ...');

  const sub = await post('/jobs', {
    pdfPath,
    sourceUrl: 'https://test/' + doc.file,
    meta: { language: doc.lang },
    importance: 3,
    config: { skip: ['s7'] },
  });

  if (!sub.jobId) {
    console.error('  FAILED to submit: ' + sub.error);
    results.push({ doc, error: sub.error });
    continue;
  }

  console.log('  jobId=' + sub.jobId);
  process.stdout.write('  Waiting');

  let job;
  try {
    job = await pollUntilDone(sub.jobId);
  } catch (e) {
    console.log(' TIMEOUT');
    results.push({ doc, error: e.message });
    continue;
  }

  console.log(' ' + job.status.toUpperCase());

  if (job.status === 'error') {
    console.error('  ERROR: ' + job.error);
    results.push({ doc, error: job.error });
    continue;
  }

  const analysis = analyzeReceipt(job, doc);
  results.push({ doc, ...analysis });
}

console.log('\n' + '═'.repeat(80));
console.log('SUMMARY');
console.log('─'.repeat(80));
console.log(pad('Document', 28) + pad('Base', 7) + pad('Final', 7) + pad('Old', 7) + pad('Delta', 8) + pad('Cost', 9) + 'Errors');
console.log('─'.repeat(80));
for (const r of results) {
  if (r.error) { console.log(pad(r.doc.label, 28) + 'ERROR: ' + (r.error ?? '').slice(0, 40)); continue; }
  const delta = r.delta != null ? ((r.delta>=0?'+':'') + (r.delta*100).toFixed(1) + '%') : 'n/a';
  console.log(pad(r.doc.label, 28) + pad(pct(r.baseScore), 7) + pad(pct(r.finalScore), 7) + pad(pct(r.doc.oldScore), 7) + pad(delta, 8) + pad(usd(r.cost), 9) + (r.errors?.length ? ' ⚠' + r.errors.length : ''));
}
const totalCost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
console.log('─'.repeat(80));
console.log('Total cost: ' + usd(totalCost));
console.log('\nBase=s0 baseline, Final=after pipeline, Old=previous OCRmyPDF score, Δ=Final-Old\n');
