// Stage 4: Re-OCR at 600 DPI for pages with many dirty words; marks remaining dirty as needs_vision.
// Exports: s4Escalate. Deps: pdftoppm CLI, tesseract CLI, config.js
// CONTRACT:
//   Reads:  ctx.pages[n].words, ctx.pages[n]._lang, ctx.pages[n]._bucketed
//   Writes: may replace page.words; sets w.needs_vision=true on remaining dirty; updates _bucketed.needs_vision

import { shouldRun } from '../config.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);

function parseHocr(hocr, pageNo) {
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
    words.push({ text, x1, y1, x2, y2, conf, source: 'tesseract-600', pageNo });
  }
  return words;
}

function meanConf(words) {
  if (!words.length) return 0;
  return words.reduce((s, w) => s + (w.conf ?? 0), 0) / words.length;
}

async function rasterizeAt(pdfPath, pageNo, outDir, dpi) {
  const outBase = join(outDir, `p${pageNo}-${dpi}`);
  const pngPath = `${outBase}.png`;
  if (!existsSync(pngPath)) {
    await execFileAsync('pdftoppm', [
      '-png', '-r', String(dpi), '-f', String(pageNo), '-l', String(pageNo),
      '-singlefile', pdfPath, outBase,
    ], { timeout: 90000 });
  }
  return pngPath;
}

export async function s4Escalate(ctx) {
  if (!shouldRun('s4', ctx)) return ctx;

  ctx.beginStage('s4');
  let pagesAffected = 0;
  const dirtyT = (ctx.config.thresholds?.dirtyWord ?? 0.40) * 100;
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 16);
  const tmpDir = join(tmpdir(), `site2rag-s3-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    for (const page of ctx.pages) {
      const words = page.words ?? [];
      const dirtyWords = words.filter(w => (w.conf ?? 100) < dirtyT);
      const noOutput = words.length === 0;
      // Skip if no dirty words and page has output
      if (!noOutput && (dirtyWords.length === 0 || (dirtyWords.length < 3 && words.length > 10))) continue;

      const lang = page._lang ?? 'eng';
      try {
        if (!noOutput) {
          // Re-rasterize at 600 DPI and re-OCR
          const pngPath600 = await rasterizeAt(ctx.sourcePath, page.pageNo, tmpDir, 600);
          const { stdout } = await execFileAsync('tesseract', [pngPath600, 'stdout', 'hocr', '-l', lang, '--psm', '3'], {
            timeout: 120000, maxBuffer: 20 * 1024 * 1024,
          });
          const words600 = parseHocr(stdout, page.pageNo);
          const oldMean = meanConf(words);
          const newMean = meanConf(words600);
          const delta = newMean - oldMean;
          if (words600.length > 0 && newMean > oldMean + 5) {
            page.words = words600;
            ctx.addDecision('s4', `page_${page.pageNo}`, 'replaced-600dpi', delta);
          } else {
            ctx.addDecision('s4', `page_${page.pageNo}`, 'kept-original', delta);
          }
          // Mark remaining dirty words as needs_vision
          for (const w of page.words) {
            if ((w.conf ?? 100) < dirtyT) w.needs_vision = true;
          }
        } else {
          // No tesseract output at all — mark page for full vision
          page._needsFullVision = true;
          ctx.addDecision('s4', `page_${page.pageNo}`, 'needs-full-vision', 0);
        }
        page._bucketed = page._bucketed ?? { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
        page._bucketed.needs_vision = page.words.filter(w => w.needs_vision).length;
        pagesAffected++;
      } catch (pageErr) {
        ctx.addError('s4', pageErr, true);
        // On error, still mark dirty words as needs_vision
        for (const w of (page.words ?? [])) {
          if ((w.conf ?? 100) < dirtyT) w.needs_vision = true;
        }
        if (page._bucketed) page._bucketed.needs_vision = (page.words ?? []).filter(w => w.needs_vision).length;
      }
    }
  } catch (err) {
    ctx.addError('s4', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s4', { pages_affected: pagesAffected });
  }

  return ctx;
}
