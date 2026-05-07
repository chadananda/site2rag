// Stage 7: Archival PDF — embed corrected OCR text layer, output PDF/A-3b.
// Exports: s7Archive
//   s7Archive(ctx) → ctx  — assembles visionMd + word text into PDF text layer via ocrmypdf
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pages[n].visionMd, ctx.pages[n].words, ctx.meta
//   Writes: ctx.outputs.archivalPdfPath  — written to same dir as sourcePath
//   Format: PDF/A-3b with XMP metadata; original page images preserved; text layer searchable
// ERRORS: rebuildPdf fail → recoverable (error in notes); ctx.outputs.archivalPdfPath stays null
import { rebuildPdf } from '../../pdf-upgrade/rebuild.js'; // (srcPath,outPath,ocrResults?,meta)→{success,method,error?}
import { shouldRun } from '../config.js';                  // shouldRun(stage,ctx)→bool

export async function s7Archive(ctx) {
  if (!shouldRun('s7', ctx)) return ctx;

  ctx.beginStage('s7');
  let notes = null;

  try {
    if (!ctx.sourcePath) throw new Error('no sourcePath');

    const outPath = ctx.sourcePath.replace(/\.pdf$/i, '_archival.pdf');

    const ocrResults = ctx.pages
      .map(p => {
        if (p.visionMd) return { pageNo: p.pageNo, text_md: p.visionMd };
        if (p.words?.length) return { pageNo: p.pageNo, text_md: p.words.map(w => w.text).join(' ') };
        return null;
      })
      .filter(Boolean);

    const result = await rebuildPdf(ctx.sourcePath, outPath, ocrResults.length ? ocrResults : null, {
      title: ctx.meta?.title ?? '',
      author: Array.isArray(ctx.meta?.authors) ? ctx.meta.authors.join(', ') : (ctx.meta?.authors ?? ''),
      subject: ctx.meta?.description ?? '',
      keywords: ctx.meta?.language ?? '',
    });

    if (result.success) {
      ctx.outputs.archivalPdfPath = outPath;
      ctx.addDecision('s7', 'rebuilt', `method=${result.method}`, outPath);
      notes = `method:${result.method}`;
    } else {
      ctx.addError('s7', new Error(result.error ?? 'rebuild failed'), true);
      notes = `failed: ${result.error}`;
    }

  } catch (err) {
    ctx.addError('s7', err, true);
    notes = `error: ${err.message}`;
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s7', { pages_affected: ctx.pageCount, notes });
  }

  return ctx;
}
