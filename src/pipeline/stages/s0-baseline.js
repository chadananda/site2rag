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

    if (score.language && score.language !== 'unknown' && !ctx.meta.language) ctx.meta.language = score.language;

    // For image PDFs: infer language + scan issues from a small page thumbnail.
    // Runs before domain detection so language is available for all downstream stages.
    const needsOcr = score.has_text_layer !== 1 || score.avg_chars_per_page < 300;
    if (needsOcr && ctx.config.apiKey && ctx.pageCount > 0) {
      try {
        const { inferScanProfile } = await import('../scan-profile.js');
        const profile = await inferScanProfile(ctx);
        tokensIn  += profile.tokensIn  ?? 0;
        tokensOut += profile.tokensOut ?? 0;
        costUsd   += profile.costUsd   ?? 0;
        // scan_profile wins over unknown baseline; only skip if a real language was already set
        if (profile.language && (profile.languageConfidence ?? 0) >= 0.6 && (!ctx.meta?.language || ctx.meta.language === 'unknown')) {
          ctx.meta = { ...(ctx.meta ?? {}), language: profile.language };
        }
        if (profile.scanIssues?.length) ctx._scanIssues = profile.scanIssues;
        const issueStr = (profile.scanIssues ?? []).join(',') || 'none';
        ctx.addDecision('s0', 'scan_profile',
          `lang=${profile.language ?? 'unknown'} conf=${(profile.languageConfidence ?? 0).toFixed(2)} issues=${issueStr}`);
      } catch (e) {
        ctx.addError('s0', new Error(`scan_profile: ${e.message}`), true);
      }
    }

    // Domain detection — tokens counted here so s0 stage record reflects total cost
    if (!ctx.domain && ctx.config.domainDetect !== false) {
      const usage = await detectDomain(ctx);
      tokensIn  += usage.tokens_in;
      tokensOut += usage.tokens_out;
      costUsd   += usage.cost_usd;
    }

    // Text-layer PDFs: skip OCR stages entirely — PDF text encoding is authoritative.
    // pdf-parse can't decode Persian/Arabic fonts, so use avg_chars_per_page as the signal:
    // if the text layer delivers substantial content, OCR would only degrade quality.
    // Note: this does NOT skip s6 (spellfix) or s8 (export) — those still run on extracted text.
    if (score.has_text_layer === 1 && score.avg_chars_per_page >= 300) {
      ctx.config.skip = [...new Set([...(ctx.config.skip ?? []), 's1', 's2', 's3', 's4', 's5'])];
      ctx.addDecision('s0', 'skip_all_ocr',
        `has_text_layer=1 avg_chars=${score.avg_chars_per_page} — text PDF, skip OCR`,
        score.composite_score);
      notes = (notes ? notes + '; ' : '') + 'text_layer_skip: no OCR needed';
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
