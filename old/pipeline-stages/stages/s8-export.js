// Stage 8: Export corrected text as Markdown with Hugo block-attribute page anchors.
// Exports: s8Export, adaptWord
//   s8Export(ctx) → ctx     — assembles Markdown from visionMd + bbox words + pdftotext fallback; writes .md file
//   adaptWord(w) → bboxWord — converts pipeline word {x1,y1,x2,y2} → ocr-reconstruct {bbox:{x0,y0,x1,y1}}
// CONTRACT:
//   Reads:  ctx.outputs.archivalPdfPath (fallback: ctx.sourcePath), ctx.pages[n].words, ctx.pages[n].visionMd
//   Writes: ctx.outputs.mdPath — Markdown with {pdf_page=N} Hugo block attributes per page
//   Format: paragraphs joined across lines; page-split paragraphs repaired; visionMd verbatim
// ERRORS: writeFileSync fail → recoverable; no content → writes anchor stubs only
// NOTE:   Pipeline words use {x1,y1,x2,y2}; ocr-reconstruct expects {bbox:{x0,y0,x1,y1}} — adaptWord converts
import { shouldRun } from '../config.js';
import { markHeadersFooters, bboxWordsToText } from '../../pdf-upgrade/ocr-reconstruct.js';
import { writeFileSync } from 'fs';

// Pipeline stores words as {text,x1,y1,x2,y2,conf}; ocr-reconstruct expects {text,bbox:{x0,y0,x1,y1},conf}
export const adaptWord = (w) => ({
  text: w.text,
  bbox: { x0: w.x1, y0: w.y1, x1: w.x2, y1: w.y2 },
  conf: w.conf,
});

// Parse raw pdftotext output into paragraph arrays, one entry per page.
// Returns: Array<string[]> — each element is an array of paragraph strings for that page.
function parsePageParas(rawText) {
  return rawText.split('\f').map(page => {
    const lines = page.split('\n');
    const paragraphs = [];
    let current = [];
    for (const line of lines) {
      if (!line.trim()) {
        if (current.length) {
          paragraphs.push(current.join(' ').replace(/  +/g, ' ').trim());
          current = [];
        }
      } else {
        current.push(line.trim());
      }
    }
    if (current.length) paragraphs.push(current.join(' ').replace(/  +/g, ' ').trim());
    return paragraphs.filter(Boolean);
  });
}

// Repair paragraphs split across page boundaries.
// Heuristic: if last para of page N doesn't end with sentence-ending punctuation
// and first para of page N+1 starts with lowercase → they're one paragraph.
// Also handles hyphenated line-breaks: "some-\n" + "word" → "someword".
function repairPageSplits(pageParas) {
  for (let i = 0; i < pageParas.length - 1; i++) {
    const curParas = pageParas[i];
    const nextParas = pageParas[i + 1];
    if (!curParas.length || !nextParas.length) continue;

    const last = curParas[curParas.length - 1];
    const first = nextParas[0];

    const endsHyphen = /\w-$/.test(last);
    const endsSentence = /[.!?:;]\s*$/.test(last);
    const nextStartsLower = /^[a-z]/.test(first);

    if (endsHyphen) {
      // De-hyphenate: "some-" + "thing" → "something"
      curParas[curParas.length - 1] = last.slice(0, -1) + first;
      nextParas.shift();
    } else if (!endsSentence && nextStartsLower) {
      // Continuation: join with space
      curParas[curParas.length - 1] = last + ' ' + first;
      nextParas.shift();
    }
  }
  return pageParas;
}

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

    // ── Path A: OCR words / vision MD from prior stages ───────────────────────
    const bboxPages = ctx.pages
      .filter(p => !p.visionMd && p.words?.length > 0)
      .map(p => ({ pageNo: p.pageNo, words: (p.words || []).map(adaptWord) }));

    if (bboxPages.length) markHeadersFooters(bboxPages);
    const bboxByPageNo = new Map(bboxPages.map(p => [p.pageNo, p]));

    const hasOcrContent = ctx.pages.some(p => p.visionMd || p.words?.length > 0);

    if (hasOcrContent) {
      for (const page of ctx.pages) {
        mdParts.push(`{pdf_page=${page.pageNo}}`);
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

    // ── Path B: Text-layer PDF — OCR stages were skipped, extract via pdftotext ─
    } else if (ctx.quality.baseline?.has_text_layer === 1 && ctx.pages.length > 0) {
      try {
        const { stdout } = await ctx.run('pdftotext', ['-layout', ctx.sourcePath, '-'], { timeout: 30000 });
        const pageParas = repairPageSplits(parsePageParas(stdout));

        for (let i = 0; i < ctx.pages.length; i++) {
          const page = ctx.pages[i];
          mdParts.push(`{pdf_page=${page.pageNo}}`);
          const paras = pageParas[i] ?? [];
          if (paras.length) {
            mdParts.push(paras.join('\n\n'));
            pagesAffected++;
          }
        }

        notes = `pdftotext_extract:${pagesAffected}p`;
        ctx.addDecision('s8', 'pdftotext_extract', `text_layer_pdf → pdftotext -layout`, pagesAffected);
        if (pagesAffected) ctx.recordStageQuality('s8', 0.9);

      } catch (e) {
        // pdftotext unavailable — fall through to anchor stubs
        for (const page of ctx.pages) mdParts.push(`{pdf_page=${page.pageNo}}`);
        ctx.addDecision('s8', 'fallback', `pdftotext failed: ${e.message}`);
        notes = `pdftotext_failed: ${e.message}`;
      }

    // ── Path C: No content — anchor stubs only ────────────────────────────────
    } else {
      for (const page of ctx.pages) mdParts.push(`{pdf_page=${page.pageNo}}`);
      ctx.addDecision('s8', 'fallback', 'no content from any stage — anchor stubs only');
      notes = 'no_content';
    }

    writeFileSync(outPath, mdParts.join('\n\n'), 'utf8');
    ctx.addDecision('s8', 'wrote_md', hasOcrContent ? 'ocr_words' : 'text_layer', outPath);

    // Record output quality
    const allWords = ctx.pages.flatMap(p => p.visionMd ? [] : (p.words ?? []));
    const visPageCount = ctx.pages.filter(p => p.visionMd).length;
    const cleanWords = allWords.filter(w => w.conf >= 90).length;
    const cleanRatio = allWords.length > 0 ? cleanWords / allWords.length : (visPageCount > 0 ? 0.9 : 0);
    const totalPagesWithContent = pagesAffected;
    const visBonus = totalPagesWithContent > 0 ? (visPageCount / totalPagesWithContent) * 0.1 : 0;
    const outputQuality = Math.min(cleanRatio + visBonus, 1);
    if (hasOcrContent) ctx.recordStageQuality('s8', Math.round(outputQuality * 100) / 100);

  } catch (err) {
    ctx.addError('s8', err, true);
    notes = `error: ${err.message}`;
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s8', { pages_affected: pagesAffected, notes });
  }

  return ctx;
}
