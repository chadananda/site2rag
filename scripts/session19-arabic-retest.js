#!/usr/bin/env node
// Session 19: Retest Arabic TOC docs after s5-vision.js fixes.
// Tests: (1) LaTeX artifacts gone, (2) RTL prompt active, (3) boss skipped for Arabic,
//        (4) quality score reflects actual content quality

import { PipelineClient } from '../src/pipeline/client.js';
import { existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://tower-nas:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });
const JOB_TIMEOUT = 20 * 60 * 1000;
const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

const DOCS = [
  { id: 'inba-v095-toc', path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659038082-inba_v095-toc.pdf', notes: '1pp Arabic TOC — had LaTeX artifacts' },
  { id: 'inba-v073-toc', path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659038119-inba_v073-toc.pdf', notes: '1pp Arabic TOC — had duplicate ordinals' },
  { id: 'inba-v011-toc', path: '/tank/site2rag/websites_mirror/afnanlibrary.org/74307/1659038283-inba_v011-toc.pdf', notes: '3pp Persian TOC — had LaTeX+hallucinated alphabet table×3' },
];

async function fetchRouting() {
  try {
    return execSync(`ssh tower-nas "grep '\\[tool-runner\\]' /tank/site2rag/logs/pipeline-server.out.log | tail -30"`,
      { timeout: 10000, encoding: 'utf8' }).trim().split('\n');
  } catch { return []; }
}

for (const doc of DOCS) {
  log(`\n${'─'.repeat(60)}`);
  log(`Testing: ${doc.id} — ${doc.notes}`);

  // Delete any existing archival files so we get a fresh run
  const mdPath = doc.path.replace('.pdf', '_archival.md');
  try { execSync(`ssh tower-nas "rm -f '${mdPath}'"`, { timeout: 5000 }); } catch {}

  const before = await fetchRouting();
  const t0 = Date.now();

  let job, receipt, error;
  try {
    const jobId = await client.submitJob({ pdfPath: doc.path, meta: { language: 'arabic' }, importance: 8 });
    log(`  submitted → ${jobId}`);
    job = await client.waitForJob(jobId, { timeout: JOB_TIMEOUT });
    receipt = job.receipt ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt) : null;
  } catch (e) { error = e.message; log(`  FAILED: ${error}`); }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const after = await fetchRouting();
  const newRouting = after.filter(l => !before.includes(l));

  const q = receipt?.quality ?? {};
  const stages = receipt?.stages?.map(s => `${s.stage}(${s.duration_ms}ms)`)?.join(' → ') ?? '';
  log(`  time=${elapsed}s baseline=${(q.baseline?.composite_score ?? 0).toFixed(3)} final=${(q.final ?? 0).toFixed(3)}`);
  log(`  stages: ${stages}`);
  log(`  routing: ${newRouting.filter(l => l.includes('tool-runner')).map(l => l.split('[tool-runner]')[1] || l).join(' | ') || '(none)'}`);

  // Check decisions for LaTeX detection and boss skip
  const decisions = receipt?.stages?.flatMap(s => s.decisions ?? []) ?? [];
  const latexDecision = decisions.find(d => String(d).includes('latex') || String(d).includes('LaTeX'));
  const bossDecision = decisions.find(d => String(d).includes('boss'));
  if (latexDecision) log(`  ⚠ LaTeX detected: ${JSON.stringify(latexDecision)}`);
  if (bossDecision) log(`  boss used: ${JSON.stringify(bossDecision)}`);

  // Fetch and display the actual archival markdown
  try {
    const mdContent = execSync(`ssh tower-nas "cat '${mdPath}' 2>/dev/null || echo 'NOT FOUND'"`,
      { timeout: 10000, encoding: 'utf8' }).trim();
    log(`\n  ── Archival MD content ──`);
    const hasLatex = /\\begin\{|\\text\{/.test(mdContent);
    log(`  LaTeX artifacts: ${hasLatex ? '✗ YES (BUG STILL PRESENT)' : '✓ none'}`);
    log(`  Content preview:\n${mdContent.split('\n').slice(0, 20).map(l => '    ' + l).join('\n')}`);

    // Assess content quality
    const arabicChars = (mdContent.match(/[\u0600-\u06FF]/g) ?? []).length;
    const totalChars = mdContent.replace(/\s+/g, '').length;
    const arabicRatio = totalChars > 0 ? arabicChars / totalChars : 0;
    log(`  Arabic char ratio: ${(arabicRatio * 100).toFixed(1)}% (${arabicChars} of ${totalChars})`);
    if (arabicRatio < 0.3 && totalChars > 50) log(`  ⚠ Low Arabic ratio — output may be hallucinated/wrong`);
    else if (arabicRatio >= 0.3) log(`  ✓ Reasonable Arabic content ratio`);
  } catch (e) { log(`  could not read MD: ${e.message}`); }

  await new Promise(r => setTimeout(r, 3000));
}

log(`\n${'='.repeat(60)}`);
log('Retest complete');
