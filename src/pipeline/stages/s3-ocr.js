// Stage 3: Rasterize PDF pages with pdftoppm, OCR with Tesseract hOCR for word-level bboxes.
// Exports: s3Ocr, parseHocr. Deps: pdftoppm CLI, tesseract CLI, config.js
// CONTRACT:
//   Reads:  ctx.sourcePath, ctx.pages[n].regions[0].type, ctx.meta?.language
//   Writes: ctx.pages[n].words, ctx.pages[n]._pngPath, ctx.pages[n]._bucketed, ctx.pages[n]._lang

import { shouldRun } from '../config.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);

/** Map region type / meta language to Tesseract lang string. */
function resolveLang(regionType, metaLang) {
  if (regionType === 'printed_arabic' || metaLang === 'ar' || metaLang === 'ara') return 'ara';
  if (regionType === 'printed_persian' || metaLang === 'fa' || metaLang === 'fas' || metaLang === 'per') return 'fas';
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
    // Extract bbox
    const bboxM = title.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const x1 = parseInt(bboxM[1]), y1 = parseInt(bboxM[2]), x2 = parseInt(bboxM[3]), y2 = parseInt(bboxM[4]);
    // Extract confidence
    const confM = title.match(/x_wconf\s+(\d+)/);
    const conf = confM ? parseInt(confM[1]) : 0;
    // Strip inner HTML tags and decode entities
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

export async function s3Ocr(ctx) {
  if (!shouldRun('s3', ctx)) return ctx;

  ctx.beginStage('s3');
  let pagesAffected = 0;
  const routingSummary = {};
  const cleanT = (ctx.config.thresholds?.cleanPage ?? 0.90) * 100;
  const fuzzyT = (ctx.config.thresholds?.fuzzyWord ?? 0.60) * 100;
  const dirtyT = (ctx.config.thresholds?.dirtyWord ?? 0.40) * 100;
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 16);
  const tmpDir = join(tmpdir(), `site2rag-s3-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    for (const page of ctx.pages) {
      try {
        // Skip figure-only pages
        if (page.regions?.length && page.regions.every(r => r.type === 'figure')) {
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
          continue;
        }
        const regionType = page.regions?.[0]?.type ?? null;
        const lang = resolveLang(regionType, ctx.meta?.language);
        page._lang = lang;
        routingSummary[lang] = (routingSummary[lang] ?? 0) + 1;
        // Rasterize page
        const outBase = join(tmpDir, `p${page.pageNo}`);
        const pngPath = `${outBase}.png`;
        if (!existsSync(pngPath)) {
          await execFileAsync('pdftoppm', [
            '-png', '-r', '300', '-f', String(page.pageNo), '-l', String(page.pageNo),
            '-singlefile', ctx.sourcePath, outBase,
          ], { timeout: 60000 });
        }
        page._pngPath = pngPath;
        // Run Tesseract hOCR
        const { stdout } = await execFileAsync('tesseract', [pngPath, 'stdout', 'hocr', '-l', lang], {
          timeout: 120000, maxBuffer: 20 * 1024 * 1024,
        });
        const words = parseHocr(stdout, page.pageNo);
        page.words = words;
        // Bucket words
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
