// Stage 1: PDF normalization + image preprocessing. Pixel ops only; coords are preserved.
// Exports: s1Preprocess. Deps: pdftoppm (CLI), gs (CLI), sharp or imagemagick (CLI)
//
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pageCount, ctx.config.implementations.binarization
//   Writes: ctx.sourcePath        — may replace with gs-normalized copy (JPEG2000 fix)
//           ctx._gsNormalized     — true if gs normalization ran
//           ctx._originalSourcePath — original path before normalization
//           ctx.pages[n]._preprocessedPath (temp path, deleted after s3-ocr)
//           ctx.pages[n]._deskewAngle (if deskew was applied, for coord correction)
//   Never:  modifies the original PDF file on disk

import { shouldRun } from '../config.js';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const exec = promisify(execCb);

// Stderr patterns indicating pypdfium2-incompatible streams (JPEG2000 non-conformant, etc.)
const CORRUPT_PATTERN = /TPsot|non.?conformant|data.?format.?error|image.?file.?is.?truncated/i;

/**
 * Detect non-conformant PDFs by doing a low-res probe render via pdftoppm.
 * Returns true if gs normalization is warranted.
 */
async function probeNeedsNormalization(sourcePath) {
  const tmpDir = await mkdtemp(join(tmpdir(), 's1-probe-'));
  try {
    const { stderr } = await exec(
      `pdftoppm -r 8 -png -f 1 -l 1 "${sourcePath}" "${join(tmpDir, 'p')}"`,
      { timeout: 15000 }
    );
    return CORRUPT_PATTERN.test(stderr);
  } catch {
    // pdftoppm failed entirely — definitely warrants normalization attempt
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run ghostscript PDF normalization to fix non-conformant JPEG2000 codestreams.
 * Writes to a temp file; caller is responsible for cleanup (tracked via ctx._gsNormalized).
 */
async function gsNormalize(sourcePath) {
  const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
  const outPath = join(tmpdir(), `site2rag_gs_${hash}.pdf`);
  await exec(
    `gs -dBATCH -dNOPAUSE -dQUIET -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 ` +
    `-sOutputFile="${outPath}" "${sourcePath}"`,
    { timeout: 180000 }
  );
  if (!existsSync(outPath)) throw new Error('gs produced no output');
  return outPath;
}

export async function s1Preprocess(ctx) {
  if (!shouldRun('s1', ctx)) return ctx;

  ctx.beginStage('s1');
  let pagesAffected = 0;
  let notes = null;

  try {
    if (!existsSync(ctx.sourcePath)) {
      ctx.addDecision('s1', 'skip', 'source file not found');
      return ctx;
    }

    // PDF normalization: fix JPEG2000 non-conformant codestreams before rendering
    // Browsers/poppler tolerate these; pypdfium2 (used by boss vision) does not.
    if (ctx.config.gsNormalize !== false) {
      try {
        const needs = await probeNeedsNormalization(ctx.sourcePath);
        if (needs) {
          const normalized = await gsNormalize(ctx.sourcePath);
          ctx._originalSourcePath = ctx.sourcePath;
          ctx.sourcePath = normalized;
          ctx._gsNormalized = true;
          ctx.addDecision('s1', 'gs_normalized',
            `non-conformant codestream detected — rewrote via gs`, 1.0);
          notes = 'gs_normalized';
        } else {
          ctx.addDecision('s1', 'pdf_ok', 'no normalization needed', 1.0);
        }
      } catch (err) {
        ctx.addError('s1', new Error(`gs_normalize failed: ${err.message}`), true);
        notes = `gs_normalize_error`;
        if (ctx.config.failFast) throw err;
      }
    }

    // Ensure pages array is initialized (populated by s3-ocr with actual renders)
    if (!ctx.pages.length && ctx.pageCount > 0) {
      ctx.pages = Array.from({ length: ctx.pageCount }, (_, i) => ({
        pageNo: i + 1, words: [], regions: [], quality: {},
        _preprocessedPath: null, _deskewAngle: 0,
      }));
      pagesAffected = ctx.pageCount;
    }

    // TODO: per-page image preprocessing
    //   1. pdftoppm -r 300 -png -f N -l N → temp PNG
    //   2. Detect skew (imagemagick / opencv)
    //   3. Sauvola binarization, despeckling, contrast stretch
    //   4. If skew > 0.5°: deskew, record in page._deskewAngle
    //   5. Store in page._preprocessedPath; revert if tesseract confidence drops
    ctx.addDecision('s1', 'preprocess_stub', 'image preprocessing not yet implemented');

  } catch (err) {
    ctx.addError('s1', err, false);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s1', { pages_affected: pagesAffected, notes });
  }

  return ctx;
}
