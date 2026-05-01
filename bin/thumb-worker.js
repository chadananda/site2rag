// Thumbnail worker thread -- renders PDF page 1 via pdfjs+canvas, 2x then downscale for sharpness.
// Runs as a persistent worker_threads worker; receives jobs via parentPort messages.
import { parentPort } from 'worker_threads';
import { readFileSync, writeFileSync } from 'fs';

let pdfjs, createCanvas;

const init = async () => {
  if (pdfjs) return;
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  ({ createCanvas } = await import('@napi-rs/canvas'));
};

parentPort.on('message', async ({ jobId, pdfPath, outPath, targetW }) => {
  try {
    await init();
    const pdfBuf = readFileSync(pdfPath);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise;
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = (targetW * 2) / vp1.width;
    const viewport = page.getViewport({ scale });
    const hi = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: hi.getContext('2d'), viewport }).promise;
    const outH = Math.round(vp1.height * targetW / vp1.width);
    const out = createCanvas(targetW, outH);
    out.getContext('2d').drawImage(hi, 0, 0, targetW, outH);
    writeFileSync(outPath, out.toBuffer('image/jpeg', { quality: 88 }));
    parentPort.postMessage({ jobId, success: true });
  } catch (e) {
    parentPort.postMessage({ jobId, success: false, error: e.message });
  }
});
