// Re-OCR via local AI (boss). Page-by-page vision OCR with caching and throttling.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { metaDir } from '../config.js';

const LOCAL_LLM = process.env.LOCAL_LLM || 'http://boss.taile945b3.ts.net:8000/v1';
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'llava';
const TIMEOUT_MS = 120_000;
const PAGE_DELAY_MS = 500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Check if boss is reachable and not overloaded. Returns true if available. */
export const bossAvailable = async () => {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${LOCAL_LLM}/models`, { signal: ctrl.signal });
    clearTimeout(tid);
    return res.ok;
  } catch { return false; }
};

/** OCR a single PNG page via boss vision model. Returns { text_md, confidence }. */
const ocrPageViaBoss = async (pngPath) => {
  const imgBuf = readFileSync(pngPath);
  const b64 = imgBuf.toString('base64');
  const body = {
    model: LOCAL_LLM_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'text', text: 'Transcribe all text from this page exactly as it appears. Output only the transcribed text in clean Markdown. Preserve headings, paragraphs, lists, and tables. Do not add commentary.' }
      ]
    }],
    max_tokens: 4096,
    temperature: 0
  };
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${LOCAL_LLM}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally { clearTimeout(tid); }
  if (!res.ok) throw new Error(`boss HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text_md = data.choices?.[0]?.message?.content?.trim() || '';
  return { text_md, confidence: text_md.length > 20 ? 0.9 : 0.3 };
};

/** Rasterize one page of a PDF to a temp PNG. Returns png path. */
const rasterizePage = async (pdfBuf, pageNo, outDir) => {
  const pngPath = join(outDir, `reocr-page-${String(pageNo).padStart(3, '0')}.png`);
  if (existsSync(pngPath)) return pngPath;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise;
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale: 2.5 }); // higher res for boss
  const { createCanvas } = await import('canvas');
  const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  writeFileSync(pngPath, canvas.toBuffer('image/png'));
  return pngPath;
};

/**
 * Re-OCR all pages of a PDF using boss. Returns array of { pageNo, text_md, confidence }.
 * Skips pages already cached in the reocr cache dir.
 * @param {string} pdfPath
 * @param {string} domain
 * @param {string} docHash
 * @param {number} numPages
 * @param {function} onProgress - called with (pageNo, total) after each page
 */
export const reocrDocument = async (pdfPath, domain, docHash, numPages, onProgress) => {
  const cacheDir = join(metaDir(domain), 'reocr', docHash);
  mkdirSync(cacheDir, { recursive: true });
  const pdfBuf = readFileSync(pdfPath);
  const results = [];
  for (let i = 1; i <= numPages; i++) {
    const cacheFile = join(cacheDir, `page-${String(i).padStart(3, '0')}.json`);
    if (existsSync(cacheFile)) {
      results.push(JSON.parse(readFileSync(cacheFile, 'utf8')));
      onProgress?.(i, numPages);
      continue;
    }
    const pngPath = await rasterizePage(pdfBuf, i, cacheDir);
    const { text_md, confidence } = await ocrPageViaBoss(pngPath);
    const entry = { pageNo: i, text_md, confidence };
    writeFileSync(cacheFile, JSON.stringify(entry), 'utf8');
    results.push(entry);
    onProgress?.(i, numPages);
    if (i < numPages) await sleep(PAGE_DELAY_MS);
  }
  return results;
};
