// Runs strategy CPU/GPU branches with CPU-first gating. GPU runs only if CPU score < cpuAcceptThreshold.
// Exports: runExperiment
// Deps: preprocessor-registry.js, engine-registry.js, ocr-server-pool.js (callEngineEndpoint)

import { getPreprocessor } from './preprocessor-registry.js';
import { getEngine } from './engine-registry.js';
import { callEngineEndpoint } from './ocr-server-pool.js';

/**
 * Apply preprocessors in sequence to a PNG, return final path.
 * Falls back to original path if any preprocessor fails.
 */
async function applyPreprocessors(pngPath, preprocessorIds) {
  let current = pngPath;
  for (const id of preprocessorIds) {
    const pp = getPreprocessor(id);
    if (!pp) { process.stderr.write(`[experiment-runner] unknown preprocessor: ${id}\n`); continue; }
    try { current = await pp.fn(current); }
    catch (e) { process.stderr.write(`[experiment-runner] preprocessor ${id} failed: ${e.message}\n`); }
  }
  return current;
}

/**
 * Run a single engine on a path via callEngineEndpoint (local subprocess or remote HTTP).
 * Returns timed result with engine id, text, words, layout, durationMs.
 */
async function runEngine(engineId, pngPath, lang) {
  const engine = getEngine(engineId);
  if (!engine) return { engine: engineId, text: '', words: null, durationMs: 0, error: 'unknown engine' };
  const t0 = Date.now();
  try {
    const result = await callEngineEndpoint(engine, pngPath, lang);
    return { engine: engineId, text: result.text ?? '', words: result.words ?? null,
             layout: result.layout ?? null, durationMs: Date.now() - t0 };
  } catch (e) {
    return { engine: engineId, text: '', words: null, durationMs: Date.now() - t0, error: e.message };
  }
}

/**
 * Run a branch (set of engines) in parallel, log decisions, return branch result.
 */
async function runBranch(branch, processedPath, lang, pageNo, ctx) {
  const { id: branchId, engines = [] } = branch;
  const engineResults = await Promise.all(
    engines.map(engineId => runEngine(engineId, processedPath, lang))
  );
  for (const er of engineResults) {
    const key = `exp_p${pageNo}_${branchId}_${er.engine}`;
    if (ctx?.metrics?.decisions)
      ctx.metrics.decisions[key] = { durationMs: er.durationMs, textLen: er.text?.length ?? 0, error: er.error ?? null };
  }
  return { branchId, engineOutputs: engineResults, preprocessorPath: processedPath };
}

/**
 * Score CPU results by best non-empty text length heuristic (placeholder until judge is wired).
 * Returns 0-1 estimate; caller may replace with real judge score.
 */
function scoreCpuResults(cpuResults) {
  let best = 0;
  for (const r of cpuResults)
    for (const er of r.engineOutputs ?? [])
      if ((er.text?.length ?? 0) > best) best = er.text.length;
  // Heuristic: >=200 chars → likely good; clamp to 0-1
  return Math.min(best / 200, 1.0);
}

/**
 * Run CPU then (conditionally) GPU branches for a page.
 * page: { pngPath, pageNo, lang }
 * strategy: { preprocessors, cpuBranches, gpuBranches, cpuAcceptThreshold, ... }
 *   Falls back to legacy `branches` field if cpuBranches absent.
 * ctx: pipeline context (ctx.metrics.decisions mutated with timing logs)
 * judgeAfterCpu: if true, score CPU results and skip GPU when score >= cpuAcceptThreshold
 * Returns: { cpuResults, gpuResults, skippedGpu }
 */
export async function runExperiment(page, strategy, ctx, judgeAfterCpu = true) {
  const { pngPath, pageNo, lang = 'en' } = page;
  const { preprocessors = [], cpuBranches, gpuBranches = [], cpuAcceptThreshold = 0.65 } = strategy;
  // Legacy shape fallback: if no cpuBranches, treat branches as cpuBranches
  const effectiveCpuBranches = cpuBranches ?? strategy.branches ?? [];
  // Apply preprocessors once (shared across all branches)
  const processedPath = preprocessors.length
    ? await applyPreprocessors(pngPath, preprocessors)
    : pngPath;
  // --- Phase 1: CPU branches (always, fully parallel) ---
  const cpuResults = await Promise.all(
    effectiveCpuBranches.map(b => runBranch(b, processedPath, lang, pageNo, ctx))
  );
  // --- Judge CPU results ---
  const cpuScore = scoreCpuResults(cpuResults);
  if (ctx?.metrics?.decisions)
    ctx.metrics.decisions[`exp_p${pageNo}_cpu_done`] = { cpuScore, threshold: cpuAcceptThreshold };
  // --- Phase 2: GPU branches (conditional) ---
  let gpuResults = [];
  let skippedGpu = false;
  if (!gpuBranches.length) {
    skippedGpu = true;
  } else if (judgeAfterCpu && cpuScore >= cpuAcceptThreshold) {
    skippedGpu = true;
    if (ctx?.metrics?.decisions)
      ctx.metrics.decisions[`exp_p${pageNo}_gpu_skipped`] = { cpuScore, reason: 'cpu_score_sufficient' };
  } else {
    if (ctx?.metrics?.decisions)
      ctx.metrics.decisions[`exp_p${pageNo}_gpu_run`] = { cpuScore, reason: cpuScore < cpuAcceptThreshold ? 'cpu_score_insufficient' : 'judge_disabled' };
    // GPU branches run serially (serialized bottleneck)
    for (const b of gpuBranches)
      gpuResults.push(await runBranch(b, processedPath, lang, pageNo, ctx));
  }
  return { cpuResults, gpuResults, skippedGpu };
}
