#!/usr/bin/env node
// Session 19b: Retest uk-journal-12 (English) after s5 visionQualityGate fix.
// Before: s4/s5 skipped entirely (Tesseract 0.697 was "good enough")
// After: s5 now runs on all pages below 0.90 quality

import { PipelineClient } from '../src/pipeline/client.js';
import { execSync } from 'child_process';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://tower-nas:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

const doc = {
  id: 'uk-journal-12',
  path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659032793-uk-journal-no-12.pdf',
  notes: 'English journal ~4pp — before: 0.697→0.800 (Tesseract only); expect s5 vision now'
};

log(`Testing: ${doc.id} — ${doc.notes}`);

// Remove old archival so we get a fresh run
const mdPath = doc.path.replace('.pdf', '_archival.md');
try { execSync(`ssh tower-nas "rm -f '${mdPath}'"`, { timeout: 5000 }); } catch {}

async function fetchRouting() {
  try {
    return execSync(`ssh tower-nas "grep '\\[tool-runner\\]' /tank/site2rag/logs/pipeline-server.out.log | tail -20"`,
      { timeout: 10000, encoding: 'utf8' }).trim().split('\n');
  } catch { return []; }
}

const before = await fetchRouting();
const t0 = Date.now();

let job, receipt, error;
try {
  const jobId = await client.submitJob({ pdfPath: doc.path, meta: { language: 'english' }, importance: 8 });
  log(`  submitted → ${jobId}`);
  job = await client.waitForJob(jobId, { timeout: 20 * 60 * 1000 });
  receipt = job.receipt ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt) : null;
} catch (e) { error = e.message; log(`  FAILED: ${error}`); }

const elapsed = Math.round((Date.now() - t0) / 1000);
const after = await fetchRouting();
const newRouting = after.filter(l => !before.includes(l));

const q = receipt?.quality ?? {};
const stageMap = Object.fromEntries((receipt?.stages ?? []).map(s => [s.stage, s]));

log(`  time=${elapsed}s baseline=${(q.baseline?.composite_score ?? 0).toFixed(3)} final=${(q.final ?? 0).toFixed(3)} gain=${(q.gain ?? 0).toFixed(3)}`);

const chain = (receipt?.stages ?? []).map(s => {
  const score = q.per_stage?.[s.stage];
  return `${s.stage}(${score != null ? score.toFixed(3) : '?'}, ${Math.round(s.duration_ms/1000)}s)`;
}).join(' → ');
log(`  chain: ${chain}`);

const routing = newRouting.filter(l => l.includes('[tool-runner]')).map(l => l.split('[tool-runner]')[1]?.trim());
log(`  routing: ${routing.join(' | ') || '(none — local only)'}`);

// Show s5 decisions
const s5 = stageMap['s5'];
log(`  s5: ${s5 ? `${Math.round(s5.duration_ms/1000)}s, decisions: ${JSON.stringify(s5.decisions ?? []).slice(0,200)}` : 'NOT RUN'}`);

// Read and assess the archival MD
try {
  const mdContent = execSync(`ssh tower-nas "cat '${mdPath}' 2>/dev/null || echo 'NOT FOUND'"`,
    { timeout: 10000, encoding: 'utf8' }).trim();
  const englishWords = (mdContent.match(/\b[a-zA-Z]{3,}\b/g) ?? []).length;
  const totalChars = mdContent.replace(/\s+/g, '').length;
  log(`\n  English word count: ${englishWords}  Total chars: ${totalChars}`);
  log(`  Content preview:\n${mdContent.split('\n').slice(0,15).map(l => '    ' + l).join('\n')}`);
} catch (e) { log(`  could not read MD: ${e.message}`); }

log(`\nDone.`);
