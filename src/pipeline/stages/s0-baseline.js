// Stage 0: Quality baseline + domain detection. Deterministic scoring + optional Haiku domain inference.
// Exports: s0Baseline. Deps: score.js, domain-detect.js, context.js
import { existsSync } from 'fs';
import { scorePdf } from '../../pdf-upgrade/score.js';
import { shouldRun } from '../config.js';
import { detectDomain } from '../domain-detect.js';

/**
 * Compute the quality baseline for the document.
 * Always runs (cannot be skipped — needed to gate downstream stages).
 * Adds early-exit skip flags to ctx.config.skip if doc is already good enough.
 */
export async function s0Baseline(ctx) {
  ctx.beginStage('s0');
  let pagesAffected = 0;
  let notes = null;
  let tokensIn = 0, tokensOut = 0, costUsd = 0;

  try {
    if (!existsSync(ctx.sourcePath)) throw new Error(`File not found: ${ctx.sourcePath}`);
    const score = await scorePdf(ctx.sourcePath);

    ctx.pageCount = score.pages ?? 0;
    pagesAffected = ctx.pageCount;

    ctx.setBaseline({
      composite_score: score.composite_score,
      readable_pages_pct: score.readable_pages_pct,
      word_quality: score.word_quality_estimate,
      has_text_layer: score.has_text_layer,
      avg_chars_per_page: score.avg_chars_per_page,
      language: score.language,
      excerpt: score.excerpt ?? null,
    });

    ctx.addDecision('s0', 'baseline_computed', [
      `composite=${score.composite_score.toFixed(3)}`,
      `readable=${score.readable_pages_pct.toFixed(2)}`,
      `lang=${score.language ?? 'unknown'}`,
      `pages=${ctx.pageCount}`,
    ].join(' '), score.composite_score);

    if (score.language && !ctx.meta.language) ctx.meta.language = score.language;

    // Domain detection — tokens counted here so s0 stage record reflects total cost
    if (!ctx.domain && ctx.config.domainDetect !== false) {
      const usage = await detectDomain(ctx);
      tokensIn  += usage.tokens_in;
      tokensOut += usage.tokens_out;
      costUsd   += usage.cost_usd;
    }

    const threshold = ctx.config.thresholds?.goodDoc ?? 0.75;
    if (score.composite_score >= threshold) {
      ctx.config.skip = [...new Set([...(ctx.config.skip ?? []), 's1', 's2', 's3', 's4', 's5'])];
      ctx.addDecision('s0', 'early_exit',
        `composite ${score.composite_score.toFixed(3)} >= threshold ${threshold} — skipping heavy stages`,
        score.composite_score);
      notes = 'early_exit: doc already good enough';
    }

    const visionGate = ctx.config.escalation?.localVision ?? 1;
    if (ctx.importance < visionGate && !ctx.config.skip?.includes('s5')) {
      ctx.config.skip = [...new Set([...(ctx.config.skip ?? []), 's5'])];
      ctx.addDecision('s0', 'skip_vision',
        `importance ${ctx.importance} < gate ${visionGate}`, ctx.importance);
    }

  } catch (err) {
    ctx.addError('s0', err, false);
    ctx.setBaseline({ composite_score: 0, readable_pages_pct: 0, word_quality: 0,
      has_text_layer: 0, avg_chars_per_page: 0, language: null, excerpt: null });
    notes = `baseline_error: ${err.message}`;
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s0', {
      pages_affected: pagesAffected,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
      notes,
    });
  }

  return ctx;
}
