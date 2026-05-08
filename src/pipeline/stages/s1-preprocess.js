// Stage 1: PDF normalization + per-page image preprocessing (deskew/despeckle via unpaper).
// Exports: s1Preprocess, CORRUPT_PATTERN
//   s1Preprocess(ctx) → ctx  — normalizes PDF if JPEG2000 non-conformant; runs unpaper per page
//   CORRUPT_PATTERN           — regex matching pdftoppm stderr on corrupt codestreams
// CONFIG: gsNormalize:true    — false skips gs normalization entirely
//         s1Preprocess:true   — false skips unpaper per-page preprocessing
//         toolBackends        — route pdftoppm|gs|unpaper|convert to http backend
//         toolPaths           — override binary paths
// ERRORS: pdftoppm ENOENT → recoverable (s1 preprocessing error surfaced, pipeline continues)
//         gs normalize fail   → recoverable (gs_normalize_error in notes)
//         unpaper ENOENT      → recoverable (halts per-page loop, surfaces error)
//         convert ENOENT      → recoverable
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pageCount, ctx.config.gsNormalize, ctx.config.s1Preprocess
//   Writes: ctx.sourcePath        — may replace with gs-normalized copy (JPEG2000 fix)
//           ctx._gsNormalized     — true if gs normalization ran
//           ctx._originalSourcePath — original path before normalization
//           ctx.pages[n]._preprocessedPath (temp path, deleted after s3-ocr)
//           ctx.pages[n]._deskewAngle (if deskew was applied, for coord correction)
//   Never:  modifies the original PDF file on disk
import { shouldRun } from '../config.js';                            // shouldRun(stage,ctx)→bool
import { existsSync, rmSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { getTmpDir } from '../../config.js';
// ── config defaults ──────────────────────────────────────────────────────────
const D_PREPROCESS_DPI = 300;   // rasterDpi for unpaper input

// Stderr patterns indicating pypdfium2-incompatible streams (JPEG2000 non-conformant, etc.)
export const CORRUPT_PATTERN = /TPsot|non.?conformant|data.?format.?error|image.?file.?is.?truncated/i;

/** Detect non-conformant PDFs by doing a low-res probe render via pdftoppm. Returns true if gs normalization is warranted. */
async function probeNeedsNormalization(sourcePath, ctx) {
  const tmpDir = await mkdtemp(join(getTmpDir(), 's1-probe-'));
  try {
    const { stderr } = await ctx.run('pdftoppm', ['-r', '8', '-png', '-f', '1', '-l', '1', sourcePath, join(tmpDir, 'p')], { timeout: 15000 });
    return CORRUPT_PATTERN.test(stderr ?? '');
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    return true; // pdftoppm failed → try normalization
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run ghostscript PDF normalization to fix non-conformant JPEG2000 codestreams. Writes to a temp file; caller tracks via ctx._gsNormalized. */
async function gsNormalize(sourcePath, ctx) {
  const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
  const outPath = join(getTmpDir(), `site2rag_gs_${hash}.pdf`);
  await ctx.run('gs', [
    '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
    `-sOutputFile=${outPath}`, sourcePath,
  ], { timeout: 180000 });
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
        const needs = await probeNeedsNormalization(ctx.sourcePath, ctx);
        if (needs) {
          const normalized = await gsNormalize(ctx.sourcePath, ctx);
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

    // Per-page unpaper preprocessing (skipped if s1Preprocess === false)
    if (ctx.config.s1Preprocess !== false && ctx.pages.length > 0) {
      let preprocessed = 0;
      let toolMissing = null;
      for (const page of ctx.pages) {
        if (toolMissing) break; // stop retrying once a tool is confirmed absent
        try {
          const hash = createHash('sha1').update(ctx.sourcePath + page.pageNo).digest('hex');
          const outBase = join(getTmpDir(), 'site2rag-s1-' + hash.slice(0, 12) + '-p' + page.pageNo);
          const ppmPath = `${outBase}.ppm`;
          const cleanPpmPath = `${outBase}_clean.ppm`;
          const cleanPngPath = `${outBase}_clean.png`;
          // Remove stale temp files from prior runs — unpaper refuses to overwrite
          for (const p of [ppmPath, cleanPpmPath, cleanPngPath]) {
            if (existsSync(p)) { rmSync(p); }
          }
          await ctx.run('pdftoppm', ['-r', String(D_PREPROCESS_DPI), '-f', String(page.pageNo), '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, outBase], { timeout: 60000 });
          if (existsSync(ppmPath)) {
            await ctx.run('unpaper', [ppmPath, cleanPpmPath], { timeout: 60000 });
            if (existsSync(cleanPpmPath)) {
              // Otsu binarize: best for aged paper/newspaper scans (vision-verified)
              await ctx.run('convert', [cleanPpmPath, '-colorspace', 'Gray', '-normalize', '-threshold', '45%', cleanPngPath], { timeout: 30000 });
              if (existsSync(cleanPngPath)) {
                page._preprocessedPath = cleanPngPath;
                preprocessed++;
              }
            }
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            toolMissing = err.path ?? err.message;
            ctx.addError('s1', new Error(`required tool not found: ${toolMissing} — install unpaper and imagemagick`), true);
          } else {
            ctx.addError('s1', new Error(`page ${page.pageNo} preprocessing failed: ${err.message}`), true);
          }
        }
      }
      ctx.addDecision('s1', 'preprocess', toolMissing
        ? `preprocessing halted: ${toolMissing} not installed`
        : `unpaper: ${preprocessed}/${ctx.pages.length} pages`);
    } else {
      ctx.addDecision('s1', 'preprocess', 'preprocessing skipped (s1Preprocess=false or no pages)');
    }

  } catch (err) {
    ctx.addError('s1', err, false);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s1', { pages_affected: pagesAffected, notes });
  }

  return ctx;
}
