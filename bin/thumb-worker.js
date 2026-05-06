// Thumbnail worker thread -- renders PDF page via pdfjs+canvas at 2x then downscales.
// Falls back to pdftoppm if pdfjs produces a near-blank result (common with old/scanned PDFs).
import { parentPort } from 'worker_threads';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

let pdfjs, createCanvas, loadImage;

const init = async () => {
  if (pdfjs) return;
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  ({ createCanvas, loadImage } = await import('@napi-rs/canvas'));
};

const blankRatio = (canvas) => {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let white = 0;
  const step = 4 * 20;
  for (let i = 0; i < data.length; i += step)
    if (data[i] > 240 && data[i+1] > 240 && data[i+2] > 240) white++;
  return white / (data.length / step);
};

const pdftoppmThumb = async (pdfPath, outPath, pageNo, targetW, targetH) => {
  const tmp = join(tmpdir(), `thumb_${Date.now()}_${pageNo}`);
  const padded = String(pageNo).padStart(2, '0');
  const tmpOut = `${tmp}-${padded}.jpg`;
  try {
    execSync(`pdftoppm -r 150 -jpeg -f ${pageNo} -l ${pageNo} "${pdfPath}" "${tmp}"`, { timeout: 15000 });
    if (!existsSync(tmpOut)) return false;
    const img = await loadImage(readFileSync(tmpOut));
    unlinkSync(tmpOut);
    const outH = targetH || Math.round(img.height * targetW / img.width);
    const out = createCanvas(targetW, outH);
    out.getContext('2d').drawImage(img, 0, 0, targetW, outH);
    writeFileSync(outPath, out.toBuffer('image/jpeg', { quality: 88 }));
    return true;
  } catch { try { if (existsSync(tmpOut)) unlinkSync(tmpOut); } catch {} return false; }
};

parentPort.on('message', async ({ jobId, pdfPath, outPath, targetW, targetH, pageNo = 1 }) => {
  try {
    await init();
    const pdfBuf = readFileSync(pdfPath);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise;
    const clampedPage = Math.max(1, Math.min(pageNo, pdf.numPages));
    const page = await pdf.getPage(clampedPage);
    const vp1 = page.getViewport({ scale: 1 });

    const scaleW = (targetW * 2) / vp1.width;
    const scaleH = targetH ? (targetH * 2) / vp1.height : 0;
    const scale = Math.max(scaleW, scaleH);

    const viewport = page.getViewport({ scale });
    const hi = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: hi.getContext('2d'), viewport }).promise;

    const outH = targetH || Math.round(vp1.height * targetW / vp1.width);
    const out = createCanvas(targetW, outH);
    out.getContext('2d').drawImage(hi, 0, 0, targetW, outH);

    if (blankRatio(out) > 0.92) {
      const ok = await pdftoppmThumb(pdfPath, outPath, clampedPage, targetW, targetH);
      if (ok) { parentPort.postMessage({ jobId, success: true }); return; }
    }

    writeFileSync(outPath, out.toBuffer('image/jpeg', { quality: 88 }));
    parentPort.postMessage({ jobId, success: true });
  } catch (e) {
    parentPort.postMessage({ jobId, success: false, error: e.message });
  }
});
