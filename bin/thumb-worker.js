// Thumbnail worker thread -- renders PDF page via pdfjs+canvas at 2x then downscales.
// If targetH is given, crops to exact targetW×targetH (top-aligned, for object-fit:cover).
import { parentPort } from 'worker_threads';
import { readFileSync, writeFileSync } from 'fs';

let pdfjs, createCanvas;

const init = async () => {
  if (pdfjs) return;
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  ({ createCanvas } = await import('@napi-rs/canvas'));
};

parentPort.on('message', async ({ jobId, pdfPath, outPath, targetW, targetH, pageNo = 1 }) => {
  try {
    await init();
    const pdfBuf = readFileSync(pdfPath);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise;
    const clampedPage = Math.max(1, Math.min(pageNo, pdf.numPages));
    const page = await pdf.getPage(clampedPage);
    const vp1 = page.getViewport({ scale: 1 });

    // If targetH given, scale so both dimensions are covered (for exact crop)
    const scaleW = (targetW * 2) / vp1.width;
    const scaleH = targetH ? (targetH * 2) / vp1.height : 0;
    const scale = Math.max(scaleW, scaleH);

    const viewport = page.getViewport({ scale });
    const hiW = Math.round(viewport.width);
    const hiH = Math.round(viewport.height);
    const hi = createCanvas(hiW, hiH);
    await page.render({ canvasContext: hi.getContext('2d'), viewport }).promise;

    // Downscale to output size (crop to targetH if specified, top-aligned)
    const outH = targetH || Math.round(vp1.height * targetW / vp1.width);
    const out = createCanvas(targetW, outH);
    out.getContext('2d').drawImage(hi, 0, 0, targetW, outH);
    writeFileSync(outPath, out.toBuffer('image/jpeg', { quality: 88 }));
    parentPort.postMessage({ jobId, success: true });
  } catch (e) {
    parentPort.postMessage({ jobId, success: false, error: e.message });
  }
});
