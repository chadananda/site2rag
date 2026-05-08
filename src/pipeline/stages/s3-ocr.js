// Stage 3: PDF rasterization + Tesseract OCR + optional Surya batch secondary engine.
// Exports: s3Ocr, parseHocr, repairHyphens, resolveLang, cleanRatio
//   s3Ocr(ctx) → ctx        — rasterizes pages, runs Tesseract hOCR, optionally Surya batch
//   parseHocr(hocr,pageNo)  — Tesseract hOCR XML → word objects with trailing spaces
//   repairHyphens(words)    — joins line-break hyphens; appends trailing space to each word
//   resolveLang(regionType,metaLang) → tessLang string
//   cleanRatio(words,cleanT) → 0-1
// CONFIG: rasterDpi:300          — PNG raster DPI
//         s3Lang                 — override Tesseract lang (e.g. 'ara')
//         s3MultiEngine:[]       — ['surya'] adds Surya CLI batch after Tesseract
//         preprocessing.forceContrast:false — always enhance contrast
//         preprocessing.method   — 'clahe'|'adaptive'|'stretch'
//         thresholds.cleanPage:0.90 / fuzzyWord:0.60
//         toolBackends           — route pdftoppm|tesseract|surya_ocr to remote
// ERRORS: pdftoppm corrupt PNG → recoverable; tesseract fail → recoverable
//         surya_ocr ENOENT → recoverable; surya batch fail → recoverable
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pages[n].regions[0].type, ctx.meta.language
//   Writes: ctx.pages[n].words, ctx.pages[n]._pngPath, ctx.pages[n]._bucketed, ctx.pages[n]._lang
//           ctx.pages[n]._suryaText (string, if s3MultiEngine includes 'surya')
import { shouldRun } from '../config.js';                            // shouldRun(stage,ctx)→bool
import { execFile } from 'child_process';                            // for python3 (not routed through tool-runner)
import { promisify } from 'util';
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';
// ── config defaults ──────────────────────────────────────────────────────────
const D_RASTER_DPI  = 300;
const D_CLEAN_PAGE  = 0.90;
const D_FUZZY_WORD  = 0.60;
const D_SURYA_CHUNK = 20;   // pages per surya_ocr call — limits GPU memory

const execFileAsync = promisify(execFile); // used for python3 (not routed through tool-runner)
const PREPROCESS_PY = join(dirname(fileURLToPath(import.meta.url)), '..', 'preprocess_image.py');

// Map Tesseract lang codes → Surya lang codes
const TESS_TO_SURYA = { ara: 'ar', fas: 'fa', heb: 'he', chi_sim: 'zh', 'chi_sim+chi_tra': 'zh', jpn: 'ja', kor: 'ko', rus: 'ru', fra: 'fr', deu: 'de', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', pol: 'pl', tur: 'tr', eng: 'en' };

async function checkSuryaCli(ctx) {
  try {
    await ctx.run('surya_ocr', ['--help'], { timeout: 5000 });
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

async function runSuryaBatchS3(pages, ctx) {
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 12);
  const base = join(getTmpDir(), `site2rag-s3-surya-${docHash}`);
  const allPages = pages.filter(p => p._pngPath && existsSync(p._pngPath));

  for (let i = 0; i < allPages.length; i += D_SURYA_CHUNK) {
    const chunk = allPages.slice(i, i + D_SURYA_CHUNK);
    const chunkDir = `${base}-chunk${Math.floor(i / D_SURYA_CHUNK)}`;
    const outDir = chunkDir + '-out';
    mkdirSync(chunkDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    const pngMap = new Map();
    for (const page of chunk) {
      const filename = `page-${String(page.pageNo).padStart(4, '0')}.png`;
      writeFileSync(join(chunkDir, filename), readFileSync(page._pngPath));
      pngMap.set(filename, page);
    }

    const langs = [...new Set(chunk.map(p => TESS_TO_SURYA[p._lang] ?? 'en'))].join(',');
    try {
      await ctx.run('surya_ocr', [chunkDir, '--langs', langs, '--results_dir', outDir],
        { timeout: 300000 });
      const resultsPath = join(outDir, 'results.json');
      if (existsSync(resultsPath)) {
        const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
        for (const [filename, page] of pngMap) {
          const stem = basename(filename, '.png');
          const entry = results[stem] ?? results[filename];
          const pageResult = Array.isArray(entry) ? entry[0] : entry;
          const lines = pageResult?.text_lines ?? [];
          const text = lines.map(l => l.text ?? '').filter(Boolean).join('\n').trim();
          if (text) page._suryaText = text;
        }
      }
    } finally {
      try { rmSync(chunkDir, { recursive: true, force: true }); } catch {}
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// Map site2rag language key → Tesseract language code
const TESS_LANG = {
  arabic:     'ara',
  persian:    'fas',
  hebrew:     'heb',
  chinese:    'chi_sim+chi_tra',
  japanese:   'jpn',
  korean:     'kor',
  russian:    'rus',
  french:     'fra',
  german:     'deu',
  spanish:    'spa',
  italian:    'ita',
  portuguese: 'por',
  dutch:      'nld',
  polish:     'pol',
  turkish:    'tur',
  english:    'eng',
};
// ISO 639-1/2 codes → Tesseract lang code
const ISO_TESS = { fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol', tr: 'tur', ru: 'rus', ar: 'ara', fa: 'fas', he: 'heb', ja: 'jpn', zh: 'chi_sim', ko: 'kor' };

/** Map region type / meta language to Tesseract lang string. */
export function resolveLang(regionType, metaLang) {
  if (regionType === 'printed_arabic') return 'ara';
  if (regionType === 'printed_persian') return 'fas';
  if (regionType === 'printed_cjk') return 'chi_sim+jpn';
  if (metaLang) {
    const key = metaLang.toLowerCase();
    if (TESS_LANG[key]) return TESS_LANG[key];
    if (ISO_TESS[key]) return ISO_TESS[key];
  }
  return 'eng';
}

/**
 * Join line-break hyphens and append trailing space to every word.
 * Ensures search layers never see word runs at line boundaries.
 */
export function repairHyphens(words) {
  if (!words.length) return words;
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = { ...words[i] };
    if (w.text.endsWith('-') && i + 1 < words.length) {
      const next = words[i + 1];
      const frag = w.text.slice(0, -1);
      if (frag.length > 1 && /^[a-z\u00c0-\u024f]/i.test(next.text)) {
        out.push({ ...w, text: frag + next.text + ' ', x2: next.x2, conf: Math.min(w.conf, next.conf) });
        i += 2;
        continue;
      }
    }
    out.push({ ...w, text: w.text + ' ' });
    i++;
  }
  return out;
}

/** Parse Tesseract hOCR output into word objects with trailing spaces and hyphen repair. */
export function parseHocr(hocr, pageNo) {
  const raw_words = [];
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
    raw_words.push({ text, x1, y1, x2, y2, conf, source: 'tesseract', pageNo });
  }
  return repairHyphens(raw_words);
}

/** Score a word array by clean-word ratio (higher = better OCR quality). */
export function cleanRatio(words, cleanT) {
  if (!words.length) return 0;
  return words.filter(w => w.conf >= cleanT).length / words.length;
}

/** Try contrast enhancement via Python PIL. Returns enhanced PNG path or null if not needed/failed. */
async function tryEnhance(pngPath, enhancedPath, extraArgs = []) {
  try {
    const { stdout } = await execFileAsync('python3', [PREPROCESS_PY, ...extraArgs, pngPath, enhancedPath], {
      timeout: 30000,
    });
    const result = JSON.parse(stdout.trim());
    return result.enhanced ? { path: enhancedPath, ...result } : null;
  } catch {
    return null;
  }
}

/** Force contrast enhancement regardless of detection thresholds. */
async function tryEnhanceForced(pngPath, enhancedPath, extraArgs = []) {
  try {
    const { stdout } = await execFileAsync('python3', [PREPROCESS_PY, '--force', ...extraArgs, pngPath, enhancedPath], {
      timeout: 30000,
    });
    const result = JSON.parse(stdout.trim());
    return result.enhanced ? { path: enhancedPath, ...result } : null;
  } catch {
    return null;
  }
}

/** Run Tesseract hOCR on a PNG. Returns word array. */
async function runTesseract(pngPath, lang, pageNo, ctx) {
  const { stdout } = await ctx.run('tesseract', [pngPath, 'stdout', 'hocr', '-l', lang], {
    timeout: 120000, maxBuffer: 20 * 1024 * 1024,
  });
  return parseHocr(stdout, pageNo);
}

/** Run Tesseract layout pass (--psm 1) to get block bounding boxes from hOCR. */
async function runTesseractLayout(pngPath, lang, ctx) {
  const { stdout } = await ctx.run('tesseract', [pngPath, 'stdout', 'hocr', '--psm', '1', '-l', lang], {
    timeout: 60000, maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

/** Parse ocr_carea block bounding boxes from Tesseract hOCR. */
function parseHocrBlocks(hocr) {
  const blocks = [];
  const re = /<div[^>]+class='ocr_carea'[^>]+title='([^']*)'[^>]*>/g;
  let m;
  while ((m = re.exec(hocr)) !== null) {
    const bboxM = m[1].match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const x1 = parseInt(bboxM[1]), y1 = parseInt(bboxM[2]);
    const x2 = parseInt(bboxM[3]), y2 = parseInt(bboxM[4]);
    if (x2 - x1 < 50 || y2 - y1 < 40) continue; // skip tiny/noise regions
    blocks.push({ x1, y1, x2, y2 });
  }
  return blocks;
}

export async function s3Ocr(ctx) {
  if (!shouldRun('s3', ctx)) return ctx;

  ctx.beginStage('s3');
  let pagesAffected = 0;
  const routingSummary = {};
  let enhancedCount = 0;
  const cleanT = (ctx.config.thresholds?.cleanPage ?? D_CLEAN_PAGE) * 100;
  const fuzzyT = (ctx.config.thresholds?.fuzzyWord ?? D_FUZZY_WORD) * 100;
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 16);
  const tmpDir = join(getTmpDir(), `site2rag-s3-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });

  // Validate multi-engine config upfront — missing server URL is a config error
  try {
    for (const page of ctx.pages) {
      try {
        if (page.regions?.length && page.regions.every(r => r.type === 'figure')) {
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
          continue;
        }
        const regionType = page.regions?.[0]?.type ?? null;
        const lang = ctx.config.s3Lang ?? resolveLang(regionType, ctx.meta?.language);
        page._lang = lang;
        routingSummary[lang] = (routingSummary[lang] ?? 0) + 1;

        // Rasterize page — DPI configurable (300 default, 600 for high-res variant)
        const dpi = ctx.config.rasterDpi ?? D_RASTER_DPI;
        const outBase = join(tmpDir, `p${page.pageNo}`);
        const pngPath = `${outBase}.png`;
        if (!existsSync(pngPath)) {
          await ctx.run('pdftoppm', [
            '-png', '-r', String(dpi), '-f', String(page.pageNo), '-l', String(page.pageNo),
            '-singlefile', ctx.sourcePath, outBase,
          ], { timeout: 60000 });
        }
        if (existsSync(pngPath) && statSync(pngPath).size < 100) {
          throw new Error(`pdftoppm produced corrupt PNG for page ${page.pageNo}`);
        }
        page._pngPath = pngPath;

        // Layout detection pass at 72dpi — fast, just for block bounding boxes
        const D_LAYOUT_DPI = 72;
        const layoutBase = join(tmpDir, `p${page.pageNo}_layout`);
        const layoutPng = `${layoutBase}.png`;
        let blocks = [];
        try {
          if (!existsSync(layoutPng)) {
            await ctx.run('pdftoppm', [
              '-png', '-r', String(D_LAYOUT_DPI), '-f', String(page.pageNo),
              '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, layoutBase,
            ], { timeout: 30000 });
          }
          if (existsSync(layoutPng)) {
            const layoutHocr = await runTesseractLayout(layoutPng, lang, ctx);
            blocks = parseHocrBlocks(layoutHocr);
          }
        } catch { /* layout pass failure is non-fatal — fall back to full page */ }

        // Build preprocessing args from scan issues detected in s0
        const prepCfg = ctx.config.preprocessing ?? {};
        const forceContrast = prepCfg.forceContrast ?? false;
        const scanIssues = ctx._scanIssues ?? [];
        const issueArgs = scanIssues.length ? ['--issues', scanIssues.join(',')] : [];
        const methodArgs = prepCfg.method ? ['--method', prepCfg.method] : [];
        const extraArgs = [...issueArgs, ...methodArgs];

        const MIN_BLOCKS = 2; // need at least 2 blocks to bother splitting
        const useBlocks = blocks.length >= MIN_BLOCKS;
        const dpiScale = dpi / D_LAYOUT_DPI;

        let words;

        if (useBlocks) {
          // Per-block OCR: crop each block, preprocess, OCR, offset coordinates back
          const allBlockWords = [];
          for (let bi = 0; bi < blocks.length; bi++) {
            const blk = blocks[bi];
            const bx1 = Math.floor(blk.x1 * dpiScale), by1 = Math.floor(blk.y1 * dpiScale);
            const bx2 = Math.ceil(blk.x2  * dpiScale), by2 = Math.ceil(blk.y2  * dpiScale);
            const bw = bx2 - bx1, bh = by2 - by1;
            const blockRaw = join(tmpDir, `p${page.pageNo}_b${bi}.png`);
            try {
              await ctx.run('convert', [
                pngPath, '-crop', `${bw}x${bh}+${bx1}+${by1}`, '+repage', blockRaw,
              ], { timeout: 15000 });
              if (!existsSync(blockRaw)) continue;

              // Preprocess the block image using scan issue hints
              const blockEnh = join(tmpDir, `p${page.pageNo}_b${bi}_enh.png`);
              const enhancement = forceContrast
                ? await tryEnhanceForced(blockRaw, blockEnh, extraArgs)
                : await tryEnhance(blockRaw, blockEnh, extraArgs);
              const blockToOcr = (enhancement?.path) ?? blockRaw;

              const blockWords = await runTesseract(blockToOcr, lang, page.pageNo, ctx);
              // Shift word coordinates back to full-page space
              for (const w of blockWords) {
                allBlockWords.push({ ...w, x1: w.x1 + bx1, y1: w.y1 + by1, x2: w.x2 + bx1, y2: w.y2 + by1 });
              }
            } catch { /* skip bad block, continue with others */ }
          }
          words = allBlockWords;
          ctx.addDecision('s3', `blocks_p${page.pageNo}`, `${blocks.length} blocks → ${words.length} words`);
          if (words.length > 0) enhancedCount++;
        } else {
          // Full-page fallback (no usable blocks detected)
          const origWords = await runTesseract(pngPath, lang, page.pageNo, ctx);
          const origScore = cleanRatio(origWords, cleanT);

          const enhancedPath = `${outBase}_enhanced.png`;
          const enhancement = forceContrast
            ? await tryEnhanceForced(pngPath, enhancedPath, extraArgs)
            : await tryEnhance(pngPath, enhancedPath, extraArgs);

          words = origWords;
          if (enhancement) {
            try {
              const enhWords = await runTesseract(enhancedPath, lang, page.pageNo, ctx);
              const enhScore = cleanRatio(enhWords, cleanT);
              if (enhScore > origScore) {
                words = enhWords.map(w => ({ ...w, source: 'tesseract+contrast' }));
                page._pngPath = enhancedPath;
                enhancedCount++;
                ctx.addDecision('s3', `contrast_p${page.pageNo}`,
                  `${enhancement.applied?.[0] ?? 'enhanced'}: ${(origScore*100).toFixed(0)}%→${(enhScore*100).toFixed(0)}% clean`,
                  enhScore - origScore);
              } else {
                ctx.addDecision('s3', `contrast_p${page.pageNo}`,
                  `${enhancement.applied?.[0] ?? 'enhanced'} tried, kept original (${(origScore*100).toFixed(0)}% vs ${(enhScore*100).toFixed(0)}%)`,
                  0);
              }
            } catch { /* keep original */ }
          }
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

    // Surya multi-engine batch — CLI call after all pages rasterized
    if (ctx.config.s3MultiEngine?.includes('surya')) {
      const suryaOk = await checkSuryaCli(ctx);
      if (!suryaOk) {
        ctx.addError('s3', new Error(`surya_ocr CLI not found — install surya or set SURYA_PATH`), true);
      } else {
        try {
          await runSuryaBatchS3(ctx.pages, ctx);
          const suryaCount = ctx.pages.filter(p => p._suryaText).length;
          ctx.addDecision('s3', 'surya_batch', `${suryaCount}/${ctx.pages.length} pages`);
        } catch (e) {
          ctx.addError('s3', new Error(`surya batch failed: ${e.message}`), true);
        }
      }
    }

    const notesArr = Object.keys(routingSummary);
    if (enhancedCount > 0) notesArr.push(`contrast:${enhancedCount}`);
    ctx.addDecision('s3', 'routing_summary', JSON.stringify(routingSummary));

    // Record quality after OCR: avg clean-word ratio × page coverage
    const pagesWithWords = ctx.pages.filter(p => p.words?.length > 0);
    if (pagesWithWords.length > 0) {
      const avgClean = pagesWithWords.reduce((sum, p) => {
        const clean = p.words.filter(w => w.conf >= cleanT).length;
        return sum + (p.words.length > 0 ? clean / p.words.length : 0);
      }, 0) / pagesWithWords.length;
      const coverage = pagesWithWords.length / ctx.pages.length;
      ctx.recordStageQuality('s3', Math.round(avgClean * coverage * 1000) / 1000);
    }
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
