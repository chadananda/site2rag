// Stage 2: Per-page region classification via cheap Haiku call on low-res thumbnail.
// Exports: s2Classify. Deps: Anthropic SDK, pdftoppm (CLI)
// CONTRACT:
//   Reads:  ctx.pages, ctx.config.escalation.regionClassify, ctx.importance
//   Writes: ctx.pages[n].regions = [{type, bbox:[x1,y1,x2,y2]}]
//           Valid types: printed_latin, printed_arabic, printed_persian, printed_cjk,
//                        handwritten, table, figure, degraded
//   Cost:   ~$0.002/page, result cached permanently (compare with ctx.pages[n]._regionsVersion)

import { shouldRun } from '../config.js';

export async function s2Classify(ctx) {
  if (!shouldRun('s2', ctx)) return ctx;

  ctx.beginStage('s2');
  let pagesAffected = 0, totalCost = 0, totalIn = 0, totalOut = 0;

  try {
    // TODO: implement
    // For each page:
    //   1. Render 100dpi JPEG thumbnail (cheap)
    //   2. Send to Haiku with structured output prompt requesting region JSON
    //   3. Cache result on page._regionsVersion to avoid re-classifying unchanged pages
    //   4. For docs with meta.language != 'en', boost probability of non-latin region types
    // Fallback: if Haiku unavailable or importance < gate, classify entire page as single region
    //   using meta.language to pick type (printed_arabic if lang=ar, etc.)
    ctx.addDecision('s2', 'stub', 'not yet implemented — defaulting to full-page printed_latin');

    const defaultType = langToRegionType(ctx.meta?.language);
    for (const page of ctx.pages) {
      if (!page.regions?.length) {
        page.regions = [{ type: defaultType, bbox: null }];  // null bbox = full page
      }
      pagesAffected++;
    }

  } catch (err) {
    ctx.addError('s2', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s2', { pages_affected: pagesAffected, tokens_in: totalIn,
      tokens_out: totalOut, cost_usd: totalCost });
  }

  return ctx;
}

const langToRegionType = (lang) => {
  if (!lang) return 'printed_latin';
  if (['ar', 'ara'].includes(lang)) return 'printed_arabic';
  if (['fa', 'fas', 'per'].includes(lang)) return 'printed_persian';
  if (['zh', 'ja', 'ko'].includes(lang)) return 'printed_cjk';
  return 'printed_latin';
};
