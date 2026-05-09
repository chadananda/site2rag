#!/usr/bin/env node
// Pipeline optimizer test harness. Runs 10 representative docs through 6 config variants,
// analyzes poor results with Claude Sonnet vision, and produces a strategy report.
// Usage: node test/pipeline-optimizer/run-harness.js [--domain bahai-library.com]
// Output: tmp/optimizer-results.db, tmp/optimizer-report.md
// Deps: pipeline-server (localhost:49900), Anthropic API key

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';
import { VARIANTS, BASELINE_ID } from './config-variants.js';
import { ResultsDb } from './results-db.js';
import { analyzePageQuality, synthesizeInsights } from './analyze-page.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP  = join(ROOT, 'tmp');
mkdirSync(TMP, { recursive: true });

const DB_PATH     = join(TMP, 'optimizer-results.db');
const REPORT_PATH = join(TMP, 'optimizer-report.md');
const LOG_PATH    = join(TMP, 'optimizer-log.txt');

const PIPELINE_URL  = process.env.PIPELINE_URL ?? 'http://tower-nas.local:49900';
const API_KEY       = process.env.ANTHROPIC_API_KEY;
const DOMAIN        = process.argv.find((a,i) => process.argv[i-1]==='--domain') ?? 'bahai-library.com';
const POOR_THRESHOLD = 0.65;   // runs below this score get vision analysis
const JOB_TIMEOUT_MS = 20 * 60 * 1000; // 20 min max per job

const log = (...args) => {
  const line = `[${new Date().toISOString().slice(11,19)}] ${args.join(' ')}`;
  console.log(line);
  try { writeFileSync(LOG_PATH, line + '\n', { flag: 'a' }); } catch {}
};

async function runVariant(client, doc, variant) {
  log(`  → ${variant.id}: ${doc.id} (${doc.pages}pp ${doc.language})`);
  const t0 = Date.now();
  try {
    const jobId = await client.submitJob({
      pdfPath: doc.localPath,
      sourceUrl: doc.url,
      meta: { language: doc.language, title: doc.id },
      config: variant.config,
      importance: 1000,
    });

    const job = await client.waitForJob(jobId, { timeout: JOB_TIMEOUT_MS });
    const receipt = job.receipt ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt) : null;
    const finalScore = receipt?.quality?.final ?? 0;
    log(`     score=${finalScore.toFixed(3)} cost=$${(receipt?.totals?.cost_usd??0).toFixed(4)} time=${((Date.now()-t0)/1000).toFixed(0)}s`);
    return { jobId, receipt, finalScore, ok: true };
  } catch (e) {
    log(`     FAILED: ${e.message}`);
    return { error: e.message, finalScore: 0, ok: false };
  }
}

async function analyzePoorResult(db, runId, doc, result, variant) {
  if (!API_KEY) { log('     [skip vision analysis — no API key]'); return; }
  const receipt = result.receipt;
  if (!receipt?.stages) return;

  // Find the PNG paths from s3 stage decisions
  const decisions = receipt.decisions ?? [];
  const pngDecisions = decisions.filter(d => d.stage === 's3' && d.decision?.startsWith('contrast_'));

  // Get worst pages by score — use per_stage to identify bad pages
  // Fallback: analyze page 1 (most documents have useful content there)
  const pagesInfo = receipt.stages?.find(s => s.stage === 's3');
  const pageCount = pagesInfo?.pages_affected ?? doc.pages;

  // Find PNG in pipeline tmp dir (uses docHash from pipeline context)
  // We can't directly access the tmp dir, so send a different signal to the pipeline
  // to get page images. For now, re-use the PDF directly with Haiku Vision.
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: API_KEY });

  log(`     Analyzing poor result (score=${result.finalScore.toFixed(2)}) with Claude Sonnet Vision...`);

  try {
    // Use Sonnet for deep analysis of pipeline results — more expensive but much more accurate
    const { readFileSync } = await import('fs');
    const pdfExists = existsSync(doc.localPath);
    if (!pdfExists) return;

    // Convert first page to base64 for vision analysis
    // Use pdftoppm to get a quick sample
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { tmpdir } = await import('os');
    const { join: pjoin } = await import('path');
    const execFileAsync = promisify(execFile);
    const tmpPng = pjoin(tmpdir(), `opt-analysis-${Date.now()}.png`);

    await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', '-singlefile', doc.localPath, tmpPng.replace('.png','')], { timeout: 30000 });

    if (!existsSync(tmpPng)) return;

    const imgData = readFileSync(tmpPng).toString('base64');
    const ocrWords = []; // receipt doesn't give us back words directly

    // Stage-by-stage summary for the analysis prompt
    const stageSummary = (receipt.stages ?? [])
      .filter(s => s.pages_affected > 0 || s.stage === 's0')
      .map(s => `${s.stage}: ${s.pages_affected} pages, ${s.notes ?? ''}, cost=$${(s.cost_usd??0).toFixed(4)}`)
      .join('\n');
    const decisionSummary = (receipt.decisions ?? []).slice(0, 20)
      .map(d => `${d.stage}/${d.decision}: ${d.reason ?? ''}`)
      .join('\n');

    const analysis = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgData } },
          { type: 'text', text: `This is page 1 of a ${doc.pages}-page ${doc.language} document (category: ${doc.category}).
The pipeline achieved a quality score of ${result.finalScore.toFixed(2)} (target: >${POOR_THRESHOLD}).
Variant tested: "${variant.label}"

Pipeline execution summary:
${stageSummary}

Key decisions made:
${decisionSummary}

Analyze this result carefully. What specific improvements would most improve the final text quality?
Consider: image preprocessing (contrast, binarization, deskewing, despeckling, resolution),
OCR engine choices, language detection accuracy, vision escalation strategy, and post-processing.

Respond in JSON:
{
  "primary_issue": "one sentence",
  "image_quality": "excellent/good/fair/poor",
  "text_type": "printed/handwritten/mixed",
  "language_correct": true/false,
  "recommended_pipeline_changes": [
    {"change": "specific change", "expected_improvement": "low/medium/high", "cost": "cheap/moderate/expensive"}
  ],
  "next_variant_to_try": "id from: high_res / contrast_forced / otsu_only / low_escalate / high_res_contrast",
  "confidence": 0.0-1.0
}` }
        ]
      }]
    });

    const text = analysis.content[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { primary_issue: text.slice(0, 400) };

    db.savePageAnalysis(runId, doc.id, 1, result.finalScore, JSON.stringify(parsed),
      (parsed.recommended_pipeline_changes ?? []).map(c => c.change).join('; '));

    log(`     Analysis: ${parsed.primary_issue ?? '—'}`);
    if (parsed.next_variant_to_try) log(`     → Next to try: ${parsed.next_variant_to_try}`);

    // Clean up tmp png
    try { (await import('fs')).unlinkSync(tmpPng); } catch {}

    return parsed;
  } catch (e) {
    log(`     Vision analysis failed: ${e.message}`);
  }
}

async function generateReport(db, corpus, elapsedMs) {
  const summary = db.summarize();
  const insights = db.allInsights();

  const lines = [
    '# Pipeline Optimizer Report',
    `Generated: ${new Date().toISOString()}`,
    `Runtime: ${(elapsedMs/60000).toFixed(1)} minutes`,
    '',
    '## Test Corpus',
    corpus.map(d => `- **${d.category}** (${d.language}, ${d.pages}pp, baseline=${(d.baselineScore*100).toFixed(0)}%): \`${d.url.split('/').pop()}\``).join('\n'),
    '',
    '## Results by Category & Variant',
    '| Category | Language | Variant | Avg Score | Avg Gain | Avg Cost |',
    '|---|---|---|---|---|---|',
    ...summary.map(r =>
      `| ${r.category} | ${r.language} | ${r.variant_id} | ${(r.avg_score*100).toFixed(1)}% | ${r.avg_gain >= 0 ? '+' : ''}${(r.avg_gain*100).toFixed(1)}% | $${r.avg_cost} |`
    ),
    '',
    '## Best Variant Per Category',
  ];

  // Group by category, find best variant
  const byCategory = {};
  for (const r of summary) {
    const key = `${r.category}:${r.language}`;
    if (!byCategory[key] || r.avg_score > byCategory[key].avg_score) byCategory[key] = r;
  }
  for (const [key, best] of Object.entries(byCategory)) {
    lines.push(`- **${key}**: \`${best.variant_id}\` → ${(best.avg_score*100).toFixed(1)}% (+${(best.avg_gain*100).toFixed(1)}%)`);
  }

  lines.push('', '## Vision Analysis Insights');
  if (insights.length) {
    insights.forEach(i => lines.push(`- [${i.category}/${i.language}] ${i.insight} (confidence: ${i.confidence})`));
  } else {
    lines.push('No insights generated yet.');
  }

  lines.push('', '## Recommended Pipeline Config by Document Type');
  lines.push('```json');
  lines.push(JSON.stringify(Object.fromEntries(
    Object.entries(byCategory).map(([key, best]) => [key, best.variant_id])
  ), null, 2));
  lines.push('```');

  const report = lines.join('\n');
  writeFileSync(REPORT_PATH, report);
  return report;
}

async function main() {
  log('=== Pipeline Optimizer starting ===');
  log(`Domain: ${DOMAIN} | Pipeline: ${PIPELINE_URL}`);
  if (!API_KEY) log('Warning: No ANTHROPIC_API_KEY — vision analysis will be skipped');

  const client = new PipelineClient({ baseUrl: PIPELINE_URL, timeout: JOB_TIMEOUT_MS });
  const db = new ResultsDb(DB_PATH);

  // Verify pipeline is up
  try {
    const health = await client.health();
    log(`Pipeline health: ${JSON.stringify(health)}`);
  } catch (e) {
    log(`ERROR: Cannot reach pipeline server at ${PIPELINE_URL}: ${e.message}`);
    process.exit(1);
  }

  // Build corpus
  log('Building test corpus...');
  const corpus = await buildCorpus({ domain: DOMAIN });
  log(`Corpus: ${corpus.length} documents`);
  corpus.forEach(d => log(`  ${d.category.padEnd(20)} ${d.pages}pp ${d.language} score=${d.baselineScore.toFixed(2)} ${d.url.split('/').pop()}`));

  const t0 = Date.now();
  const MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;

  // Main loop: for each doc, run all variants
  for (const doc of corpus) {
    if (Date.now() - t0 > MAX_RUNTIME_MS) { log('Time limit reached, stopping.'); break; }
    log(`\n=== Document: ${doc.id} (${doc.category}) ===`);

    const docResults = [];

    for (const variant of VARIANTS) {
      if (Date.now() - t0 > MAX_RUNTIME_MS) break;

      const result = await runVariant(client, doc, variant);
      const runId = db.saveRun(doc, variant, result);
      docResults.push({ variant, result, runId });

      // Vision analysis for poor results (use Sonnet for accuracy)
      if (result.ok && result.finalScore < POOR_THRESHOLD) {
        const analysis = await analyzePoorResult(db, runId, doc, result, variant);

        // If analysis suggests a specific next variant, prioritize it
        if (analysis?.next_variant_to_try) {
          const suggestedVariant = VARIANTS.find(v => v.id === analysis.next_variant_to_try);
          if (suggestedVariant && !docResults.find(r => r.variant.id === suggestedVariant.id)) {
            log(`  [Analysis suggests trying ${suggestedVariant.id} next — prioritizing]`);
            const sugResult = await runVariant(client, doc, suggestedVariant);
            const sugRunId = db.saveRun(doc, suggestedVariant, sugResult);
            docResults.push({ variant: suggestedVariant, result: sugResult, runId: sugRunId });
          }
        }
      }

      // Small delay between jobs to not overwhelm queue
      await new Promise(r => setTimeout(r, 2000));
    }

    // Synthesize insights for this doc type
    const poorRuns = db.poorRuns(POOR_THRESHOLD);
    const analyses = poorRuns
      .filter(r => r.doc_id === doc.id)
      .map(r => ({ ...r, vision_analysis: r.vision_analysis }))
      .filter(r => r.vision_analysis);

    if (analyses.length > 1 && API_KEY) {
      log(`  Synthesizing insights from ${analyses.length} poor runs...`);
      const insights = await synthesizeInsights(analyses, doc.category, doc.language);
      insights.forEach(insight => db.saveInsight(doc.category, doc.language, insight, 0.7, analyses.length));
    }

    // Log best variant for this doc
    const best = docResults.sort((a, b) => b.result.finalScore - a.result.finalScore)[0];
    if (best) log(`  Best: ${best.variant.id} → ${best.result.finalScore.toFixed(3)}`);
  }

  // Generate final report
  log('\n=== Generating report ===');
  const report = await generateReport(db, corpus, Date.now() - t0);
  log(`Report written to ${REPORT_PATH}`);
  log('\n--- SUMMARY ---');
  log(report.split('\n').slice(0, 40).join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
