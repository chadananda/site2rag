// Stage 3: Rasterize PDF pages with pdftoppm, OCR with Tesseract hOCR for word-level bboxes.
// Exports: s3Ocr, parseHocr. Deps: pdftoppm CLI, tesseract CLI, surya_ocr CLI, config.js
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pages[n].regions[0].type, ctx.meta?.language
//           ctx.config.rasterDpi (default 300), ctx.config.s3Lang (override lang)
//           ctx.config.s3Engine ('tesseract'|'surya'|'multi'), ctx.config.preprocessing
//   Writes: ctx.pages[n].words, ctx.pages[n]._pngPath, ctx.pages[n]._bucketed, ctx.pages[n]._lang

import { shouldRun } from '../config.js';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);

/** Map region type / meta language to Tesseract lang string. */
function resolveLang(regionType, metaLang, configLang) {
  if (configLang) return configLang;
  if (regionType === 'printed_arabic' || metaLang === 'ar' || metaLang === 'ara') return 'ara';
  if (regionType === 'printed_persian' || metaLang === 'fa' || metaLang === 'fas' || metaLang === 'per') return 'fas';
  if (regionType === 'printed_french' || metaLang === 'fr' || metaLang === 'fra' || metaLang === 'french') return 'fra';
  if (regionType === 'printed_cjk') return 'chi_sim+jpn';
  return 'eng';
}

/** Parse Tesseract hOCR output into word objects. */
export function parseHocr(hocr, pageNo) {
  const words = [];
  const re = /<span[^>]+class='(?:ocr|ocrx)_word'[^>]+title='([^']*)'[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(hocr)) !== null) {
    const title = m[1];
    const inner = m[2];
    const bboxM = title.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const x1 = parseInt(bboxM[1]), y1 = parseInt(bboxM[2]), x2 = parseInt(bboxM[3]), y2 = parseInt(bboxM[4]);
    const confM = title.match(/x_wconf\s+(\d+)/);
    const conf = confM ? parseInt(confM[1]) : 0;
    const raw = inner.replace(/<[^>]+>/g, '');
    const text = raw
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
      .trim();
    if (!text) continue;
    words.push({ text, x1, y1, x2, y2, conf, source: 'tesseract', pageNo });
  }
  return words;
}

/** Apply preprocessing to a PNG using unpaper and/or contrast stretch via gs. */
async function preprocessPng(pngPath, outPath, opts = {}) {
  const { unpaper: useUnpaper, forceContrast } = opts;
  let current = pngPath;

  if (useUnpaper) {
    const unpaperedPath = outPath.replace('.png', '_unpaper.png');
    try {
      await execFileAsync('unpaper', [
        '--overwrite', '--dpi', '300',
        '--layout', 'single',
        '--no-blackfilter', '--no-grayfilter',
        current, unpaperedPath,
      ], { timeout: 30000 });
      current = unpaperedPath;
    } catch { /* unpaper failed — continue with original */ }
  }

  if (forceContrast) {
    const contrastedPath = outPath.replace('.png', '_contrast.png');
    try {
      // Use gs to stretch contrast: normalize levels
      await execFileAsync('gs', [
        '-dNOPAUSE', '-dBATCH', '-dSAFER',
        '-sDEVICE=pngmono', '-r300',
        `-sOutputFile=${contrastedPath}`,
        current,
      ], { timeout: 30000 });
      if (existsSync(contrastedPath)) current = contrastedPath;
    } catch {
      // Try with ImageMagick if available
      try {
        await execFileAsync('convert', [current, '-normalize', '-threshold', '50%', contrastedPath], { timeout: 15000 });
        if (existsSync(contrastedPath)) current = contrastedPath;
      } catch { /* ignore */ }
    }
  }

  return current;
}

/** Run Surya OCR on a PNG, return words array. Surya outputs JSON to stdout. */
async function runSurya(pngPath, pageNo) {
  const suryaBin = process.env.SURYA_PATH ?? 'surya_ocr';
  try {
    const { stdout } = await execFileAsync(suryaBin, [pngPath, '--json'], {
      timeout: 120000, maxBuffer: 20 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    const words = [];
    for (const page of (result.pages ?? result ?? [])) {
      for (const block of (page.text_lines ?? [])) {
        const text = block.text?.trim();
        if (!text) continue;
        const bbox = block.bbox ?? block.bounding_box ?? {};
        words.push({
          text, conf: Math.round((block.confidence ?? 0.8) * 100),
          x1: bbox.x_min ?? 0, y1: bbox.y_min ?? 0,
          x2: bbox.x_max ?? 0, y2: bbox.y_max ?? 0,
          source: 'surya', pageNo,
        });
      }
    }
    return words;
  } catch {
    return [];
  }
}

/** Merge Tesseract + Surya words: per-word, take higher confidence. Simple union by position. */
function mergeEngineOutputs(tessWords, suryaWords) {
  if (!tessWords.length) return suryaWords;
  if (!suryaWords.length) return tessWords;
  // Use Tesseract as base (has bbox precision), supplement with Surya for low-conf regions
  const merged = [...tessWords];
  const avgTessConf = tessWords.reduce((s, w) => s + w.conf, 0) / tessWords.length;
  const avgSuryaConf = suryaWords.reduce((s, w) => s + w.conf, 0) / suryaWords.length;
  // If Surya is substantially better overall, prefer it
  if (avgSuryaConf > avgTessConf + 15) return suryaWords;
  return merged;
}

export async function s3Ocr(ctx) {
  if (!shouldRun('s3', ctx)) return ctx;

  ctx.beginStage('s3');
  let pagesAffected = 0;
  const routingSummary = {};
  const cleanT = (ctx.config.thresholds?.cleanPage ?? 0.90) * 100;
  const fuzzyT = (ctx.config.thresholds?.fuzzyWord ?? 0.60) * 100;
  const dpi = ctx.config.rasterDpi ?? 300;
  const engine = ctx.config.s3Engine ?? 'tesseract';
  const preprocessing = ctx.config.preprocessing ?? {};
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 16);
  const tmpDir = join(tmpdir(), `site2rag-s3-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Rasterize all pages in parallel, then OCR sequentially
    const rasterPromises = ctx.pages.map(async page => {
      if (page.regions?.length && page.regions.every(r => r.type === 'figure')) return;
      const outBase = join(tmpDir, `p${page.pageNo}`);
      const pngPath = `${outBase}.png`;
      if (!existsSync(pngPath)) {
        await execFileAsync('pdftoppm', [
          '-png', '-r', String(dpi), '-f', String(page.pageNo), '-l', String(page.pageNo),
          '-singlefile', ctx.sourcePath, outBase,
        ], { timeout: 60000 });
      }
      // Apply preprocessing if configured
      if (preprocessing.unpaper || preprocessing.forceContrast) {
        const preprocPath = await preprocessPng(pngPath, outBase + '_preproc.png', preprocessing);
        page._pngPath = preprocPath;
      } else {
        page._pngPath = pngPath;
      }
    });
    await Promise.all(rasterPromises);

    for (const page of ctx.pages) {
      try {
        if (page.regions?.length && page.regions.every(r => r.type === 'figure')) {
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
          continue;
        }
        if (!page._pngPath || !existsSync(page._pngPath)) {
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
          continue;
        }

        const regionType = page.regions?.[0]?.type ?? null;
        const lang = resolveLang(regionType, ctx.meta?.language, ctx.config.s3Lang);
        page._lang = lang;
        routingSummary[lang] = (routingSummary[lang] ?? 0) + 1;

        let words = [];

        if (engine === 'surya') {
          words = await runSurya(page._pngPath, page.pageNo);
        } else if (engine === 'multi') {
          // Run Tesseract and Surya in parallel
          const [tessResult, suryaResult] = await Promise.all([
            execFileAsync('tesseract', [page._pngPath, 'stdout', 'hocr', '-l', lang], {
              timeout: 120000, maxBuffer: 20 * 1024 * 1024,
            }).then(r => parseHocr(r.stdout, page.pageNo)).catch(() => []),
            runSurya(page._pngPath, page.pageNo),
          ]);
          words = mergeEngineOutputs(tessResult, suryaResult);
        } else {
          // Default: Tesseract
          const { stdout } = await execFileAsync('tesseract', [page._pngPath, 'stdout', 'hocr', '-l', lang], {
            timeout: 120000, maxBuffer: 20 * 1024 * 1024,
          });
          words = parseHocr(stdout, page.pageNo);
        }

        page.words = words;
        let clean = 0, fuzzy = 0, dirty = 0;
        for (const w of words) {
          if (w.conf >= cleanT) clean++;
          else if (w.conf >= fuzzyT) fuzzy++;
          else dirty++;
        }
        page._bucketed = { clean, fuzzy, dirty, needs_vision: 0 };
        if (words.length > 0) pagesAffected++;
      } catch (pageErr) {
        ctx.addError('s3', pageErr, true);
        page.words = [];
        page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
      }
    }
    ctx.addDecision('s3', 'routing_summary', JSON.stringify(routingSummary));
  } catch (err) {
    ctx.addError('s3', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s3', {
      pages_affected: pagesAffected,
      notes: Object.keys(routingSummary).join(', ') || null,
    });
  }

  return ctx;
}
