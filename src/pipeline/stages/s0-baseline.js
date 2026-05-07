// Stage 0: Quality baseline + domain detection. Deterministic scoring + optional Haiku domain inference.
// Exports: s0Baseline. Deps: score.js, domain-detect.js, context.js
import { existsSync, statSync } from 'fs';
import { scorePdf } from '../../pdf-upgrade/score.js';

const MAX_PDF_MB = 200; // reject PDFs larger than this — protects memory in all downstream stages
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
    const fileMb = statSync(ctx.sourcePath).size / (1024 * 1024);
    if (fileMb > MAX_PDF_MB) throw new Error(`PDF too large (${fileMb.toFixed(1)}MB > ${MAX_PDF_MB}MB limit)`);
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
      processing_difficulty: score.processing_difficulty ?? 1.0,
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

    // Text-layer PDFs with substantial content need no OCR at all — skip s1-s5 entirely.
    // pdf-parse can't decode Persian/Arabic fonts, so composite_score may be low even when the
    // text layer is perfect (e.g. bilingual PDFs generated from Word/Google Docs). avg_chars_per_page
    // is a reliable signal: if text is extractable at scale, OCR will only make things worse.
    if (score.has_text_layer === 1 && score.avg_chars_per_page >= 300) {
      ctx.config.skip = [...new Set([...(ctx.config.skip ?? []), 's1', 's2', 's3', 's4', 's5'])];
      ctx.addDecision('s0', 'skip_all_ocr',
        `has_text_layer=1 avg_chars=${score.avg_chars_per_page} — text PDF needs no OCR`,
        score.composite_score);
      notes = (notes ? notes + '; ' : '') + 'text_layer_skip: no OCR needed';
    } else if (score.has_text_layer === 1 && !ctx.config.skip?.includes('s4')) {
      // Sparse text layer: still skip the escalation stages (re-OCR + Vision AI)
      ctx.config.skip = [...new Set([...(ctx.config.skip ?? []), 's4', 's5'])];
      ctx.addDecision('s0', 'skip_ocr_escalation',
        `has_text_layer=1 — 600dpi re-scan and Vision AI only apply to image PDFs`,
        score.composite_score);
    }

    // Skip s5 only if below localVision gate AND not a hard image PDF.
    // Hard docs (difficulty >= 0.3) need vision even at low importance — they're hard because
    // local OCR fails on them and escalation is the only path to usable text.
    const visionGate = ctx.config.escalation?.localVision ?? 1;
    const difficulty = score.processing_difficulty ?? 0;
    if (ctx.importance < visionGate && difficulty < 0.3 && !ctx.config.skip?.includes('s5')) {
      ctx.config.skip = [...new Set([...(ctx.config.skip ?? []), 's5'])];
      ctx.addDecision('s0', 'skip_vision',
        `importance ${ctx.importance} < gate ${visionGate} and difficulty ${difficulty} < 0.3`, ctx.importance);
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
