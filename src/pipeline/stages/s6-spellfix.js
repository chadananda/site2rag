// Stage 6: LLM spell-fix on fuzzy-confidence words only. Bbox-preserving.
// Exports: s6SpellFix. Deps: spell-fix.js, config.js
import { spellFixWordObjects } from '../../pdf-upgrade/spell-fix.js';
import { shouldRun, withinBudget } from '../config.js';

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

    // Don't waste tokens on docs too broken for cheap correction
    const baseline = ctx.quality.baseline?.composite_score ?? 0;
    const spellMin = ctx.config.thresholds?.spellFixMin ?? 0.45;
    if (baseline < spellMin) {
      ctx.addDecision('s6', 'skip',
        `baseline ${baseline.toFixed(3)} < min ${spellMin} — too broken for spell-fix`, baseline);
      return ctx;
    }

    const fuzzyLow = (ctx.config.thresholds?.fuzzyWord ?? 0.60) * 100;
    const cleanHigh = (ctx.config.thresholds?.cleanPage ?? 0.90) * 100;

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
        pageNo: page.pageNo,
        totalPages: ctx.pageCount,
      });

      // Merge corrections back into page.words by rebuilding the list.
      // result.words has corrected text + adjusted bboxes for same-line merges.
      // Build a lookup from original text position via srcIdx tracking.
      const correctedByText = new Map();
      for (const w of result.words) correctedByText.set(w._srcIdx, w);

      // Replace fuzzy words with corrections; leave non-fuzzy words untouched
      let fixedCount = 0;
      const nextWords = [];
      let fuzzyIdx = 0;
      for (const w of page.words) {
        const conf = w.conf ?? 100;
        if (conf >= fuzzyLow && conf < cleanHigh) {
          const corrected = result.words[fuzzyIdx++];
          if (corrected) {
            nextWords.push({ ...corrected, source: `${w.source ?? 'ocr'}+spellfix` });
            if (corrected.text !== w.text) fixedCount++;
          }
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
