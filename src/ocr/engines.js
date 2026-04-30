// OCR engine adapters -- uniform interface { text_md, confidence, bboxes_json }. Caches in ocr_pages.
import Anthropic from '@anthropic-ai/sdk';
import { fetch } from 'undici';
import { readFileSync } from 'fs';
import { getOcrPage, saveOcrPage, logLlmCall } from '../db.js';
/** Build Anthropic client from env key. */
const mkClaude = (cfg) => new Anthropic({ apiKey: process.env[cfg?.api_key_env || 'ANTHROPIC_API_KEY'] });
/** Call Mistral OCR API. Returns { text_md, confidence, bboxes_json }. */
const runMistralOcr = async (pngPath, cfg, model) => {
  const apiKey = process.env[cfg?.api_key_env || 'MISTRAL_API_KEY'];
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');
  const imgBase64 = readFileSync(pngPath).toString('base64');
  const res = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'mistral-ocr-latest', document: { type: 'image_url', image_url: `data:image/png;base64,${imgBase64}` } }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`Mistral OCR error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const pages = data.pages || [];
  const text_md = pages.map(p => p.markdown || p.text || '').join('\n\n');
  const confidence = pages.reduce((acc, p) => acc + (p.confidence || 0), 0) / (pages.length || 1);
  const bboxes_json = JSON.stringify(pages.map(p => p.bounding_boxes || p.regions || []));
  return { text_md, confidence, bboxes_json, tokens_in: data.usage?.prompt_tokens || 0, tokens_out: data.usage?.completion_tokens || 0 };
};
/** Call Claude vision for OCR. Returns { text_md, confidence, bboxes_json }. */
const runClaudeOcr = async (pngPath, claudeCfg, model) => {
  const client = mkClaude(claudeCfg);
  const imgBase64 = readFileSync(pngPath).toString('base64');
  const prompt = 'Extract all text from this page image. Return valid JSON with keys: markdown (string, the page content in Markdown preserving headings/lists/tables), confidence (float 0-1 for your overall confidence). Return only the JSON, no prose.';
  const msg = await client.messages.create({
    model: model || 'claude-opus-4-7',
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgBase64 } }, { type: 'text', text: prompt }] }]
  });
  const text = msg.content.find(b => b.type === 'text')?.text || '{}';
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```json\s*|```\s*$/g, '')); } catch { parsed = { markdown: text, confidence: 0.5 }; }
  return { text_md: parsed.markdown || '', confidence: parsed.confidence ?? 0.5, bboxes_json: null, tokens_in: msg.usage.input_tokens, tokens_out: msg.usage.output_tokens };
};
/** Run tesseract.js OCR on page PNG. Returns { text_md, confidence, bboxes_json }. */
const runTesseractOcr = async (pngPath) => {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  const { data } = await worker.recognize(pngPath);
  await worker.terminate();
  const confidence = (data.confidence || 0) / 100;
  const bboxes = data.words?.map(w => ({ text: w.text, bbox: w.bbox, conf: w.confidence / 100 }));
  return { text_md: data.text || '', confidence, bboxes_json: JSON.stringify(bboxes || []), tokens_in: 0, tokens_out: 0 };
};
/** Engine name -> runner function. */
const ENGINES = { mistral: runMistralOcr, claude: runClaudeOcr, tesseract: runTesseractOcr };
/**
 * Run a single OCR engine on a page PNG. Returns cached result if available.
 * @param {object} db - Site SQLite db
 * @param {string} docUrl - Source document URL (cache key)
 * @param {number} pageNo - 1-based page number
 * @param {string} engine - Engine name: mistral | claude | tesseract
 * @param {string} pngPath - Path to rasterized page PNG
 * @param {object} llmProviders - LLM providers config from siteConfig.llm.providers
 */
export const runEngine = async (db, docUrl, pageNo, engine, pngPath, llmProviders = {}) => {
  const cached = getOcrPage(db, docUrl, pageNo, engine);
  if (cached) return { text_md: cached.text_md, confidence: cached.confidence, bboxes_json: cached.bboxes_json, fromCache: true };
  const runner = ENGINES[engine];
  if (!runner) throw new Error(`Unknown OCR engine: ${engine}`);
  const providerKey = engine === 'tesseract' ? null : engine;
  const providerCfg = providerKey ? llmProviders[providerKey] : null;
  const model = providerCfg?.models?.ocr || providerCfg?.models?.vision || null;
  const started = Date.now();
  let result, ok = 1;
  try {
    result = await runner(pngPath, providerCfg, model);
  } catch (err) {
    ok = 0;
    console.error(`[ocr:${engine}] page ${pageNo} failed: ${err.message}`);
    result = { text_md: '', confidence: 0, bboxes_json: null, tokens_in: 0, tokens_out: 0 };
  }
  saveOcrPage(db, { docUrl, pageNo, engine, text_md: result.text_md, confidence: result.confidence, bboxes_json: result.bboxes_json, bytes: result.text_md.length });
  // Log LLM call if applicable
  if (providerKey && result.tokens_in !== undefined) {
    logLlmCall(db, { stage: 'ocr_engine', url: docUrl, page_no: pageNo, provider: providerKey, model: model || 'unknown', tokens_in: result.tokens_in || 0, tokens_out: result.tokens_out || 0, cost_usd: 0, ok });
  }
  return { text_md: result.text_md, confidence: result.confidence, bboxes_json: result.bboxes_json, fromCache: false };
};
/**
 * Run all configured OCR engines in parallel for a page. Returns array of engine results.
 * @param {object} db - Site SQLite db
 * @param {string} docUrl - Source document URL
 * @param {number} pageNo - 1-based page number
 * @param {string} pngPath - Path to rasterized page PNG
 * @param {string[]} engines - List of engine names to run
 * @param {object} llmProviders - LLM providers config
 */
export const runAllEngines = async (db, docUrl, pageNo, pngPath, engines, llmProviders = {}) => {
  const results = await Promise.allSettled(engines.map(e => runEngine(db, docUrl, pageNo, e, pngPath, llmProviders)));
  return engines.map((e, i) => ({
    engine: e,
    ...(results[i].status === 'fulfilled' ? results[i].value : { text_md: '', confidence: 0, bboxes_json: null, fromCache: false })
  }));
};
