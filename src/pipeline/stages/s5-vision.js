// Stage 5: Vision escalation — image optimization → all OCR engines → Haiku synthesis → cloud fallback.
// Exports: s5Vision
//   s5Vision(ctx) → ctx
// CONFIG: escalation.suryaVision:2 — min importance for Surya/batch engines
//         escalation.localVision   — min importance for HTTP backends
//         escalation.cloudVision   — min importance for cloud APIs (azure/google/claude)
//         maxTokenBudget           — hard token cap; checked per page
//         toolBackends.*           — route tools to worker pool
// ERRORS: all engine failures are recoverable; cloud backends are last resort only
// CONTRACT:
//   Reads:  ctx.pages[n]._needsFullVision, _bucketed, words, _pngPath, _lang
//   Writes: ctx.pages[n].visionMd — final corrected markdown; clears page.words for vision pages
//
// Phase 1 — Image enhancement: preprocess full-page PNGs before OCR.
// Phase 2 — All batch OCR engines in parallel: surya + easyocr + paddle + doctr + kraken.
// Phase 3 — Haiku synthesis: combine all engine outputs into corrected Markdown (~$0.01/page).
//           Pages with ANY engine output go here — avoids expensive cloud APIs.
// Phase 4 — Cloud fallback (last resort): boss → azure → google → claude-opus.
//           Only for pages where no batch engine produced usable text.
import { shouldRun, withinBudget, llmCost, pLimit } from '../config.js';
import { queryWorkerCapacity } from '../tool-runner.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';

const __pyDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// ── config defaults ──────────────────────────────────────────────────────────
const D_SURYA_CHUNK = 20;     // SURYA_CHUNK_SIZE — pages per surya_ocr batch call
const D_MAX_PNG_MB  = 4;      // max PNG size in MB — Claude API limits to 5MB; stay under with headroom

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const VISION_PROMPT = 'Transcribe all text from this document page exactly as it appears. Output only the transcribed text in clean Markdown. Preserve headings, paragraphs, and lists. For tables use Markdown pipe syntax (| col | col |). Do NOT use LaTeX notation, \\begin{array}, \\text{}, or any mathematical markup. Do not add commentary.';
const HANDWRITING_PROMPT = 'Carefully transcribe all handwritten and printed text from this document page. The text may include multiple languages and scripts including Arabic, Persian, and English. Preserve paragraph breaks. Mark words that are truly illegible as [illegible]. Output only the transcribed text in clean Markdown using pipe-syntax tables (| col | col |). Do NOT use LaTeX notation or mathematical markup. Do not add commentary.';
const RTL_VISION_PROMPT = 'Transcribe all text from this document page. The text is in Arabic or Persian script (right-to-left). Output only the transcribed text in clean Markdown. Preserve paragraph breaks and list structure. For tables use Markdown pipe syntax (| col | col |). Do NOT use LaTeX notation, \\begin{array}, \\text{}, or mathematical markup. Output the actual Arabic/Persian words and numbers as they appear — do not transliterate. Do not add commentary.';

// SURYA_CHUNK_SIZE moved to D_SURYA_CHUNK above

// Python batch engines — same as s3, run on full-page PNGs in s5.
// langs filter: null = always run; function(lang) = run only if true.
const S5_RTL_LANGS = new Set(['ara', 'fas', 'per', 'heb', 'urd']);
const S5_CJK_LANGS = new Set(['chi_sim', 'chi_tra', 'chi_sim+jpn', 'chi_sim+chi_tra', 'jpn', 'kor']);
const S5_BATCH_ENGINES = [
  { label: 'easyocr', tool: 'easyocr_ocr', script: join(__pyDir, 'easyocr_ocr.py'), langs: null },
  { label: 'paddle',  tool: 'paddle_ocr',  script: join(__pyDir, 'paddle_ocr.py'),  langs: null },
  // doctr: Latin + CJK; produces garbage on RTL scripts
  { label: 'doctr',   tool: 'doctr_ocr',   script: join(__pyDir, 'doctr_ocr.py'),   langs: (l) => !S5_RTL_LANGS.has(l) },
  // kraken: Latin only; 0 crops on RTL and CJK
  { label: 'kraken',  tool: 'kraken_ocr',  script: join(__pyDir, 'kraken_ocr.py'),  langs: (l) => !S5_RTL_LANGS.has(l) && !S5_CJK_LANGS.has(l) },
];

async function checkPythonEngine(toolName, ctx) {
  try {
    const { stdout } = await ctx.run(toolName, ['--check'], { timeout: 15000 });
    return stdout.trim() === 'ok';
  } catch { return false; }
}

// Run one batch engine over full-page PNGs. Returns Map<pageNo, text>.
async function runEngineOnPages(engine, pages, pageToPath, langs, tmpDir, ctx) {
  const inputDir   = join(tmpDir, `s5-${engine.label}-in`);
  const outputJson = join(tmpDir, `s5-${engine.label}-out.json`);
  mkdirSync(inputDir, { recursive: true });
  for (const page of pages) {
    const pngPath = pageToPath.get(page.pageNo);
    if (pngPath && existsSync(pngPath))
      writeFileSync(join(inputDir, `p${page.pageNo}.png`), readFileSync(pngPath));
  }
  try {
    await ctx.run(engine.tool, [inputDir, outputJson, langs], { timeout: 600000 });
    if (!existsSync(outputJson)) return new Map();
    const results = JSON.parse(readFileSync(outputJson, 'utf8'));
    const map = new Map();
    for (const [stem, val] of Object.entries(results)) {
      const pageNo = parseInt(stem.replace(/^p/, ''), 10);
      if (!isNaN(pageNo) && val.text?.trim()) map.set(pageNo, val.text.trim());
    }
    return map;
  } catch { return new Map(); }
}

// Enhance a full-page PNG for OCR using preprocess_image.py.
// Routes through ctx.run so tests can mock without spawning a real subprocess.
async function enhancePagePng(pngPath, outPath, ctx) {
  try {
    const { stdout } = await ctx.run('python3',
      [join(__pyDir, 'preprocess_image.py'), pngPath, outPath], { timeout: 30000 });
    const result = JSON.parse(stdout.trim() || '{}');
    return result.enhanced && existsSync(outPath) ? outPath : pngPath;
  } catch { return pngPath; }
}

// Map Tesseract lang codes → Surya lang codes
const TESS_TO_SURYA = {
  ara: 'ar', fas: 'fa', per: 'fa',
  chi_sim: 'zh', chi_tra: 'zh', jpn: 'ja',
  'chi_sim+jpn': 'zh', kor: 'ko',
  deu: 'de', fra: 'fr', spa: 'es', eng: 'en',
};

// Map Tesseract lang codes → Google Vision language hints
const TESS_TO_GOOGLE = {
  ara: 'ar', fas: 'fa', chi_sim: 'zh-CN', chi_tra: 'zh-TW',
  jpn: 'ja', 'chi_sim+jpn': 'zh-CN', kor: 'ko', eng: 'en',
};

// RTL scripts that need language-aware prompts and skip boss (local LLaVA has poor RTL support)
const RTL_LANGS = new Set(['ara', 'fas', 'per', 'heb', 'urd']);

// Detect LaTeX artifacts in vision output — indicates model failure on image
function hasLatexArtifacts(text) {
  return /\\begin\{|\\text\{|\\frac\{|\\hline|\$\\/.test(text);
}

// Deduplicate repeated paragraphs in vision output (model hallucination pattern)
function deduplicateBlocks(text) {
  if (!text) return text;
  const blocks = text.split(/\n{2,}/);
  const seen = new Set();
  const deduped = [];
  for (const block of blocks) {
    const normalized = block.trim().replace(/\s+/g, ' ');
    if (normalized.length < 20 || !seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(block);
    }
  }
  return deduped.join('\n\n');
}

// Word-confidence quality for a page (0–1). Used to decide whether vision can still improve it.
function pageWordQuality(page, cleanT = 60) {
  const words = page.words ?? [];
  if (!words.length) return 0;
  return words.filter(w => w.conf >= cleanT).length / words.length;
}

export const shouldVisionPage = (page) => {
  const visionWords = (page.words ?? []).filter(w => w.needs_vision);
  const needsFull = page._needsFullVision || (page.words?.length === 0 && page.regions?.some(r => r.type !== 'figure'));
  const dirty = page._bucketed?.dirty ?? 0;
  const total = page.words?.length ?? 0;
  const highDirty = total > 0 && dirty / total > 0.5;
  // Include pages below the vision improvement threshold — vision can improve fuzzy Tesseract output.
  // Only applies when there are words to assess; empty pages rely on needsFull instead.
  const hasWords = (page.words?.length ?? 0) > 0;
  const belowThreshold = hasWords && pageWordQuality(page) < (page._visionQualityGate ?? 0.90);
  return { shouldVision: needsFull || highDirty || visionWords.length > 10 || belowThreshold, needsFull };
};

// ── page PNG helper ───────────────────────────────────────────────────────────

const MAX_PNG_BYTES = D_MAX_PNG_MB * 1024 * 1024; // larger pages downsampled by vision model anyway

async function getPagePng(page, ctx) {
  if (page._pngPath && existsSync(page._pngPath)) {
    const buf = readFileSync(page._pngPath);
    if (buf.length <= MAX_PNG_BYTES) return buf;
    // Full-res too large — re-rasterize at lower DPI for vision
  }
  const stableDir = join(getTmpDir(), 'site2rag-s3-' + sha256(ctx.docId).slice(0, 16));
  mkdirSync(stableDir, { recursive: true });
  // Try 150dpi, then 100dpi if still too large
  for (const dpi of [150, 100]) {
    const outBase = join(stableDir, `page-${page.pageNo}-${dpi}dpi`);
    await ctx.run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page.pageNo),
      '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, outBase], { timeout: 30000 });
    const pngPath = outBase + '.png';
    if (!existsSync(pngPath)) continue;
    const buf = readFileSync(pngPath);
    if (buf.length <= MAX_PNG_BYTES) return buf;
  }
  return null;
}

// ── Phase 1: Surya batch pre-pass ────────────────────────────────────────────

let _suryaCliCache = null;
function _makeSuryaCache(available, helpText) {
  const newApi = helpText.includes('--output_dir');
  const flag = newApi ? '--output_dir' : '--results_dir';
  const getResultsPath = newApi
    ? (outDir, inDir) => join(outDir, basename(inDir), 'results.json')
    : (outDir) => join(outDir, 'results.json');
  return { available, flag, getResultsPath };
}
async function checkSuryaCli(ctx) {
  if (_suryaCliCache) return _suryaCliCache.available;
  try {
    const r = await ctx.run('surya_ocr', ['--help'], { timeout: 5000 });
    const helpText = ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\s+/g, ' ');
    _suryaCliCache = _makeSuryaCache(true, helpText);
    return true;
  } catch (e) {
    const helpText = ((e.stdout ?? '') + (e.stderr ?? '')).replace(/\s+/g, ' ');
    _suryaCliCache = _makeSuryaCache(e.code !== 'ENOENT', helpText);
    return _suryaCliCache.available;
  }
}

async function runSuryaChunk(pages, chunkDir, ctx) {
  // Write PNGs into the chunk directory — skip oversized or unreadable pages
  const pngMap = new Map(); // filename → page
  for (const page of pages) {
    let buf;
    try { buf = await getPagePng(page, ctx); } catch { continue; }
    if (!buf) continue;
    const filename = `page-${String(page.pageNo).padStart(4, '0')}.png`;
    writeFileSync(join(chunkDir, filename), buf);
    pngMap.set(filename, page);
  }
  if (pngMap.size === 0) return;

  // Collect unique langs for this chunk
  const langs = [...new Set(pages.map(p => TESS_TO_SURYA[p._lang] ?? 'en'))].join(',');

  const outDir = chunkDir + '-out';
  mkdirSync(outDir, { recursive: true });

  try {
    const { flag, getResultsPath } = _suryaCliCache ?? { flag: '--output_dir',
      getResultsPath: (o, i) => join(o, basename(i), 'results.json') };
    await ctx.run('surya_ocr', [chunkDir, flag, outDir], { timeout: 60000 });

    const resultsPath = getResultsPath(outDir, chunkDir);
    if (!existsSync(resultsPath)) return;

    const results = JSON.parse(readFileSync(resultsPath, 'utf8'));

    for (const [filename, page] of pngMap) {
      // Keys in results.json are stems without extension (e.g. "page-0001" not "page-0001.png")
      const stem = filename.replace(/\.[^.]+$/, '');
      const entry = results[stem] ?? results[filename];
      const pageResult = Array.isArray(entry) ? entry[0] : entry;
      const lines = pageResult?.text_lines ?? [];
      const text = lines.map(l => l.text ?? '').filter(Boolean).join('\n').trim();
      if (text) page._suryaMd = text;
    }
  } finally {
    // Clean up temp dirs
    try { rmSync(chunkDir, { recursive: true, force: true }); } catch {}
    try { rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

async function runSuryaBatch(visionPages, ctx) {
  const docHash = sha256(ctx.docId).slice(0, 12);
  const base = join(getTmpDir(), `site2rag-surya-${docHash}`);

  // Build chunk list
  const chunks = [];
  for (let i = 0; i < visionPages.length; i += D_SURYA_CHUNK) {
    const idx = Math.floor(i / D_SURYA_CHUNK);
    const chunkDir = `${base}-chunk${idx}`;
    mkdirSync(chunkDir, { recursive: true });
    chunks.push({ pages: visionPages.slice(i, i + D_SURYA_CHUNK), chunkDir });
  }

  // Parallelize chunks across available Surya workers.
  // Each worker has exactly 1 Surya slot (GPU-bound), so parallelism = number of Surya workers.
  // Falls back to 1 (sequential) when not using workerPool or workers unreachable —
  // sequential is correct for a single GPU and avoids OOM from concurrent model loads.
  const suryaSlots = await queryWorkerCapacity('surya_ocr', ctx.config).catch(() => null);
  const chunkLimit = pLimit(suryaSlots ?? 1);

  await Promise.all(chunks.map(({ pages, chunkDir }) =>
    chunkLimit(() => runSuryaChunk(pages, chunkDir, ctx))
  ));
}

// ── Phase 2: per-page HTTP backends ──────────────────────────────────────────

async function checkService(url, timeoutMs = 5000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

async function visionViaBoss(bossUrl, b64) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(`${bossUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'vision',
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          { type: 'text', text: VISION_PROMPT },
        ]}],
        max_tokens: 512, temperature: 0,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`boss HTTP ${res.status}`);
    const data = await res.json();
    return { text: data.choices[0].message.content, tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0, cost: 0 };
  } catch (e) { clearTimeout(timer); throw e; }
}

async function visionViaAzure(endpoint, key, b64) {
  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;
  const startRes = await fetch(analyzeUrl, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Source: b64 }),
  });
  if (!startRes.ok) throw new Error(`azure start HTTP ${startRes.status}`);
  const pollUrl = startRes.headers.get('Operation-Location');
  if (!pollUrl) throw new Error('azure: no Operation-Location header');
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(pollUrl, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (!pollRes.ok) throw new Error(`azure poll HTTP ${pollRes.status}`);
    const data = await pollRes.json();
    if (data.status === 'succeeded')
      return { text: data.analyzeResult?.content ?? '', tokens_in: 800, tokens_out: 0, cost: 0.0015 };
    if (data.status === 'failed') throw new Error(`azure failed: ${data.error?.message}`);
  }
  throw new Error('azure: timed out');
}

async function visionViaGoogle(key, b64, lang) {
  const langHint = TESS_TO_GOOGLE[lang] ?? 'en';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{
        image: { content: b64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: [langHint] },
      }]}),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`google HTTP ${res.status}`);
    const data = await res.json();
    const text = data.responses?.[0]?.fullTextAnnotation?.text ?? '';
    if (!text) throw new Error('google returned empty text');
    return { text, tokens_in: 0, tokens_out: 0, cost: 0.0015 };
  } catch (e) { clearTimeout(timer); throw e; }
}

async function visionViaCloud(b64, apiKey, model, prompt = VISION_PROMPT) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: 120000 });
  const msg = await client.messages.create({
    model, max_tokens: 2048,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const text = msg.content.map(b => b.type === 'text' ? b.text : '').join('');
  const cost = llmCost(model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
  return { text, tokens_in: msg.usage?.input_tokens ?? 0, tokens_out: msg.usage?.output_tokens ?? 0, cost };
}

// Synthesize corrected text from page image + all available OCR engine outputs.
// engineOutputs: { surya?: text, easyocr?: text, paddle?: text, doctr?: text, kraken?: text }
async function synthesizeWithOcrContext(b64, apiKey, model, page, engineOutputs = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: 120000 });
  const ocrDrafts = [];
  if (page?.words?.length > 0) {
    const tessText = page.words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    if (tessText) ocrDrafts.push(`Tesseract:\n${tessText.slice(0, 1500)}`);
  }
  // Add all engine outputs as context drafts
  for (const [label, text] of Object.entries(engineOutputs)) {
    if (text?.trim()) ocrDrafts.push(`${label.charAt(0).toUpperCase() + label.slice(1)}:\n${text.slice(0, 1500)}`);
  }
  const lang = page?._lang ?? 'eng';
  const isRtlPage = RTL_LANGS.has(lang);
  const basePrompt = isRtlPage ? RTL_VISION_PROMPT : VISION_PROMPT;
  const rtlNote = isRtlPage ? ' The text is in Arabic or Persian (right-to-left). Do NOT use LaTeX. Do NOT use \\begin{array}.' : '';
  const prompt = ocrDrafts.length > 0
    ? `You are correcting OCR output for a scanned historical document page.${rtlNote}\n\nOCR engine drafts (use these as context — some may be better than others):\n\n${ocrDrafts.join('\n\n')}\n\nReview the page image and produce the accurate transcription. Output only the text in clean Markdown. Use pipe tables (| col | col |), NOT LaTeX. Preserve paragraph breaks and headings.`
    : basePrompt;
  const msg = await client.messages.create({
    model, max_tokens: 2048,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const text = msg.content.map(b => b.type === 'text' ? b.text : '').join('');
  const cost = llmCost(model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
  return { text, tokens_in: msg.usage?.input_tokens ?? 0, tokens_out: msg.usage?.output_tokens ?? 0, cost };
}

async function buildBackendChain(ctx) {
  // disableCloudVision: true → no Phase 4 cloud backends. Use for testing to avoid spend.
  if (ctx.config.disableCloudVision) return [];
  const order = ctx.config.implementations?.vision ?? ['boss', 'azure', 'google', 'claude-opus-4-7'];
  const difficulty = ctx.quality?.baseline?.processing_difficulty ?? 0;
  // Hard/handwritten docs escalate to cloud vision regardless of importance (difficulty >= 0.5).
  // Standard cloud gate still applies for easy docs (importance >= cloudVision threshold).
  const cloudVisionGate = ctx.config.escalation?.cloudVision ?? 3;
  const needsCloud = ctx.importance >= cloudVisionGate || difficulty >= 0.5;
  // Use appropriate prompt: RTL languages need explicit Arabic/Persian guidance; hard/handwritten use handwriting prompt
  const docLang = ctx.pages[0]?._lang ?? ctx.quality?.baseline?.language ?? 'eng';
  const isRtl = RTL_LANGS.has(docLang);
  const visionPrompt = isRtl ? RTL_VISION_PROMPT : difficulty >= 0.7 ? HANDWRITING_PROMPT : VISION_PROMPT;
  const chain = [];
  for (const name of order.filter(n => n !== 'surya')) {
    if (name === 'boss') {
      // Skip boss for RTL scripts — local LLaVA models produce LaTeX artifacts and hallucinations on Arabic/Persian
      if (!isRtl && ctx.importance >= (ctx.config.escalation?.localVision ?? 1)) {
        const ok = await checkService(ctx.config.bossUrl.replace(/\/v1$/, ''));
        if (ok) chain.push({ name: 'boss', call: (b64) => visionViaBoss(ctx.config.bossUrl, b64) });
      }
    } else if (name === 'azure') {
      if (needsCloud && ctx.config.azureKey && ctx.config.azureEndpoint)
        chain.push({ name: 'azure', call: (b64) => visionViaAzure(ctx.config.azureEndpoint, ctx.config.azureKey, b64) });
    } else if (name === 'google') {
      if (needsCloud && ctx.config.googleKey)
        chain.push({ name: 'google', call: (b64, lang) => visionViaGoogle(ctx.config.googleKey, b64, lang) });
    } else if (name.startsWith('claude')) {
      if (needsCloud && ctx.config.apiKey)
        chain.push({ name, call: (b64) => visionViaCloud(b64, ctx.config.apiKey, name, visionPrompt) });
    }
  }
  return chain;
}

// ── main stage ────────────────────────────────────────────────────────────────

export async function s5Vision(ctx) {
  if (!shouldRun('s5', ctx)) return ctx;

  ctx.beginStage('s5');
  let pagesAffected = 0, totalCost = 0, totalIn = 0, totalOut = 0;

  const docHash = sha256(ctx.docId).slice(0, 12);
  const tmpDir  = join(getTmpDir(), `site2rag-s5-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const visionQualityGate = ctx.config.visionQualityGate ?? 0.90;
    for (const p of ctx.pages) p._visionQualityGate = visionQualityGate;
    const visionPages = ctx.pages.filter(p => shouldVisionPage(p).shouldVision);
    if (!visionPages.length) return ctx;

    const difficulty  = ctx.quality?.baseline?.processing_difficulty ?? 0;
    const suryaGate   = ctx.config.escalation?.suryaVision ?? 2;
    const runEngines  = visionPages.length > 0 && (ctx.importance >= suryaGate || difficulty >= 0.3);

    // ── Phase 1: Enhance full-page PNGs before feeding to any OCR engine ──────
    // preprocess_image.py detects & corrects contrast/skew/noise per page.
    const pageToPath = new Map(); // pageNo → best available PNG path
    await Promise.all(visionPages.map(async page => {
      let pngBuf;
      try { pngBuf = await getPagePng(page, ctx); } catch { return; }
      if (!pngBuf) return;
      const rawPath = join(tmpDir, `p${page.pageNo}_raw.png`);
      writeFileSync(rawPath, pngBuf);
      const enhPath = join(tmpDir, `p${page.pageNo}_enh.png`);
      const bestPath = await enhancePagePng(rawPath, enhPath, ctx);
      page._s5PngPath = bestPath; // track for cloud fallback
      pageToPath.set(page.pageNo, bestPath);
    }));

    // ── Phase 2: All batch OCR engines in parallel ─────────────────────────────
    // surya + easyocr + paddle + doctr + kraken — all support Arabic/Persian.
    // Each engine processes ALL vision pages in one process (amortizes model load).
    // Results keyed by pageNo; collected into pageEngineOutputs for Haiku synthesis.
    const pageEngineOutputs = new Map(); // pageNo → {surya?, easyocr?, paddle?, doctr?, kraken?}
    for (const page of visionPages) pageEngineOutputs.set(page.pageNo, {});

    if (runEngines) {
      const s3AlreadyFull = ctx.pages.some(p => p.visionMd);
      const langs = [...new Set(visionPages.map(p => TESS_TO_SURYA[p._lang] ?? 'en'))].join(',');

      // Check engine availability in parallel
      const [suryaOk, ...engineOks] = await Promise.all([
        s3AlreadyFull ? Promise.resolve(false) : checkSuryaCli(ctx),
        ...S5_BATCH_ENGINES.map(e => checkPythonEngine(e.tool, ctx)),
      ]);
      // Apply language capability filter — skip engines that don't support the dominant script
      const domLang = visionPages.map(p => p._lang ?? 'eng')
        .reduce((acc, l) => { acc[l] = (acc[l] ?? 0) + 1; return acc; }, {});
      const docLangS5 = Object.entries(domLang).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'eng';
      const availEngines = S5_BATCH_ENGINES.filter((e, i) => engineOks[i] && (e.langs == null || e.langs(docLangS5)));

      // Fail fast: local OCR engines are required for image PDFs. Cloud vision is not a substitute
      // for missing software. Fail the job now rather than spending $0.10-$0.20/page on cloud APIs.
      if (!suryaOk && availEngines.length === 0) {
        const missing = S5_BATCH_ENGINES.map(e => e.label).join(', ');
        throw new Error(
          `No OCR engines available for ${visionPages.length} image page(s). ` +
          `Install all required engines: ${missing}. ` +
          `Check scripts exist in pipeline dir and run: python3 <script>.py --check. ` +
          `Cloud vision APIs are not a fallback for missing software.`
        );
      }

      ctx.addDecision('s5', 'engines', [
        suryaOk ? 'surya' : null,
        ...availEngines.map(e => e.label),
      ].filter(Boolean).join(', ') || 'none');

      // Run surya (chunked) + all batch engines concurrently
      await Promise.all([
        suryaOk ? (async () => {
          try {
            await runSuryaBatch(visionPages, ctx);
            for (const page of visionPages) {
              if (page._suryaMd) {
                pageEngineOutputs.get(page.pageNo).surya = page._suryaMd;
                delete page._suryaMd;
              }
            }
            const n = [...pageEngineOutputs.values()].filter(o => o.surya).length;
            if (n) ctx.addDecision('s5', 'surya_batch', `${n}/${visionPages.length} pages`);
          } catch (e) { ctx.addError('s5', new Error(`surya: ${e.message}`), true); }
        })() : Promise.resolve(),

        ...availEngines.map(engine => (async () => {
          try {
            const map = await runEngineOnPages(engine, visionPages, pageToPath, langs, tmpDir, ctx);
            for (const [pageNo, text] of map) {
              if (pageEngineOutputs.has(pageNo)) pageEngineOutputs.get(pageNo)[engine.label] = text;
            }
            ctx.addDecision('s5', `${engine.label}_batch`, `${map.size}/${visionPages.length} pages`);
          } catch (e) { ctx.addError('s5', new Error(`${engine.label}: ${e.message}`), true); }
        })()),
      ]);
    }

    // ── Phase 3: Haiku synthesis for pages with any engine or Tesseract output (~$0.01/page) ─
    // Pages where at least one engine produced text get Haiku synthesis with image context.
    // Pages where engines produced nothing but Tesseract has words also use Haiku (not cloud).
    // Only pages with zero output from all sources (incl. Tesseract) go to cloud Phase 4.
    const pagesNeedingCloud = [];
    const synthModel = 'claude-haiku-4-5-20251001';
    const synthLimit = pLimit(ctx.config.visionConcurrency ?? 4);

    await Promise.all(visionPages.map(page => synthLimit(async () => {
      const outputs = pageEngineOutputs.get(page.pageNo) ?? {};
      const hasAnyOutput = Object.values(outputs).some(t => t?.trim());
      const hasTesseract = (page.words?.length ?? 0) > 0;

      // If no engine AND no Tesseract output → truly blank; only this goes to cloud
      if (!hasAnyOutput && !hasTesseract) { pagesNeedingCloud.push(page); return; }
      if (!ctx.config.apiKey || ctx.config.disableCloudVision) {
        // No API key — use best engine output directly (surya preferred, then first available)
        const bestText = outputs.surya || Object.values(outputs).find(t => t?.trim()) || '';
        if (bestText) {
          page.visionMd = deduplicateBlocks(bestText.trim());
          const { needsFull } = shouldVisionPage(page);
          if (needsFull) page.words = [];
          pagesAffected++;
          ctx.addDecision('s5', `page_${page.pageNo}`, 'engine_direct', page.visionMd.length);
        } else { pagesNeedingCloud.push(page); }
        return;
      }
      if (!withinBudget(ctx, 2000)) {
        ctx.addDecision('s5', 'budget_stop', `page ${page.pageNo}: token budget exhausted`);
        pagesNeedingCloud.push(page); return;
      }

      // Read the enhanced PNG for the synthesis image context
      const pngPath = page._s5PngPath;
      if (!pngPath || !existsSync(pngPath)) { pagesNeedingCloud.push(page); return; }
      const b64 = readFileSync(pngPath).toString('base64');

      try {
        const result = await synthesizeWithOcrContext(b64, ctx.config.apiKey, synthModel, page, outputs);
        const cleanText = deduplicateBlocks(result.text.trim());
        if (hasLatexArtifacts(cleanText)) page._visionHasLatex = true;
        page.visionMd = cleanText;
        const { needsFull } = shouldVisionPage(page);
        if (needsFull) page.words = [];
        totalIn += result.tokens_in; totalOut += result.tokens_out; totalCost += result.cost;
        pagesAffected++;
        const engineNames = Object.keys(outputs).join('+');
        ctx.addDecision('s5', `page_${page.pageNo}`, `haiku+[${engineNames}]`, page.visionMd.length);
      } catch (e) {
        ctx.addDecision('s5', `haiku_failed_p${page.pageNo}`, e.message);
        pagesNeedingCloud.push(page);
      }
    })));

    // ── Phase 4: Cloud fallback — only pages with zero output from ALL sources ───
    // boss → azure → google → claude-opus. Only for pages where no engine AND no Tesseract produced text.
    // This means genuinely unreadable scans (handwriting, extreme degradation) — not software failures.
    const chain = await buildBackendChain(ctx);
    if (pagesNeedingCloud.length > 0 && chain.length === 0) {
      ctx.addDecision('s5', 'cloud_skip', `${pagesNeedingCloud.length} pages need cloud but no backend configured`);
    }

    const cloudLimit = pLimit(ctx.config.visionConcurrency ?? 4);
    await Promise.all(pagesNeedingCloud.map(page => cloudLimit(async () => {
      if (!withinBudget(ctx, 2000)) {
        ctx.addDecision('s5', 'budget_stop', `page ${page.pageNo}: token budget exhausted`);
        return;
      }
      const pngPath = page._s5PngPath;
      if (!pngPath || !existsSync(pngPath)) return;
      const b64 = readFileSync(pngPath).toString('base64');
      const lang = page._lang ?? 'eng';
      let result = null, usedBackend = null;

      for (const backend of chain) {
        try { result = await backend.call(b64, lang, page); usedBackend = backend.name; break; }
        catch (e) { ctx.addDecision('s5', `${backend.name}_failed`, `page ${page.pageNo}: ${e.message}`); }
      }
      if (!result) return;

      const cleanText = deduplicateBlocks(result.text.trim());
      if (hasLatexArtifacts(cleanText)) page._visionHasLatex = true;
      page.visionMd = cleanText;
      const { needsFull } = shouldVisionPage(page);
      if (needsFull) page.words = [];
      totalIn += result.tokens_in; totalOut += result.tokens_out; totalCost += result.cost;
      pagesAffected++;
      ctx.addDecision('s5', `page_${page.pageNo}`, usedBackend, page.visionMd.length);
    })));

    // Record quality
    if (pagesAffected > 0) {
      const visionCoverage = pagesAffected / ctx.pages.length;
      const latexPages = visionPages.filter(p => p._visionHasLatex).length;
      const latexPenalty = latexPages / Math.max(1, visionPages.length);
      const s3Score = ctx.quality.perStage['s3'] ?? ctx.quality.baseline?.composite_score ?? 0;
      const s5Score = Math.min(1, (s3Score + visionCoverage * (1 - s3Score)) * (1 - latexPenalty * 0.8));
      if (latexPenalty > 0) ctx.addDecision('s5', 'latex_penalty', `${latexPages}/${visionPages.length} pages`);
      ctx.recordStageQuality('s5', Math.round(s5Score * 1000) / 1000);
    }
  } catch (err) {
    ctx.addError('s5', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    ctx.endStage('s5', { pages_affected: pagesAffected, tokens_in: totalIn, tokens_out: totalOut, cost_usd: totalCost });
  }

  return ctx;
}
