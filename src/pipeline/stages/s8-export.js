// Stage 8: Export corrected text as Markdown with Hugo block-attribute page anchors.
// Exports: s8Export, adaptWord
//   s8Export(ctx) → ctx     — assembles Markdown from visionMd + bbox words; writes .md file
//   adaptWord(w) → bboxWord — converts pipeline word {x1,y1,x2,y2} → ocr-reconstruct {bbox:{x0,y0,x1,y1}}
// CONTRACT:
//   Reads:  ctx.outputs.archivalPdfPath (fallback: ctx.sourcePath), ctx.pages[n].words, ctx.pages[n].visionMd
//   Writes: ctx.outputs.mdPath — Markdown with {#p-N} Hugo block attributes per page
//   Format: paragraphs joined across lines; page headers wrapped in HTML comments; visionMd verbatim
// ERRORS: writeFileSync fail → recoverable; no content → writes anchor stubs only
// NOTE:   Pipeline words use {x1,y1,x2,y2}; ocr-reconstruct expects {bbox:{x0,y0,x1,y1}} — adaptWord converts
import { shouldRun } from '../config.js';                                           // shouldRun(stage,ctx)→bool
import { markHeadersFooters, bboxWordsToText } from '../../pdf-upgrade/ocr-reconstruct.js'; // markHeadersFooters(pages) mutates words.isHeader/isFooter; bboxWordsToText(pages)→string
import { writeFileSync } from 'fs';

// Pipeline stores words as {text,x1,y1,x2,y2,conf}; ocr-reconstruct expects {text,bbox:{x0,y0,x1,y1},conf}
export const adaptWord = (w) => ({
  text: w.text,
  bbox: { x0: w.x1, y0: w.y1, x1: w.x2, y1: w.y2 },
  conf: w.conf,
});

export async function s8Export(ctx) {
  if (!shouldRun('s8', ctx)) return ctx;

  ctx.beginStage('s8');
  let notes = null;
  let pagesAffected = 0;

  try {
    const basePath = ctx.outputs.archivalPdfPath ?? ctx.sourcePath;
    if (!basePath) throw new Error('no PDF path for export');

    const outPath = basePath.replace(/\.pdf$/i, '.md');
    ctx.outputs.mdPath = outPath;

    const mdParts = [];

    // Separate pages into vision pages and bbox pages for different processing paths
    const bboxPages = ctx.pages
      .filter(p => !p.visionMd && p.words?.length > 0)
      .map(p => ({ pageNo: p.pageNo, words: (p.words || []).map(adaptWord) }));

    // Run header/footer detection only on bbox pages
    if (bboxPages.length) markHeadersFooters(bboxPages);
    const bboxByPageNo = new Map(bboxPages.map(p => [p.pageNo, p]));

    const hasAnyContent = ctx.pages.some(p => p.visionMd || p.words?.length > 0);

    if (hasAnyContent) {
      for (const page of ctx.pages) {
        mdParts.push(`{#p-${page.pageNo}}`);
        if (page.visionMd) {
          mdParts.push(page.visionMd.trim());
          pagesAffected++;
        } else {
          const bboxPage = bboxByPageNo.get(page.pageNo);
          if (bboxPage) {
            const bodyWords = bboxPage.words.filter(w => !w.isHeader && !w.isFooter && w.text?.trim());
            if (bodyWords.length) {
              const pageText = bboxWordsToText([{ pageNo: page.pageNo, words: bodyWords }]);
              if (pageText.trim()) { mdParts.push(pageText.trim()); pagesAffected++; }
            }
          }
        }
      }
      notes = `bbox_words:${pagesAffected}p`;
    } else {
      // No content at all — write anchor stubs so the file is valid
      for (const page of ctx.pages) mdParts.push(`{#p-${page.pageNo}}`);
      ctx.addDecision('s8', 'fallback', 'no bbox words from s3 — anchor stubs only');
      notes = 'no_words_from_s3';
    }

    writeFileSync(outPath, mdParts.join('\n\n'), 'utf8');
    ctx.addDecision('s8', 'wrote_md', hasAnyContent ? 'bbox_words' : 'stub', outPath);

    // Record output quality: vision pages count as high quality; bbox pages use clean-word ratio
    const allWords = ctx.pages.flatMap(p => p.visionMd ? [] : (p.words ?? []));
    const visPageCount = ctx.pages.filter(p => p.visionMd).length;
    const cleanWords = allWords.filter(w => w.conf >= 90).length;
    const cleanRatio = allWords.length > 0 ? cleanWords / allWords.length : (visPageCount > 0 ? 0.9 : 0);
    const totalPagesWithContent = pagesAffected;
    const visBonus = totalPagesWithContent > 0 ? (visPageCount / totalPagesWithContent) * 0.1 : 0;
    const outputQuality = Math.min(cleanRatio + visBonus, 1);
    if (hasAnyContent) ctx.recordStageQuality('s8', Math.round(outputQuality * 100) / 100);

  } catch (err) {
    ctx.addError('s8', err, true);
    notes = `error: ${err.message}`;
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s8', { pages_affected: pagesAffected, notes });
  }

  return ctx;
}
