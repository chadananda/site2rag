// Re-OCR via local AI (boss) or Claude vision fallback. Page-by-page OCR with caching.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { metaDir } from '../config.js';

const LOCAL_LLM = process.env.LOCAL_LLM || 'http://boss.taile945b3.ts.net:8000/v1';
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'llava';
const TIMEOUT_MS = 120_000;
const PAGE_DELAY_MS = 500;
// Claude Haiku for OCR fallback — cheap vision model, good at text transcription
const CLAUDE_OCR_MODEL = 'claude-haiku-4-5-20251001';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Check if boss is reachable. Returns true if available. */
export const bossAvailable = async () => {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${LOCAL_LLM}/models`, { signal: ctrl.signal });
    clearTimeout(tid);
    return res.ok;
  } catch { return false; }
};

/** Returns 'boss', 'claude', or null depending on what's available for OCR. */
export const ocrAvailableBackend = async () => {
  if (await bossAvailable()) return 'boss';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return null;
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

/** OCR a single PNG page via Claude vision. Returns { text_md, confidence }. */
const ocrPageViaClaude = async (pngPath) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const imgBuf = readFileSync(pngPath);
  const b64 = imgBuf.toString('base64');
  const msg = await client.messages.create({
    model: CLAUDE_OCR_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: 'Transcribe all text from this page exactly as it appears. Output only the transcribed text in clean Markdown. Preserve headings, paragraphs, lists, and tables. Do not add commentary.' }
      ]
    }]
  });
  const text_md = msg.content[0]?.text?.trim() || '';
  return { text_md, confidence: text_md.length > 20 ? 0.9 : 0.3 };
};

/** Build a NodeCanvasFactory for pdfjs-dist (required for server-side rendering). */
const makeCanvasFactory = (createCanvas) => ({
  create(width, height) { const canvas = createCanvas(width, height); return { canvas, context: canvas.getContext('2d') }; },
  reset(pair, width, height) { pair.canvas.width = width; pair.canvas.height = height; },
  destroy(pair) { pair.canvas.width = 0; pair.canvas.height = 0; },
});

/** Rasterize one page of a PDF to a temp PNG. Returns png path. */
const rasterizePage = async (pdfBuf, pageNo, outDir) => {
  const pngPath = join(outDir, `reocr-page-${String(pageNo).padStart(3, '0')}.png`);
  if (existsSync(pngPath)) return pngPath;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');
  const canvasFactory = makeCanvasFactory(createCanvas);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf), canvasFactory }).promise;
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale: 2.5 });
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  writeFileSync(pngPath, canvas.toBuffer('image/png'));
  return pngPath;
};

/**
 * Cheap single-page identification scan. Returns { language, topic }.
 * Used for image PDFs with unknown language to classify before expensive full OCR.
 */
export const identifyPage = async (pdfPath, backend = 'boss') => {
  const pdfBuf = readFileSync(pdfPath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');
  const canvasFactory = makeCanvasFactory(createCanvas);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf), canvasFactory }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.5 });
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  const b64 = canvas.toBuffer('image/jpeg', { quality: 75 }).toString('base64');

  let text;
  if (backend === 'claude') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: CLAUDE_OCR_MODEL,
      max_tokens: 40,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: 'Look at this document page. Answer in exactly 2 lines:\nLine 1: Language: [language name only]\nLine 2: Topic: [one short phrase, what is this document about]' }
      ]}]
    });
    text = msg.content[0]?.text?.trim() || '';
  } else {
    const body = {
      model: LOCAL_LLM_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: 'text', text: 'Look at this document page. Answer in exactly 2 lines:\nLine 1: Language: [language name only]\nLine 2: Topic: [one short phrase, what is this document about]' }
      ]}],
      max_tokens: 40,
      temperature: 0
    };
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 30_000);
    let res;
    try {
      res = await fetch(`${LOCAL_LLM}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(tid); }
    if (!res.ok) throw new Error(`boss HTTP ${res.status}`);
    const data = await res.json();
    text = data.choices?.[0]?.message?.content?.trim() || '';
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const langLine = lines.find(l => l.toLowerCase().startsWith('language:'));
  const topicLine = lines.find(l => l.toLowerCase().startsWith('topic:'));
  return {
    language: langLine ? langLine.replace(/^language:\s*/i, '').trim().toLowerCase() : null,
    topic:    topicLine ? topicLine.replace(/^topic:\s*/i, '').trim() : null,
  };
};

/**
 * Re-OCR all pages of a PDF. Uses boss if available, falls back to Claude vision.
 * @param {string} pdfPath
 * @param {string} domain
 * @param {string} docHash
 * @param {number} numPages
 * @param {function} onProgress - called with (pageNo, total) after each page
 * @param {string} backend - 'boss' | 'claude' (default 'boss')
 */
export const reocrDocument = async (pdfPath, domain, docHash, numPages, onProgress, backend = 'boss') => {
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
    const { text_md, confidence } = backend === 'claude'
      ? await ocrPageViaClaude(pngPath)
      : await ocrPageViaBoss(pngPath);
    const entry = { pageNo: i, text_md, confidence };
    writeFileSync(cacheFile, JSON.stringify(entry), 'utf8');
    results.push(entry);
    onProgress?.(i, numPages);
    if (i < numPages) await sleep(PAGE_DELAY_MS);
  }
  return results;
};
