// OCR engine registrations. Thin wrapper over service-registry.js. For new engines: registerService({type:'ocr', ...})
// Deps: service-registry.js, ocr-server-pool.js, stages/s3-ocr.js
// Also seeds synthesis and vision services with proper call() signatures.
// Pool support: set SURYA_ENDPOINTS, EASYOCR_ENDPOINTS, PADDLEOCR_ENDPOINTS, KRAKEN_ENDPOINTS, DOCTR_ENDPOINTS (comma-separated)
// Overflow support: set SURYA_OVERFLOW, EASYOCR_OVERFLOW, etc. for paid cloud spillover when local endpoints are saturated.
// Synthesis: BOSS_ENDPOINT routes to free local LLM; HAIKU_OVERFLOW routes to Anthropic API as paid fallback.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runSuryaServer, runEasyOcrServer, runPaddleOcrServer, callPersistentServer } from './ocr-server-pool.js';
import { parseHocr } from './stages/s3-ocr.js';
import { registerService, getServices } from './service-registry.js';

const execFileAsync = promisify(execFile);
const ENGINES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'engines');
const VENV_PYTHON = process.env.SURYA_PYTHON ?? '/tank/site2rag/ocr-venv/bin/python3';

/**
 * Build endpoint list for registerService, supporting local pool + optional overflow.
 * localEnv: singular env var name (e.g. 'SURYA_ENDPOINT')
 * localEnvsPlural: plural env var name (e.g. 'SURYA_ENDPOINTS')
 * defaultLocal: default value when neither env var is set (e.g. 'local')
 * overflowEnv: env var for overflow cloud URL (e.g. 'SURYA_OVERFLOW')
 * localMaxConcurrent: per-endpoint concurrency cap for local endpoints (default: Infinity)
 * Returns spread-ready object: { endpoint } | { endpoints, poolStrategy }
 */
function _buildEndpoints(localEnv, localEnvsPlural, defaultLocal, overflowEnv, localMaxConcurrent = Infinity) {
  const localUrls = (process.env[localEnvsPlural] ?? process.env[localEnv] ?? defaultLocal).split(',');
  const endpoints = localUrls.map(url => ({
    url: url.trim(),
    tier: 'local',
    maxConcurrent: localMaxConcurrent,
  }));
  const overflowUrl = process.env[overflowEnv];
  if (overflowUrl) endpoints.push({ url: overflowUrl.trim(), tier: 'overflow', maxConcurrent: 1 });
  return endpoints.length === 1 && !overflowUrl
    ? { endpoint: endpoints[0].url }
    : { endpoints, poolStrategy: 'least-busy' };
}

// --- OCR engines ---

registerService({
  id: 'tesseract',
  type: 'ocr',
  description: 'Classic CPU OCR. Word bboxes + confidence scores. 100+ languages.',
  ..._buildEndpoints('TESSERACT_ENDPOINT', 'TESSERACT_ENDPOINTS', 'local', 'TESSERACT_OVERFLOW'),
  languages: ['*'],
  blockTypes: ['printed', 'mixed'],
  speed: 'medium',
  produces: 'words',
  strengths: ['word_bboxes', 'confidence_scores', 'latin_script'],
  weaknesses: ['arabic_handwriting', 'low_contrast'],
  tier: 0,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, requiresKey: false, gpu: false, cpuFallback: null },
  call: async (pngPath, lang) => {
    const tLang = lang === 'ar' ? 'ara' : lang === 'fa' ? 'fas' : lang === 'fr' ? 'fra' : 'eng';
    try {
      const { stdout } = await execFileAsync('tesseract', [pngPath, 'stdout', '-l', tLang, 'hocr'], { maxBuffer: 10 * 1024 * 1024, timeout: 60000 });
      const words = parseHocr(stdout, 0);
      return { text: words.map(w => w.text).join(' '), words };
    } catch { return { text: '', words: [] }; }
  },
});

// Surya local call impl (reused by pool routing)
async function _suryaLocal(pngPath, lang) {
  const text = await runSuryaServer(pngPath, lang);
  return { text, words: null };
}

registerService({
  id: 'surya',
  type: 'ocr',
  description: 'Neural OCR, strong on Arabic/CJK/handwriting',
  ..._buildEndpoints('SURYA_ENDPOINT', 'SURYA_ENDPOINTS', 'local', 'SURYA_OVERFLOW'),
  languages: ['ar', 'fa', 'zh', 'ja', 'ko', 'en', 'fr', 'de', 'es', 'ru', 'he', 'hi'],
  blockTypes: ['printed', 'handwritten', 'mixed'],
  speed: 'fast',
  produces: 'text',
  strengths: ['arabic_script', 'handwriting', 'non_latin'],
  weaknesses: ['no_word_bboxes', 'tables'],
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, requiresKey: false, gpu: true, cpuFallback: true, cpuSlowdownFactor: 5 },
  _localCall: _suryaLocal,
  call: async (pngPath, lang) => _suryaLocal(pngPath, lang),
});

// EasyOCR local call impl
async function _easyocrLocal(pngPath, lang) {
  try {
    const res = await callPersistentServer('easyocr', VENV_PYTHON, `${ENGINES_DIR}/easyocr_server.py`, { path: pngPath, lang });
    const words = res.words ?? [];
    return { text: words.map(w => w.text).join(' '), words };
  } catch { return { text: '', words: [] }; }
}

registerService({
  id: 'easyocr',
  type: 'ocr',
  description: 'Multilingual deep-learning OCR with word bboxes',
  ..._buildEndpoints('EASYOCR_ENDPOINT', 'EASYOCR_ENDPOINTS', 'local', 'EASYOCR_OVERFLOW'),
  languages: ['ar', 'fa', 'en', 'fr', 'de', 'es', 'ru', 'ja', 'ko', 'zh', 'th', 'vi'],
  blockTypes: ['printed', 'mixed'],
  speed: 'medium',
  produces: 'words',
  strengths: ['multilingual', 'word_bboxes'],
  weaknesses: ['slow_cpu', 'arabic_accuracy'],
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, requiresKey: false, gpu: false, cpuFallback: null },
  _localCall: _easyocrLocal,
  call: async (pngPath, lang) => _easyocrLocal(pngPath, lang),
});

// PaddleOCR local call impl
async function _paddleLocal(pngPath, lang) {
  try {
    const res = await callPersistentServer('paddle', VENV_PYTHON, `${ENGINES_DIR}/paddleocr_server.py`, { path: pngPath, lang });
    const words = res.words ?? [];
    return { text: words.map(w => w.text).join(' '), words };
  } catch { return { text: '', words: [] }; }
}

registerService({
  id: 'paddleocr',
  type: 'ocr',
  description: 'PaddleOCR with layout detection, strong on CJK and tables',
  ..._buildEndpoints('PADDLEOCR_ENDPOINT', 'PADDLEOCR_ENDPOINTS', 'local', 'PADDLEOCR_OVERFLOW'),
  languages: ['en', 'fr', 'de', 'ar', 'zh', 'ja', 'ko'],
  blockTypes: ['printed', 'mixed'],
  speed: 'medium',
  produces: 'words',
  strengths: ['layout_detection', 'tables', 'chinese'],
  weaknesses: ['arabic_limited'],
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, requiresKey: false, gpu: false, cpuFallback: null },
  _localCall: _paddleLocal,
  call: async (pngPath, lang) => _paddleLocal(pngPath, lang),
});

// Kraken local call impl
async function _krakenLocal(pngPath, lang) {
  try {
    const res = await callPersistentServer('kraken', VENV_PYTHON, `${ENGINES_DIR}/kraken_server.py`, { path: pngPath, lang, model: null });
    if (res.error) return { text: '', words: [] };
    const words = res.words ?? [];
    return { text: words.map(w => w.text).join(' '), words };
  } catch { return { text: '', words: [] }; }
}

registerService({
  id: 'kraken',
  type: 'ocr',
  description: 'Scholarly HTR engine, strong on historical and RTL documents',
  ..._buildEndpoints('KRAKEN_ENDPOINT', 'KRAKEN_ENDPOINTS', 'local', 'KRAKEN_OVERFLOW'),
  languages: ['ar', 'he', 'gr', 'la', 'en', 'fr', 'de'],
  blockTypes: ['printed', 'handwritten', 'mixed'],
  speed: 'slow',
  produces: 'words',
  strengths: ['historical_documents', 'right_to_left', 'scholarly_models'],
  weaknesses: ['requires_model_download', 'slow_first_load'],
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, requiresKey: false, gpu: false, cpuFallback: null },
  _localCall: _krakenLocal,
  call: async (pngPath, lang) => _krakenLocal(pngPath, lang),
});

// DocTR local call impl
async function _doctrLocal(pngPath, lang) {
  try {
    const res = await callPersistentServer('doctr', VENV_PYTHON, `${ENGINES_DIR}/doctr_server.py`, { path: pngPath, lang });
    if (res.error) return { text: '', words: [], layout: null };
    return { text: (res.words ?? []).map(w => w.text).join(' '), words: res.words ?? [], layout: res.layout ?? null };
  } catch { return { text: '', words: [], layout: null }; }
}

registerService({
  id: 'doctr',
  type: 'ocr',
  description: 'docTR layout-aware OCR with structured block/line/word hierarchy',
  ..._buildEndpoints('DOCTR_ENDPOINT', 'DOCTR_ENDPOINTS', 'local', 'DOCTR_OVERFLOW'),
  languages: ['en', 'fr', 'de', 'es', 'pt', 'ar'],
  blockTypes: ['printed', 'mixed'],
  speed: 'slow',
  produces: 'layout',
  strengths: ['layout_detection', 'reading_order', 'tables'],
  weaknesses: ['arabic_limited', 'slower'],
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, requiresKey: false, gpu: true, cpuFallback: true, cpuSlowdownFactor: 8 },
  _localCall: _doctrLocal,
  call: async (pngPath, lang) => _doctrLocal(pngPath, lang),
});

// --- Synthesis services ---
// Boss endpoint: free local LLM (first choice). Anthropic API: overflow (paid, only when Boss is saturated).

registerService({
  id: 'haiku_synthesis',
  type: 'synthesis',
  description: 'OCR correction/synthesis. Routes Boss local LLM first (free); Anthropic API is overflow (paid).',
  ..._buildEndpoints('BOSS_ENDPOINT', 'BOSS_ENDPOINTS', process.env.BOSS_ENDPOINT ?? 'local', 'HAIKU_OVERFLOW'),
  languages: ['*'],
  blockTypes: ['printed', 'handwritten', 'mixed', 'table'],
  speed: 'medium',
  produces: 'text',
  strengths: ['correction', 'multi_engine_synthesis', 'arabic_script', 'context_aware'],
  weaknesses: ['cost_vs_free_engines'],
  cost: { tier: 2, label: 'remote_api_commodity', usdPer1000pages: 4, requiresKey: true, gpu: false },
  call: async (pngBuf, words, altTexts, apiKey, domain, lang, model) => {
    const { synthesizeWithCorrections } = await import('./stages/s5-synthesis.js');
    return synthesizeWithCorrections(pngBuf, words, altTexts, apiKey, domain, lang, model);
  },
});

// --- Vision services ---

registerService({
  id: 'google_vision',
  type: 'vision',
  description: 'Google Cloud Vision API. Strong handwriting, multilingual.',
  endpoint: 'cloud',
  languages: ['*'],
  blockTypes: ['printed', 'handwritten'],
  speed: 'medium',
  produces: 'text',
  strengths: ['handwriting', 'multilingual', 'reliable'],
  weaknesses: ['cost', 'requires_internet'],
  cost: { tier: 2, label: 'remote_api_commodity', usdPer1000pages: 1.5, requiresKey: true, gpu: false },
  call: async (_pngBuf, _lang, _apiKey) => { throw new Error('configure googleKey in pipeline config'); },
});

registerService({
  id: 'azure_di',
  type: 'vision',
  description: 'Azure Document Intelligence. Best-in-class tables and forms.',
  endpoint: 'cloud',
  languages: ['*'],
  blockTypes: ['printed', 'table', 'form'],
  speed: 'slow',
  produces: 'layout',
  strengths: ['tables', 'forms', 'structured_docs', 'reading_order'],
  weaknesses: ['cost', 'slow', 'requires_internet'],
  cost: { tier: 2, label: 'remote_api_commodity', usdPer1000pages: 5, requiresKey: true, gpu: false },
  call: async (_pngBuf, _lang, _apiKey) => { throw new Error('configure azureKey + azureEndpoint in pipeline config'); },
});

registerService({
  id: 'claude_vision',
  type: 'vision',
  description: 'Claude Sonnet/Opus vision. Highest quality, most expensive. Hard blocks only.',
  endpoint: 'cloud',
  languages: ['*'],
  blockTypes: ['printed', 'handwritten', 'mixed', 'table', 'equation'],
  speed: 'slow',
  produces: 'text',
  strengths: ['difficult_scripts', 'handwriting', 'complex_layout', 'correction', 'context'],
  weaknesses: ['expensive'],
  cost: { tier: 3, label: 'remote_api_specialized', usdPer1000pages: 25, requiresKey: true, gpu: false },
  call: async (_pngBuf, _lang, _apiKey) => { throw new Error('use s5-vision.js visionViaCloud directly'); },
});

registerService({
  id: 'mathpix',
  type: 'vision',
  description: 'Mathpix API. Only reliable engine for LaTeX equations and math notation.',
  endpoint: 'cloud',
  languages: ['*'],
  blockTypes: ['equation', 'table'],
  speed: 'medium',
  produces: 'text',
  strengths: ['equations', 'latex', 'math_notation', 'chemistry'],
  weaknesses: ['expensive', 'math_only'],
  cost: { tier: 3, label: 'remote_api_specialized', usdPer1000pages: 20, requiresKey: true, gpu: false },
  call: async (_pngBuf, _lang, _apiKey) => { throw new Error('configure mathpixKey in pipeline config'); },
});

// --- Legacy wrapper exports (callers of engine-registry.js don't break) ---

export function registerEngine(idOrEntry, entry) {
  const e = typeof idOrEntry === 'string' ? { ...entry, id: idOrEntry } : idOrEntry;
  registerService({ ...e, type: e.type ?? 'ocr', call: e.call ?? e.fn ?? (() => { throw new Error(`${e.id}: no call impl`); }) });
}

export function getEngine(id) { return getServices({ type: 'ocr' }).find(s => s.id === id) ?? null; }
export function listEngines() { return getServices({ type: 'ocr' }); }
export function getEnginesFor(lang, blockType = 'printed') {
  return getServices({ type: 'ocr' })
    .filter(e => e.languages.includes(lang) || e.languages.includes('*'))
    .map(e => {
      const langScore = e.languages.includes(lang) ? 1 : 0.5;
      const blockScore = e.blockTypes?.includes(blockType) ? 1 : e.blockTypes?.includes('mixed') ? 0.7 : 0.4;
      return { engine: e, score: langScore * blockScore };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.engine);
}
export function getEnginesByTier(tier) { return getServices({ type: 'ocr', tier }); }
export function getCpuEngines() {
  return getServices({ type: 'ocr' }).filter(e => e.cost?.tier === 0 || (e.cost?.tier === 1 && e.cost?.gpu === false));
}
export function getGpuEngines() {
  return getServices({ type: 'ocr' }).filter(e => e.cost?.tier === 1 && e.cost?.gpu === true);
}
export function isRemote(engine) { return engine.endpoint !== 'local'; }
export async function isAvailable(engine) {
  const { isAvailable: svcAvail } = await import('./service-registry.js');
  return svcAvail(engine);
}

// --- Newly installed engines (May 2026) ---

// TrOCR — handwritten + printed, transformer-based, lazy model load
async function _trocrLocal(pngPath, lang, mode = 'handwritten') {
  try {
    const res = await callPersistentServer('trocr', VENV_PYTHON, `${ENGINES_DIR}/trocr_server.py`, { path: pngPath, lang, mode });
    return { text: res.text ?? '', words: null };
  } catch { return { text: '', words: null }; }
}

registerService({
  id: 'trocr',
  type: 'ocr',
  description: 'Microsoft TrOCR. Best handwritten text recognition. transformer-based.',
  ..._buildEndpoints('TROCR_ENDPOINT', 'TROCR_ENDPOINTS', 'local', 'TROCR_OVERFLOW'),
  languages: ['en', 'fr', 'de', 'es'],
  blockTypes: ['handwritten', 'printed'],
  speed: 'slow',
  produces: 'text',
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, gpu: true, cpuFallback: true, cpuSlowdownFactor: 10 },
  strengths: ['handwriting', 'historical_printed', 'printed_latin'],
  weaknesses: ['arabic_script', 'no_word_bboxes', 'slow_cpu'],
  _localCall: _trocrLocal,
  call: async (pngPath, lang) => _trocrLocal(pngPath, lang),
});

// Docling — layout-preserving document conversion (PDF or image), IBM VLM
async function _doclingLocal(pngPath, lang) {
  try {
    const res = await callPersistentServer('docling', VENV_PYTHON, `${ENGINES_DIR}/docling_server.py`, { path: pngPath, lang });
    return { text: res.text ?? '', markdown: res.markdown ?? '', tables: res.tables ?? [], words: null };
  } catch { return { text: '', markdown: '', tables: [], words: null }; }
}

registerService({
  id: 'docling',
  type: 'layout',
  description: 'IBM Docling. Best layout preservation: tables, equations, reading order. 258M VLM.',
  ..._buildEndpoints('DOCLING_ENDPOINT', 'DOCLING_ENDPOINTS', 'local', 'DOCLING_OVERFLOW'),
  languages: ['en', 'fr', 'de', 'es', 'zh', 'ar'],
  blockTypes: ['printed', 'table', 'equation', 'mixed'],
  speed: 'medium',
  produces: 'layout',
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, gpu: false, cpuFallback: null },
  strengths: ['layout_preservation', 'tables', 'equations', 'reading_order', 'multi_column'],
  weaknesses: ['handwriting', 'arabic_handwriting'],
  _localCall: _doclingLocal,
  call: async (pngPath, lang) => _doclingLocal(pngPath, lang),
});

// Nougat — scientific PDF → LaTeX/Markdown (Meta)
// NOTE: broken with transformers>=5.0; nougat-ocr needs transformers<5.0
// Server will exit on FATAL if incompatible; pool will surface the error.
async function _nougatLocal(pngPath, lang) {
  try {
    const res = await callPersistentServer('nougat', VENV_PYTHON, `${ENGINES_DIR}/nougat_server.py`, { path: pngPath, lang });
    return { text: res.text ?? '', markdown: res.markdown ?? '', words: null };
  } catch { return { text: '', markdown: '', words: null }; }
}

registerService({
  id: 'nougat',
  type: 'ocr',
  description: 'Meta Nougat. Scientific PDFs → LaTeX markdown. Equations, formulas, academic tables.',
  ..._buildEndpoints('NOUGAT_ENDPOINT', 'NOUGAT_ENDPOINTS', 'local', 'NOUGAT_OVERFLOW'),
  languages: ['en'],
  blockTypes: ['equation', 'printed', 'table'],
  speed: 'slow',
  produces: 'text',
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, gpu: true, cpuFallback: true, cpuSlowdownFactor: 8 },
  strengths: ['equations', 'latex', 'scientific_papers', 'academic_tables'],
  weaknesses: ['handwriting', 'non_english', 'non_academic', 'broken_with_transformers_5x'],
  _localCall: _nougatLocal,
  call: async (pngPath, lang) => _nougatLocal(pngPath, lang),
});

// AWS Textract — cloud tier 2, forms/tables specialist
registerService({
  id: 'aws_textract',
  type: 'layout',
  description: 'AWS Textract. Managed cloud service. Forms, tables, key-value extraction.',
  endpoint: process.env.TEXTRACT_ENDPOINT ?? 'cloud',
  languages: ['en', 'fr', 'de', 'es', 'pt', 'it'],
  blockTypes: ['printed', 'table', 'form'],
  speed: 'medium',
  produces: 'layout',
  tier: 2,
  cost: { tier: 2, label: 'remote_api_commodity', usdPer1000pages: 15, gpu: false, requiresKey: true },
  strengths: ['forms', 'tables', 'key_value_pairs', 'aws_integration'],
  weaknesses: ['arabic_limited', 'expensive_vs_azure'],
  call: async () => { throw new Error('configure AWS credentials'); },
});

// Transkribus — historical handwriting cloud API, Arabic/Persian models
registerService({
  id: 'transkribus',
  type: 'ocr',
  description: 'Transkribus. Historical handwritten documents. 300+ trained models. Arabic/Persian models available.',
  endpoint: process.env.TRANSKRIBUS_ENDPOINT ?? 'cloud',
  languages: ['ar', 'fa', 'he', 'el', 'la', 'en', 'fr', 'de', 'es', 'it'],
  blockTypes: ['handwritten'],
  speed: 'slow',
  produces: 'text',
  tier: 3,
  cost: { tier: 3, label: 'remote_api_specialized', usdPer1000pages: 20, gpu: false, requiresKey: true },
  strengths: ['arabic_handwriting', 'historical_manuscripts', 'trained_models', 'rtl_scripts'],
  weaknesses: ['cloud_only', 'per_page_cost', 'slow'],
  call: async () => { throw new Error('configure TRANSKRIBUS_KEY'); },
});

// Qwen2-VL via Ollama — local vision LLM on Boss/NAS, free synthesis (replaces Haiku as default)
registerService({
  id: 'qwen2vl',
  type: 'synthesis',
  description: 'Qwen2-VL 7B via Ollama. 94.5% DocVQA. Free local synthesis on Boss. Replaces Haiku as default.',
  ...((() => {
    const bossUrl = process.env.BOSS_ENDPOINT ?? 'local';
    const overflow = process.env.QWEN2VL_OVERFLOW ?? null;
    const endpoints = [{ url: bossUrl, tier: 'local', maxConcurrent: 2 }];
    if (overflow) endpoints.push({ url: overflow, tier: 'overflow', maxConcurrent: 1 });
    return endpoints.length > 1 ? { endpoints, poolStrategy: 'least-busy' } : { endpoint: bossUrl };
  })()),
  languages: ['*'],
  blockTypes: ['printed', 'handwritten', 'mixed', 'table'],
  speed: 'medium',
  produces: 'text',
  tier: 1,
  cost: { tier: 1, label: 'local_ai', usdPer1000pages: 0, gpu: true, cpuFallback: false },
  strengths: ['synthesis', 'correction', 'multilingual', 'free', 'document_understanding'],
  weaknesses: ['requires_ollama', 'requires_gpu_on_boss'],
  call: async () => { throw new Error('use Boss Ollama endpoint directly'); },
});

// LanguageTool — post-OCR grammar/spell correction for 25+ languages
registerService({
  id: 'languagetool',
  type: 'postprocess',
  description: 'LanguageTool. Grammar + spell correction for 25+ languages. Post-OCR quality layer.',
  endpoint: process.env.LANGUAGETOOL_ENDPOINT ?? 'local',
  languages: ['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'pl', 'ru'],
  blockTypes: ['printed', 'mixed'],
  speed: 'fast',
  produces: 'text',
  tier: 0,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  strengths: ['grammar_correction', 'spell_check', 'post_ocr_quality', 'multilingual'],
  weaknesses: ['not_arabic', 'not_farsi', 'not_cjk'],
  call: async (text, lang) => { throw new Error('not yet wired'); },
});
