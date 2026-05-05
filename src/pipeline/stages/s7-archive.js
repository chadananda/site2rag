// Stage 7: Archival PDF assembly — embed corrected text layer, output PDF/A-3.
// Exports: s7Archive. Deps: rebuild.js (ocrmypdf wrapper)
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pages[n].words (corrected), ctx.meta
//   Writes: ctx.outputs.archivalPdfPath
//   Format: PDF/A-3 with XMP metadata; original page images preserved

import { rebuildPdf } from '../../pdf-upgrade/rebuild.js';
import { shouldRun } from '../config.js';

export async function s7Archive(ctx) {
  if (!shouldRun('s7', ctx)) return ctx;

  ctx.beginStage('s7');
  let notes = null;

  try {
    if (!ctx.sourcePath) throw new Error('no sourcePath');

    // TODO: pass corrected words from ctx.pages into rebuildPdf once s3-ocr is implemented.
    // For now, rebuild using existing ocrmypdf flow (no word-level correction injected yet).
    const outPath = ctx.sourcePath.replace(/\.pdf$/i, '_archival.pdf');

    const result = await rebuildPdf(ctx.sourcePath, outPath, null, {
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
