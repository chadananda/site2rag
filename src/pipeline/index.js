// OCR upgrade pipeline runner. Chains stages, handles errors, writes receipt + analytics.
// Exports: runPipeline, runStage, STAGES, buildSystemPrompt. Deps: all stage modules, context.js, config.js
import { writeFileSync } from 'fs';
import { PipelineContext, PIPELINE_VERSION } from './context.js';
import { mergeConfig } from './config.js';
import { writeAnalytics } from './analytics.js';
import { s0Baseline }   from './stages/s0-baseline.js';
import { s1Preprocess } from './stages/s1-preprocess.js';
import { s2Classify }   from './stages/s2-classify.js';
import { s3Ocr }        from './stages/s3-ocr.js';
import { s4Escalate }   from './stages/s4-escalate.js';
import { s5Vision }     from './stages/s5-vision.js';
import { s6SpellFix }   from './stages/s6-spellfix.js';
import { s7Archive }    from './stages/s7-archive.js';
import { s8Export }     from './stages/s8-export.js';

const log = (msg) => console.log(`[pipeline] ${new Date().toISOString().slice(0,19)} ${msg}`);

// Registry: name → function. Add new implementations here without touching runPipeline().
export const STAGES = { s0: s0Baseline, s1: s1Preprocess, s2: s2Classify, s3: s3Ocr,
  s4: s4Escalate, s5: s5Vision, s6: s6SpellFix, s7: s7Archive, s8: s8Export };

/**
 * Run the full pipeline on a single document.
 * @param {object} opts - { docId, sourcePath, sourceUrl, importance, config, meta }
 * @returns {PipelineContext} - populated context with receipt attached
 */
export async function runPipeline(opts) {
  const config = mergeConfig(opts.config ?? {});

  // stopAfter: skip all stages after the named stage (inclusive of everything after)
  if (config.stopAfter) {
    const allStages = Object.keys(STAGES);
    const idx = allStages.indexOf(config.stopAfter);
    if (idx >= 0) {
      const toSkip = allStages.slice(idx + 1);
      config.skip = [...new Set([...(config.skip ?? []), ...toSkip])];
    }
  }

  config._log = log;
  const ctx = new PipelineContext({ ...opts, config });
  const stagesToRun = config.stages ?? Object.keys(STAGES);

  log(`start doc=${ctx.docId} importance=${ctx.importance} stages=${stagesToRun.join(',')}`);

  for (const stageName of stagesToRun) {
    // skip list is checked inside each stage, but also guard here to skip the fn call entirely
    if ((ctx.config.skip ?? []).includes(stageName)) {
      log(`  skip ${stageName}`);
      continue;
    }

    const stageFn = STAGES[stageName];
    if (!stageFn) {
      log(`  unknown stage: ${stageName}`);
      continue;
    }

    log(`  run ${stageName}`);
    if (opts.onStageStart) {
      try { opts.onStageStart(stageName); } catch (_) { /* never stop the pipeline */ }
    }
    try {
      await stageFn(ctx);
    } catch (err) {
      // failFast errors are re-thrown from inside the stage; non-failFast errors are caught
      // and logged there. If we get here it's a failFast error.
      log(`  FATAL ${stageName}: ${err.message}`);
      throw err;
    }

    // Log stage result and fire progress callback
    const stageRecord = ctx.metrics.stages.find(s => s.stage === stageName);
    if (stageRecord) {
      const costStr = stageRecord.cost_usd ? ` $${stageRecord.cost_usd.toFixed(4)}` : '';
      log(`  done ${stageName} ${stageRecord.duration_ms}ms${costStr} pages=${stageRecord.pages_affected}`);
    }
    if (opts.onProgress) {
      try { opts.onProgress(stageName, stageRecord?.pages_affected ?? 0, ctx.pageCount ?? 0); }
      catch (_) { /* progress callback errors must never stop the pipeline */ }
    }
  }

  // Finalise quality score
  const lastQuality = Object.entries(ctx.quality.perStage).at(-1)?.[1] ?? null;
  ctx.quality.final = lastQuality ?? ctx.quality.baseline?.composite_score ?? null;

  // Write receipt
  const receipt = ctx.toReceipt();
  if (ctx.outputs.archivalPdfPath) {
    const receiptPath = ctx.outputs.archivalPdfPath.replace(/\.pdf$/i, '_receipt.json');
    try {
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
      ctx.outputs.receiptPath = receiptPath;
    } catch (_) { /* non-fatal */ }
  }

  const totalCost = receipt.totals.cost_usd;
  const gain = receipt.quality.gain ?? 0;
  log(`done doc=${ctx.docId} gain=${gain.toFixed(3)} cost=$${totalCost.toFixed(4)} errors=${ctx.metrics.errors.length}`);

  // Write analytics (fire-and-forget, never throws)
  if (config.analyticsDbPath) {
    writeAnalytics(ctx, config.analyticsDbPath).catch(() => {});
  }

  return ctx;
}

/**
 * Build a system prompt for LLM stages, prepending domain context if available.
 * Keeps domain detection results generic — no hardcoded domain assumptions.
 */
export function buildSystemPrompt(stageInstructions, ctx) {
  const domainContext = ctx?.domain?.prompt_context;
  if (!domainContext) return stageInstructions;
  return `${domainContext}\n\n${stageInstructions}`;
}

/**
 * Run a single named stage on an existing context.
 * Useful for re-running one stage without reprocessing the whole document.
 */
export async function runStage(stageName, ctx) {
  const stageFn = STAGES[stageName];
  if (!stageFn) throw new Error(`Unknown stage: ${stageName}`);
  return stageFn(ctx);
}
