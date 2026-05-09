// Stage 6: LLM spell-fix on fuzzy-confidence words only. Bbox-preserving, conf-gated.
// Exports: s6SpellFix
//   s6SpellFix(ctx) → ctx  — runs Haiku spell-fix on words in [fuzzyWord, cleanPage) conf band
// CONFIG: apiKey                        — required; skip if absent
//         implementations.spellfix[0]   — model name (default: claude-haiku-4-5-20251001)
//         thresholds.spellFixMin:0.45   — skip if baseline composite < this
//         thresholds.cleanPage:0.90     — upper bound of fuzzy band
//         thresholds.fuzzyWord:0.60     — lower bound of fuzzy band
//         maxTokenBudget                — stops at page boundary if exceeded
// ERRORS: spellFixWordObjects fail per page → recoverable; prior words kept
// CONTRACT:
//   Reads:  ctx.pages[n].words, ctx.quality.baseline, ctx.meta, ctx.domain.prompt_context
//   Writes: ctx.pages[n].words (corrections merged in), ctx.pages[n]._spellFixCount
import { spellFixWordObjects } from '../../pdf-upgrade/spell-fix.js'; // (words,apiKey,opts)→{words,tokens_in,tokens_out,cost_usd}
import { shouldRun, withinBudget } from '../config.js';               // shouldRun(stage,ctx)→bool; withinBudget(ctx,n?)→bool
// ── config defaults ──────────────────────────────────────────────────────────
const D_SPELL_FIX_MIN = 0.45;  // thresholds.spellFixMin
const D_CLEAN_PAGE    = 0.90;  // thresholds.cleanPage
const D_FUZZY_WORD    = 0.60;  // thresholds.fuzzyWord

/**
 * Run Haiku spell-fix on the fuzzy-confidence word bucket (conf between fuzzyWord and cleanPage).
 * High-confidence words and vision-escalated words are skipped.
 * Bbox join rule: same-line merges extend the bbox; cross-line merges keep first word's bbox only.
 */
export async function s6SpellFix(ctx) {
  if (!shouldRun('s6', ctx)) return ctx;

  ctx.beginStage('s6');
  let totalIn = 0, totalOut = 0, totalCost = 0, pagesFixed = 0;
  const approach = ctx.config.implementations?.spellfix?.[0] ?? 'claude-haiku-4-5-20251001';

  try {
    const apiKey = ctx.config.apiKey;
    if (!apiKey) {
      ctx.addDecision('s6', 'skip', 'no API key configured');
      return ctx;
    }

    // Don't waste tokens on docs too broken for cheap correction.
    // Use post-OCR quality (s5 or s3) if available — image PDFs have baseline=0 but may have
    // good Tesseract/vision output worth correcting.
    const postOcrScore = ctx.quality.perStage?.['s5'] ?? ctx.quality.perStage?.['s3'] ?? null;
    const baseline = postOcrScore ?? ctx.quality.baseline?.composite_score ?? 0;
    const spellMin = ctx.config.thresholds?.spellFixMin ?? D_SPELL_FIX_MIN;
    if (baseline < spellMin) {
      ctx.addDecision('s6', 'skip',
        `quality ${baseline.toFixed(3)} < min ${spellMin} — too broken for spell-fix`, baseline);
      return ctx;
    }

    const fuzzyLow = (ctx.config.thresholds?.fuzzyWord ?? D_FUZZY_WORD) * 100;
    const cleanHigh = (ctx.config.thresholds?.cleanPage ?? D_CLEAN_PAGE) * 100;

    for (const page of ctx.pages) {
      if (!page.words?.length) continue;

      // Confidence-gated: only the fuzzy bucket. Clean words pass through untouched.
      const fuzzyWords = page.words.filter(w => {
        const conf = w.conf ?? 100;
        return conf >= fuzzyLow && conf < cleanHigh;
      });
      if (fuzzyWords.length === 0) continue;

      // Token budget check before each page
      const estimatedTokens = Math.ceil(fuzzyWords.reduce((s, w) => s + (w.text?.length ?? 0), 0) / 4) + 100;
      if (!withinBudget(ctx, estimatedTokens)) {
        ctx.addDecision('s6', 'budget_stop',
          `token budget would be exceeded at page ${page.pageNo}`, page.pageNo);
        break;
      }

      const result = await spellFixWordObjects(fuzzyWords, apiKey, {
        title: ctx.meta?.title,
        language: ctx.meta?.language,
        domainContext: ctx.domain?.prompt_context,
        pageNo: page.pageNo,
        totalPages: ctx.pageCount,
        visionDraft: page._visionDraft ?? null,
      });

      // Merge corrections back into page.words by rebuilding the list.
      // result.words uses _srcIdx (position in fuzzyWords) and _mergedSrcIdx (second-half to drop).
      // Hyphen-merged pairs: first-half word gets the merged correction; second-half is dropped.
      const correctedBySrcIdx = new Map();
      const droppedSrcIdx = new Set();
      for (const w of result.words) {
        if (w._srcIdx !== undefined) correctedBySrcIdx.set(w._srcIdx, w);
        if (w._mergedSrcIdx !== undefined) droppedSrcIdx.add(w._mergedSrcIdx);
      }

      // Replace fuzzy words with corrections; leave non-fuzzy words untouched
      let fixedCount = 0;
      const nextWords = [];
      let fuzzyCount = 0;
      for (const w of page.words) {
        const conf = w.conf ?? 100;
        if (conf >= fuzzyLow && conf < cleanHigh) {
          if (droppedSrcIdx.has(fuzzyCount)) {
            // Second half of a merged hyphen pair — the preceding word already contains it
          } else {
            const corrected = correctedBySrcIdx.get(fuzzyCount);
            if (corrected) {
              nextWords.push({ ...corrected, source: `${w.source ?? 'ocr'}+spellfix` });
              if (corrected.text !== w.text) fixedCount++;
            } else {
              nextWords.push(w); // fallback: keep original if correction missing
            }
          }
          fuzzyCount++;
        } else {
          nextWords.push(w);
        }
      }
      page.words = nextWords;
      page._spellFixCount = fixedCount;

      totalIn += result.tokens_in ?? 0;
      totalOut += result.tokens_out ?? 0;
      totalCost += result.cost_usd ?? 0;
      pagesFixed++;
    }

    ctx.addDecision('s6', 'completed',
      `${pagesFixed} pages fixed, $${totalCost.toFixed(4)} cost`, totalCost);

    // Retroactive scoring: corrections reveal the prior stage's score was overstated.
    // e.g. s5=1.00, 3% of words corrected → s5 retroactively becomes 0.97, s6=1.00.
    if (pagesFixed > 0) {
      const priorStageName = ctx.quality.perStage['s5'] !== undefined ? 's5'
                           : ctx.quality.perStage['s3'] !== undefined ? 's3' : null;
      const priorScore = priorStageName
        ? ctx.quality.perStage[priorStageName]
        : (ctx.quality.baseline?.composite_score ?? 0);

      const totalPageWords = ctx.pages.reduce((s, p) => s + (p.words?.length ?? 0), 0);
      const totalFixed     = ctx.pages.reduce((s, p) => s + (p._spellFixCount ?? 0), 0);
      const correctionRate = totalPageWords > 0 ? totalFixed / totalPageWords : 0;

      if (correctionRate > 0 && priorStageName) {
        ctx.quality.perStage[priorStageName] = Math.round(priorScore * (1 - correctionRate) * 1000) / 1000;
        ctx.addDecision('s6', 'retroactive_adjust',
          `${priorStageName} adjusted ${priorScore.toFixed(3)} → ${ctx.quality.perStage[priorStageName].toFixed(3)} (${totalFixed}/${totalPageWords} words corrected)`);
      }
      // s6 quality = the un-adjusted prior (we corrected back up to it)
      ctx.recordStageQuality('s6', Math.min(1, Math.round(priorScore * 1000) / 1000));
    }

  } catch (err) {
    ctx.addError('s6', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s6', {
      pages_affected: pagesFixed, tokens_in: totalIn, tokens_out: totalOut,
      cost_usd: totalCost, approach, version: '1.0',
    });
  }

  return ctx;
}
