// Stage 3: Block segmentation → all CPU OCR engines in parallel → Haiku synthesis of all outputs.
// Exports: s3Ocr, parseHocr, repairHyphens, resolveLang, cleanRatio
// Deps: config.js (shouldRun, pLimit, llmCost), tool-runner.js (queryWorkerCapacity),
//       preprocess_image.py, detect_columns.py,
//       tesseract, surya_ocr (opt), easyocr_ocr.py (opt), paddle_ocr.py (opt),
//       doctr_ocr.py (opt), kraken_ocr.py (opt)
import { shouldRun, pLimit, llmCost } from '../config.js';
import { queryWorkerCapacity } from '../tool-runner.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';

const D_RASTER_DPI   = 300;
const D_LAYOUT_DPI   = 150;   // raised from 72 — newspaper columns need ≥150dpi for reliable detection
const D_CLEAN_PAGE   = 0.90;
const D_FUZZY_WORD   = 0.60;
const D_SURYA_CHUNK  = 20;    // max crops per surya_ocr call (GPU memory limit)
const D_MIN_BLOCKS   = 1;     // use block mode even with a single detected block
const D_SYNTH_THRESH = 0.70;  // Tesseract cleanRatio below this → try Haiku synthesis
const D_SYNTH_CONC   = 8;     // max concurrent Haiku synthesis calls
// Enhancement methods tried for layout detection, scored by block count not image quality.
// bleed_suppression is excluded: MedianFilter fills column gutters with mid-gray noise,
// which destroys the whitespace signal that Tesseract's RLSA needs to detect columns.
// Sharpen corrects blur introduced by downscaling (300→150 DPI blurs text edges).
// Otsu binarization makes gutters pure white / text pure black — ideal for RLSA.
const LAYOUT_ENH_METHODS = ['otsu', 'sharpen', 'otsu+sharpen', 'autocontrast'];
// Layout DPIs to evaluate. Higher DPI = better detail but slower. Scored by block count.
const LAYOUT_DPI_CANDIDATES = [150, 100, 200];

const execFileAsync = promisify(execFile);
const __pyDir       = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREPROCESS_PY  = join(__pyDir, 'preprocess_image.py');
const DETECT_COLS_PY = join(__pyDir, 'detect_columns.py');
const EASYOCR_PY     = join(__pyDir, 'easyocr_ocr.py');
const PADDLE_PY      = join(__pyDir, 'paddle_ocr.py');
const DOCTR_PY       = join(__pyDir, 'doctr_ocr.py');
const KRAKEN_PY      = join(__pyDir, 'kraken_ocr.py');

// Each engine runs as one Python process over ALL crops (amortizes model load).
// All engines run concurrently via Promise.all in Phase 2.
// Surya is separate (CLI tool, chunked for GPU memory).
// None of these are winners — all outputs are context for Haiku keyed correction.
const BATCH_ENGINES = [
  { label: 'easyocr', script: EASYOCR_PY, tool: 'easyocr_ocr' },
  { label: 'paddle',  script: PADDLE_PY,  tool: 'paddle_ocr'  },
  { label: 'doctr',   script: DOCTR_PY,   tool: 'doctr_ocr'   },
  { label: 'kraken',  script: KRAKEN_PY,  tool: 'kraken_ocr'  },
];

const TESS_TO_SURYA = { ara: 'ar', fas: 'fa', heb: 'he', chi_sim: 'zh', 'chi_sim+chi_tra': 'zh', jpn: 'ja', kor: 'ko', rus: 'ru', fra: 'fr', deu: 'de', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', pol: 'pl', tur: 'tr', eng: 'en' };
const TESS_LANG = { arabic: 'ara', persian: 'fas', hebrew: 'heb', chinese: 'chi_sim+chi_tra', japanese: 'jpn', korean: 'kor', russian: 'rus', french: 'fra', german: 'deu', spanish: 'spa', italian: 'ita', portuguese: 'por', dutch: 'nld', polish: 'pol', turkish: 'tur', english: 'eng' };
const ISO_TESS = { fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol', tr: 'tur', ru: 'rus', ar: 'ara', fa: 'fas', he: 'heb', ja: 'jpn', zh: 'chi_sim', ko: 'kor' };
const VALID_TESS = new Set(['eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol', 'tur', 'rus', 'ara', 'fas', 'heb', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'chi_sim+jpn', 'chi_sim+chi_tra']);

export function resolveLang(regionType, metaLang) {
  if (regionType === 'printed_arabic') return 'ara';
  if (regionType === 'printed_persian') return 'fas';
  if (regionType === 'printed_cjk') return 'chi_sim+jpn';
  if (metaLang) {
    const key = metaLang.toLowerCase();
    if (VALID_TESS.has(key)) return key;
    if (TESS_LANG[key]) return TESS_LANG[key];
    if (ISO_TESS[key]) return ISO_TESS[key];
  }
  return 'eng';
}

export function repairHyphens(words) {
  if (!words.length) return words;
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = { ...words[i] };
    if (w.text.endsWith('-') && i + 1 < words.length) {
      const next = words[i + 1];
      const frag = w.text.slice(0, -1);
      if (frag.length > 1 && /^[a-z\u00c0-\u024f]/i.test(next.text)) {
        out.push({ ...w, text: frag + next.text + ' ', x2: next.x2, conf: Math.min(w.conf, next.conf) });
        i += 2;
        continue;
      }
    }
    out.push({ ...w, text: w.text + ' ' });
    i++;
  }
  return out;
}

export function parseHocr(hocr, pageNo) {
  const raw_words = [];
  const re = /<span[^>]+class='(?:ocr|ocrx)_word'[^>]+title='([^']*)'[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(hocr)) !== null) {
    const title = m[1], inner = m[2];
    const bboxM = title.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const confM = title.match(/x_wconf\s+(\d+)/);
    const conf = confM ? parseInt(confM[1]) : 0;
    const text = inner.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n))).trim();
    if (!text) continue;
    raw_words.push({ text, x1: +bboxM[1], y1: +bboxM[2], x2: +bboxM[3], y2: +bboxM[4], conf, source: 'tesseract', pageNo });
  }
  return repairHyphens(raw_words);
}

export function cleanRatio(words, cleanT) {
  if (!words.length) return 0;
  return words.filter(w => w.conf >= cleanT).length / words.length;
}

async function tryEnhance(pngPath, enhancedPath, extraArgs = []) {
  try {
    const { stdout } = await execFileAsync('python3', [PREPROCESS_PY, ...extraArgs, pngPath, enhancedPath], { timeout: 30000 });
    const result = JSON.parse(stdout.trim());
    return result.enhanced ? { path: enhancedPath, ...result } : null;
  } catch { return null; }
}

async function tryEnhanceForced(pngPath, enhancedPath, extraArgs = []) {
  try {
    const { stdout } = await execFileAsync('python3', [PREPROCESS_PY, '--force', ...extraArgs, pngPath, enhancedPath], { timeout: 30000 });
    const result = JSON.parse(stdout.trim());
    return result.enhanced ? { path: enhancedPath, ...result } : null;
  } catch { return null; }
}

async function runTesseract(pngPath, lang, pageNo, ctx) {
  const { stdout } = await ctx.run('tesseract', [pngPath, 'stdout', 'hocr', '-l', lang], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  return parseHocr(stdout, pageNo);
}

// Try each lang candidate with Tesseract, return words from the best-scoring run.
// Records the winning lang on each word so downstream can see which lang worked.
async function runTesseractBestLang(pngPath, langCandidates, pageNo, ctx, cleanT) {
  let best = null;
  for (const { lang: candLang } of langCandidates) {
    try {
      const words = await runTesseract(pngPath, candLang, pageNo, ctx);
      const score = cleanRatio(words, cleanT);
      if (!best || score > best.score)
        best = { words: words.map(w => ({ ...w, detectedLang: candLang })), score, lang: candLang };
    } catch { /* try next candidate */ }
  }
  return best ?? { words: [], score: 0, lang: langCandidates[0]?.lang ?? 'eng' };
}

async function runTesseractLayout(pngPath, lang, ctx) {
  const { stdout } = await ctx.run('tesseract', [pngPath, 'stdout', 'hocr', '--psm', '1', '-l', lang], { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
  return stdout;
}

// Returns {blocks, rawCount, filteredSizes} — rawCount and filteredSizes are for diagnostics.
// Size filter: blocks smaller than 50×40px at D_LAYOUT_DPI are noise. Scale-adjust if needed.
function parseHocrBlocks(hocr) {
  const blocks = [];
  const filteredSizes = [];
  let rawCount = 0;
  const re = /<div[^>]+class='ocr_carea'[^>]+title='([^']*)'[^>]*>/g;
  let m;
  while ((m = re.exec(hocr)) !== null) {
    rawCount++;
    const bboxM = m[1].match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const x1 = +bboxM[1], y1 = +bboxM[2], x2 = +bboxM[3], y2 = +bboxM[4];
    const w = x2 - x1, h = y2 - y1;
    if (w < 50 || h < 40) { filteredSizes.push(`${w}×${h}`); continue; }
    blocks.push({ x1, y1, x2, y2 });
  }
  return { blocks, rawCount, filteredSizes };
}

// Two questions in one API call: (1) which preprocessing methods reveal column whitespace,
// (2) what language is the text. Same image answers both. Cost: ~$0.0002 per page.
// Language detection here may differ from metadata — a French-catalogued journal may be Arabic.
// Result is added to page._langCandidates (accumulated, never overrides prior candidates).
async function consultVisionForPreprocessing(layoutPng, apiKey, ctx) {
  try {
    const thumbPath = `${layoutPng}.consult_thumb.jpg`;
    await ctx.run('convert', [layoutPng, '-resize', '400x', '-quality', '80', thumbPath], { timeout: 10000 });
    if (!existsSync(thumbPath)) return { methods: [], lang: null };
    const imgB64 = readFileSync(thumbPath).toString('base64');
    try { rmSync(thumbPath); } catch {}
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgB64 } },
          { type: 'text', text: 'Scanned document. Reply ONLY with JSON {"methods":["otsu"],"lang":"fra"} — methods: 1-3 from ["otsu","sharpen","unsharp_mask","otsu+sharpen","autocontrast","faded_boost"] that best reveal column whitespace; lang: Tesseract language code (eng/fra/deu/ara/fas/rus/etc). No explanation.' },
        ]}],
      }),
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text?.trim() ?? '{}';
    const match = text.match(/\{[\s\S]*?\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const methods = (parsed.methods ?? []).filter(m => typeof m === 'string' && m.length < 30);
    const lang = (typeof parsed.lang === 'string' && VALID_TESS.has(parsed.lang)) ? parsed.lang : null;
    return { methods, lang };
  } catch { return { methods: [], lang: null }; }
}

// Try all LAYOUT_DPI_CANDIDATES when block count is 0, returning the best {dpi, layoutPng, dpiScale}.
// Rasterizes at each DPI then runs findBestLayoutForSegmentation.
async function findBestLayoutDpi(sourcePath, pageNo, lang, tmpDir, ctx) {
  let best = null;
  for (const dpi of LAYOUT_DPI_CANDIDATES) {
    const layoutBase = join(tmpDir, `p${pageNo}_layout_${dpi}dpi`);
    const layoutPng = `${layoutBase}.png`;
    try {
      if (!existsSync(layoutPng))
        await ctx.run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(pageNo), '-l', String(pageNo), '-singlefile', sourcePath, layoutBase], { timeout: 30000 });
      if (!existsSync(layoutPng)) continue;
      const candidate = await findBestLayoutForSegmentation(layoutPng, lang, tmpDir, pageNo, ctx);
      if (!best || candidate.blocks.length > best.result.blocks.length) {
        best = { dpi, layoutPng, dpiScale: (ctx.config.rasterDpi ?? D_RASTER_DPI) / dpi, result: candidate };
      }
      if (best.result.blocks.length >= 2) break; // good enough — stop early
    } catch { /* skip this DPI */ }
  }
  return best;
}

// Try several layout-safe enhancement methods (scored by block count, not image quality).
// Returns { label, path, blocks, rawCount, filteredSizes } for the best candidate.
// Pass methods=[] to override which enhancement methods to try (defaults to LAYOUT_ENH_METHODS).
async function findBestLayoutForSegmentation(layoutPng, lang, tmpDir, pageNo, ctx, methods = null) {
  const candidates = [];

  // Baseline: raw unenhanced image
  try {
    const rawHocr = await runTesseractLayout(layoutPng, lang, ctx);
    const parsed = parseHocrBlocks(rawHocr);
    candidates.push({ label: 'raw', path: layoutPng, ...parsed });
  } catch {
    candidates.push({ label: 'raw', path: layoutPng, blocks: [], rawCount: 0, filteredSizes: [] });
  }

  // Try each layout-safe enhancement; --force bypasses the "needs_contrast" gate
  const methodsToTry = methods ?? LAYOUT_ENH_METHODS;
  for (const method of methodsToTry) {
    const enhPath = join(tmpDir, `p${pageNo}_layout_${method}.png`);
    try {
      const { stdout } = await execFileAsync('python3',
        [PREPROCESS_PY, '--force', '--method', method, layoutPng, enhPath],
        { timeout: 30000 });
      const enhResult = JSON.parse(stdout.trim() || '{}');
      if (enhResult.enhanced && existsSync(enhPath)) {
        try {
          const enhHocr = await runTesseractLayout(enhPath, lang, ctx);
          const parsed = parseHocrBlocks(enhHocr);
          candidates.push({ label: method, path: enhPath, ...parsed });
        } catch {
          candidates.push({ label: method, path: enhPath, blocks: [], rawCount: 0, filteredSizes: [] });
        }
      }
    } catch { /* skip this method */ }
  }

  // Winner = most usable blocks; tie-break by raw count
  candidates.sort((a, b) => b.blocks.length - a.blocks.length || b.rawCount - a.rawCount);
  return candidates[0];
}

// ── Engine availability checks ────────────────────────────────────────────────────────────────
const _engineCheckCache = new Map(); // cache per process: tool → boolean
let _suryaCheckResult = null;              // cache per process: surya CLI available

async function checkSuryaCli(ctx) {
  if (_suryaCheckResult !== null) return _suryaCheckResult;
  try {
    await ctx.run('surya_ocr', ['--help'], { timeout: 5000 });
    _suryaCheckResult = true;
  } catch (e) { _suryaCheckResult = e.code !== 'ENOENT'; }
  return _suryaCheckResult;
}

async function checkPythonEngine(toolName, ctx) {
  if (_engineCheckCache.has(toolName)) return _engineCheckCache.get(toolName);
  try {
    const { stdout } = await ctx.run(toolName, ['--check'], { timeout: 15000 });
    const ok = stdout.trim() === 'ok';
    _engineCheckCache.set(toolName, ok);
    return ok;
  } catch {
    _engineCheckCache.set(toolName, false);
    return false;
  }
}

// ── Surya (GPU-friendly batch via CLI, chunked) ───────────────────────────────────────────────

async function runSuryaChunked(cropRegistry, langs, tmpDir, ctx) {
  const suryaMap = new Map();
  for (let i = 0; i < cropRegistry.length; i += D_SURYA_CHUNK) {
    const chunk = cropRegistry.slice(i, i + D_SURYA_CHUNK);
    const chunkInDir  = join(tmpDir, `surya-in-${i}`);
    const chunkOutDir = join(tmpDir, `surya-out-${i}`);
    mkdirSync(chunkInDir, { recursive: true });
    for (const c of chunk) writeFileSync(join(chunkInDir, `${c.cropStem}.png`), readFileSync(c.cropPath));
    try {
      mkdirSync(chunkOutDir, { recursive: true });
      await ctx.run('surya_ocr', [chunkInDir, '--langs', langs, '--results_dir', chunkOutDir], { timeout: 300000 });
      const resultsPath = join(chunkOutDir, 'results.json');
      if (existsSync(resultsPath)) {
        const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
        for (const [key, value] of Object.entries(results)) {
          const entry = Array.isArray(value) ? value[0] : value;
          const lines = entry?.text_lines ?? [];
          const text = lines.map(l => l.text ?? '').filter(Boolean).join('\n').trim();
          if (text) suryaMap.set(key, { text, lines });
        }
        ctx.addDecision('s3', 'surya_batch', `chunk ${i}: ${suryaMap.size}/${chunk.length} crops`);
      }
    } catch (e) {
      ctx.addError('s3', new Error(`surya batch chunk ${i}: ${e.message}`), true);
    } finally {
      try { rmSync(chunkInDir,  { recursive: true, force: true }); } catch {}
      try { rmSync(chunkOutDir, { recursive: true, force: true }); } catch {}
    }
  }
  return suryaMap;
}

// Convert Surya text_lines → word objects. ox/oy are page-coord offsets of the crop.
function suryaLinesToWords(lines, pageNo, ox, oy) {
  const words = [];
  for (const line of lines) {
    const text = (line.text ?? '').trim();
    if (!text) continue;
    const bbox = line.bbox;
    let lx1 = ox, ly1 = oy, lx2 = ox + 100, ly2 = oy + 20;
    if (Array.isArray(bbox) && bbox.length >= 2) {
      const xs = bbox.map(p => (Array.isArray(p) ? p[0] : (p.x ?? 0)));
      const ys = bbox.map(p => (Array.isArray(p) ? p[1] : (p.y ?? 0)));
      lx1 = Math.min(...xs) + ox; ly1 = Math.min(...ys) + oy;
      lx2 = Math.max(...xs) + ox; ly2 = Math.max(...ys) + oy;
    }
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const charW = (lx2 - lx1) / Math.max(text.length, 1);
    let cx = lx1;
    for (const tok of tokens) {
      const tw = tok.length * charW;
      words.push({ text: tok + ' ', x1: cx, y1: ly1, x2: Math.min(cx + tw, lx2), y2: ly2, conf: 85, source: 'surya', pageNo });
      cx += tw + charW;
    }
  }
  return words;
}

// ── Python batch engines (EasyOCR, PaddleOCR, docTR, Kraken) ─────────────────────────────────

// Run a batch engine over crops, chunked for parallel serve pool utilization. Returns Map<cropStem, {text, words}>.
async function runEngineBatch(toolName, label, cropRegistry, langs, tmpDir, ctx, chunkSize = 20) {
  if (cropRegistry.length === 0) return new Map();
  // Split into chunks so each chunk hits a separate serve pool instance in parallel
  const chunks = [];
  for (let i = 0; i < cropRegistry.length; i += chunkSize) chunks.push(cropRegistry.slice(i, i + chunkSize));

  const allEntries = await Promise.all(chunks.map(async (chunk, ci) => {
    const inputDir   = join(tmpDir, `${label}-in-${ci}`);
    const outputJson = join(tmpDir, `${label}-out-${ci}.json`);
    mkdirSync(inputDir, { recursive: true });
    for (const c of chunk) {
      if (existsSync(c.cropPath))
        writeFileSync(join(inputDir, `${c.cropStem}.png`), readFileSync(c.cropPath));
    }
    await ctx.run(toolName, [inputDir, outputJson, langs], { timeout: 600000 });
    if (!existsSync(outputJson)) return [];
    return Object.entries(JSON.parse(readFileSync(outputJson, 'utf8')));
  }));

  const map = new Map();
  for (const entries of allEntries) {
    for (const [stem, val] of entries) {
      if (val.text?.trim()) map.set(stem, val);
    }
  }
  return map;
}

// Convert batch engine word list (with crop-relative coords) to full-page word objects.
function engineWordsToPageWords(words, pageNo, ox, oy, source) {
  return (words ?? [])
    .filter(w => w.text?.trim())
    .map(w => ({
      text: w.text.trim() + ' ',
      conf: w.conf ?? 75,
      x1: (w.x1 ?? 0) + ox, y1: (w.y1 ?? 0) + oy,
      x2: (w.x2 ?? 0) + ox, y2: (w.y2 ?? 0) + oy,
      source, pageNo,
    }));
}

// ── Haiku keyed-correction synthesis ─────────────────────────────────────────────────────────
// Tesseract words are the spatial anchor (bbox positions). All other engine outputs are context.
// Haiku returns ONLY a correction map {wordIdx: "fixed"} or {wordIdx: null} (deletion/join).
// Minimal output tokens → less hallucination, lower cost, positions preserved.

// Keyed correction architecture: Tesseract words are the spatial anchor (bbox positions).
// All other engines are context only. Haiku returns corrections by word index, not full text.
// This preserves bboxes for the archival PDF text layer while correcting OCR errors.
// * marks low-confidence words (below fuzzyT) so Haiku knows where to focus.
// max_tokens: 200 — corrections are tiny (~1 token per changed word) vs full text (~word_count tokens).
// Fewer output tokens = less hallucination risk.
function buildCorrectionPrompt(tessWords, batchResults, cropStem, lang, cleanT) {
  // Compact Tesseract line: "0:word 1:*lowconf 2:word ..."  (* = low confidence)
  const tessLine = tessWords
    .map((w, i) => `${i}:${w.conf < cleanT ? '*' : ''}${w.text.trim()}`)
    .join(' ');
  const engineLines = batchResults
    .map(({ label, map }) => {
      const r = map.get(cropStem);
      return r?.text?.trim() ? `${label.toUpperCase()}: ${r.text.slice(0, 300)}` : null;
    })
    .filter(Boolean)
    .join('\n');
  return `Correct OCR errors in this ${lang} text. Tesseract word positions are the anchor (* = low confidence). Other engines are context only.\n\nTESSERACT:\n${tessLine}${engineLines ? `\n\n${engineLines}` : ''}\n\nReturn ONLY a JSON object mapping word index to corrected string, or null to delete (use after merging a hyphenated pair into the previous entry). Omit unchanged words. Example: {"3":"corrected","7":"joined","8":null}\nJSON only, no explanation.`;
}

function parseCorrectionResponse(text) {
  try {
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return {};
    const raw = JSON.parse(match[0]);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && (v === null || typeof v === 'string')) out[idx] = v;
    }
    return out;
  } catch { return {}; }
}

// Merge corrections into tessWords in-place (preserving all bboxes).
// null = deleted word (joined into previous). Same-line check: extend prev x2 to cover deleted word's
// x2 only when y-centers are within 0.75 line-heights. Guards against spurious bbox extension
// when a hyphenated pair wraps across lines (prev on line N, null word on line N+1).
function applyCorrections(tessWords, corrections) {
  if (!Object.keys(corrections).length) return tessWords;
  const result = [];
  for (let i = 0; i < tessWords.length; i++) {
    const w = tessWords[i];
    if (!(i in corrections)) { result.push({ ...w }); continue; }
    const v = corrections[i];
    if (v === null) {
      // Deleted (joined into previous word). Extend prev bbox if same line.
      if (result.length > 0) {
        const prev = result[result.length - 1];
        const lineH = Math.max(1, prev.y2 - prev.y1);
        const sameLine = Math.abs((prev.y1 + prev.y2) / 2 - (w.y1 + w.y2) / 2) < lineH * 0.75;
        if (sameLine) prev.x2 = Math.max(prev.x2, w.x2);
      }
      // word dropped — not pushed
    } else {
      result.push({ ...w, text: v + ' ', source: 'synthesis' });
    }
  }
  return result;
}

export async function s3Ocr(ctx) {
  if (!shouldRun('s3', ctx)) return ctx;
  ctx.beginStage('s3');

  let pagesAffected = 0, tokensIn = 0, tokensOut = 0, costUsd = 0;
  const routingSummary = {};
  const cleanT = (ctx.config.thresholds?.cleanPage ?? D_CLEAN_PAGE) * 100;
  const fuzzyT = (ctx.config.thresholds?.fuzzyWord ?? D_FUZZY_WORD) * 100;
  const dpi = ctx.config.rasterDpi ?? D_RASTER_DPI;
  const dpiScale = dpi / D_LAYOUT_DPI;
  const prepCfg = ctx.config.preprocessing ?? {};
  const forceContrast = prepCfg.forceContrast ?? false;
  const extraArgs = [
    ...(ctx._scanIssues?.length ? ['--issues', ctx._scanIssues.join(',')] : []),
    ...(prepCfg.method ? ['--method', prepCfg.method] : []),
  ];

  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 16);
  const tmpDir = join(getTmpDir(), `site2rag-s3-${docHash}`);
  const cropDir = join(tmpDir, 'block-crops');
  mkdirSync(cropDir, { recursive: true });

  // cropRegistry: blocks that will be passed to Surya + Haiku after the page loop
  // { page, blockIdx, bx1, by1, bx2, by2, cropPath, cropStem, tessWords, lang }
  const cropRegistry = [];
  // Dynamic page concurrency: sum available tesseract slots across registered workers.
  // Falls back to 8 when not using workerPool or workers are unreachable.
  // Prevents under-utilising multi-worker deployments (4 workers × 6 slots = 24 concurrent pages).
  const workerTesseractSlots = await queryWorkerCapacity('tesseract', ctx.config).catch(() => null);
  const pageLimit = pLimit(workerTesseractSlots ?? 8);

  // Calibration page: page 2 (first real text page after cover).
  // Cover (page 1) is often color-scanned differently; page 2 represents document body style.
  // Winning {method, dpi} is reused as a fast path for all subsequent pages.
  const calibPageNo = ctx.pages.length >= 2 ? 2 : 1;

  try {
    // ── Pre-calibration: find best layout settings from page 2 before the parallel loop ────────
    // This ensures ctx._layoutCalibration is set before pages 3+ start (parallel loop).
    if (ctx._scanIssues?.length > 0) {
      const calibSrcPage = ctx.pages.find(p => p.pageNo === calibPageNo);
      if (calibSrcPage) {
        const calibLang = ctx.config.s3Lang ??
          resolveLang(calibSrcPage.regions?.[0]?.type ?? null, ctx.meta?.language);
        const calibLayoutBase = join(tmpDir, `p${calibPageNo}_layout`);
        const calibLayoutPng = `${calibLayoutBase}.png`;
        try {
          if (!existsSync(calibLayoutPng))
            await ctx.run('pdftoppm', ['-png', '-r', String(D_LAYOUT_DPI), '-f', String(calibPageNo), '-l', String(calibPageNo), '-singlefile', ctx.sourcePath, calibLayoutBase], { timeout: 30000 });
          if (existsSync(calibLayoutPng)) {
            const calBest = await findBestLayoutDpi(ctx.sourcePath, calibPageNo, calibLang, tmpDir, ctx);
            if (calBest && calBest.result.blocks.length >= D_MIN_BLOCKS) {
              ctx._layoutCalibration = { method: calBest.result.label, dpi: calBest.dpi };
              ctx.addDecision('s3', 'calibration',
                `page ${calibPageNo}: ${calBest.result.label}@${calBest.dpi}dpi → ${calBest.result.blocks.length} blocks`);
            }
          }
        } catch (e) {
          ctx.addDecision('s3', 'calibration', `page ${calibPageNo} failed: ${e.message}`);
        }
      }
    }

    // ── Phase 1: Rasterize + layout + Tesseract per block (parallel across pages) ─────────────
    await Promise.all(ctx.pages.map(page => pageLimit(async () => {
      try {
        if (page.regions?.length && page.regions.every(r => r.type === 'figure')) {
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
          return;
        }

        const regionType = page.regions?.[0]?.type ?? null;
        const lang = ctx.config.s3Lang ?? resolveLang(regionType, ctx.meta?.language);
        page._lang = lang;
        // Language candidates accumulate across pipeline stages; never overridden.
        // Tesseract runs once per candidate; best cleanRatio wins that block.
        // Handles multi-language documents (English title, Arabic body, Persian endnotes).
        page._langCandidates = [{ lang, source: 'metadata' }];
        routingSummary[lang] = (routingSummary[lang] ?? 0) + 1;

        const outBase = join(tmpDir, `p${page.pageNo}`);
        const pngPath = `${outBase}.png`;
        const layoutBase = join(tmpDir, `p${page.pageNo}_layout`);
        const layoutPng = `${layoutBase}.png`;

        await Promise.all([
          existsSync(pngPath) ? null : ctx.run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page.pageNo), '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, outBase], { timeout: 60000 }),
          existsSync(layoutPng) ? null : ctx.run('pdftoppm', ['-png', '-r', String(D_LAYOUT_DPI), '-f', String(page.pageNo), '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, layoutBase], { timeout: 30000 }),
        ]);

        if (existsSync(pngPath) && statSync(pngPath).size < 100)
          throw new Error(`pdftoppm produced corrupt PNG for page ${page.pageNo}`);
        page._pngPath = pngPath;

        // Layout pass → block bounding boxes.
        // Strategy: Tesseract --psm 1 on UNENHANCED layout image first.
        // Enhancement is intentionally skipped here — visual analysis showed it destroys
        // column gutters (posterization fills whitespace with noise), giving Tesseract zero blocks.
        // Geometric fallback: projection-profile column detection works even on degraded scans.
        let blocks = [];
        const layoutExists = existsSync(layoutPng) && statSync(layoutPng).size > 100;

        if (layoutExists) {
          let bestLayout = { label: 'raw', path: layoutPng, blocks: [], rawCount: 0, filteredSizes: [] };

          // Fast path: apply page-2-calibrated {method, dpi} before running the full search.
          // Saves 3–5 Tesseract + enhancement calls per page on typical multi-column documents.
          // Falls through (blocks stays 0) if calibration produces < D_MIN_BLOCKS.
          if (ctx._layoutCalibration && page.pageNo > calibPageNo) {
            const { method: calMethod, dpi: calDpi } = ctx._layoutCalibration;
            const calBase = join(tmpDir, `p${page.pageNo}_layout_${calDpi}dpi`);
            const calPng = `${calBase}.png`;
            try {
              if (!existsSync(calPng))
                await ctx.run('pdftoppm', ['-png', '-r', String(calDpi), '-f', String(page.pageNo), '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, calBase], { timeout: 30000 });
              if (existsSync(calPng)) {
                const calResult = await findBestLayoutForSegmentation(calPng, lang, tmpDir, page.pageNo, ctx, calMethod === 'raw' ? [] : [calMethod]);
                if (calResult.blocks.length >= D_MIN_BLOCKS) {
                  bestLayout = calResult;
                  blocks = calResult.blocks;
                  if (calDpi !== D_LAYOUT_DPI) page._layoutDpiScale = dpi / calDpi;
                  ctx.addDecision('s3', `layout_p${page.pageNo}`,
                    `calibrated ${calMethod}@${calDpi}dpi: ${calResult.rawCount} raw → ${blocks.length} usable`);
                }
              }
            } catch { /* fall through to full search */ }
          }

          // 1. Full enhancement search — skipped if calibration fast path already found blocks.
          // bleed_suppression excluded: fills column gutters with noise, destroying RLSA signal.
          if (blocks.length < D_MIN_BLOCKS) {
            try {
              bestLayout = await findBestLayoutForSegmentation(layoutPng, lang, tmpDir, page.pageNo, ctx);
              blocks = bestLayout.blocks;
              const filterNote = bestLayout.filteredSizes.length
                ? `, filtered ${bestLayout.filteredSizes.length} noise (${bestLayout.filteredSizes.slice(0,3).join(', ')})`
                : '';
              ctx.addDecision('s3', `layout_p${page.pageNo}`,
                `${bestLayout.label}: ${bestLayout.rawCount} raw → ${blocks.length} usable${filterNote}`);
            } catch (e) {
              ctx.addDecision('s3', `layout_p${page.pageNo}`, `layout detection failed: ${e.message}`);
            }
          }

          // 2. Multi-DPI search — different resolutions reveal different column detail.
          // Only for scanned image PDFs (ctx._scanIssues set by s1); text PDFs skip this.
          if (blocks.length < D_MIN_BLOCKS && ctx._scanIssues?.length > 0) {
            try {
              const dpiSearch = await findBestLayoutDpi(ctx.sourcePath, page.pageNo, lang, tmpDir, ctx);
              if (dpiSearch && dpiSearch.result.blocks.length > blocks.length) {
                bestLayout = dpiSearch.result;
                blocks = dpiSearch.result.blocks;
                page._layoutDpiScale = dpiSearch.dpiScale;
                ctx.addDecision('s3', `layout_p${page.pageNo}`,
                  `dpi_search ${dpiSearch.dpi}: ${dpiSearch.result.rawCount} raw → ${blocks.length} usable via ${dpiSearch.result.label}`);
              }
            } catch (e) {
              ctx.addDecision('s3', `layout_p${page.pageNo}`, `dpi_search failed: ${e.message}`);
            }
          }

          // 4. Vision-guided enhancement — when all standard methods fail, ask Haiku what to try.
          // Also asks for language identification — a clearer image may reveal a different script.
          // Sends a small thumbnail; costs ~$0.0002 per page. Only for scanned image PDFs.
          if (blocks.length < D_MIN_BLOCKS && ctx._scanIssues?.length > 0 && ctx.config.apiKey) {
            try {
              const { methods: visionMethods, lang: visionLang } = await consultVisionForPreprocessing(layoutPng, ctx.config.apiKey, ctx);
              if (visionLang && !page._langCandidates.some(c => c.lang === visionLang)) {
                page._langCandidates.push({ lang: visionLang, source: 's3_vision' });
                routingSummary[visionLang] = (routingSummary[visionLang] ?? 0) + 1;
                ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision lang candidate: ${visionLang} (have: ${page._langCandidates.map(c=>c.lang).join(',')})`);
              }
              const effectiveLang = visionLang ?? lang;
              if (visionMethods.length > 0) {
                ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision suggested: [${visionMethods.join(', ')}]`);
                const visionBest = await findBestLayoutForSegmentation(layoutPng, effectiveLang, tmpDir, page.pageNo, ctx, visionMethods);
                if (visionBest.blocks.length > blocks.length) {
                  bestLayout = visionBest;
                  blocks = visionBest.blocks;
                  ctx.addDecision('s3', `layout_p${page.pageNo}`,
                    `vision-guided ${visionBest.label}: ${visionBest.rawCount} raw → ${blocks.length} usable`);
                }
              }
            } catch (e) {
              ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision consult failed: ${e.message}`);
            }
          }

          // 5. Geometric fallback: horizontal projection profile column detection
          if (blocks.length < D_MIN_BLOCKS) {
            try {
              const geoOut = await execFileAsync('python3', [DETECT_COLS_PY, layoutPng], { timeout: 15000 });
              const geoCols = JSON.parse(geoOut.stdout.trim() || '[]');
              // Scale from layout DPI → raster DPI coords for the block crop step
              const geoBlocks = geoCols.map(b => ({
                x1: Math.round(b.x1 * dpiScale), y1: Math.round(b.y1 * dpiScale),
                x2: Math.round(b.x2 * dpiScale), y2: Math.round(b.y2 * dpiScale),
                _geoDetected: true,
              }));
              if (geoBlocks.length > 0) {
                blocks = geoBlocks;
                ctx.addDecision('s3', `layout_p${page.pageNo}`,
                  `geometric: ${geoBlocks.length} columns detected via projection profile`);
              } else {
                ctx.addDecision('s3', `layout_p${page.pageNo}`, 'geometric: no columns found — full-page fallback');
              }
            } catch (e) {
              ctx.addDecision('s3', `layout_p${page.pageNo}`, `geometric failed: ${e.message}`);
            }
          }

          // 6. Debug: save raw layout, winning enhanced layout, fullres, and annotated blocks
          if (ctx.config.debug) {
            try {
              const srcDir = dirname(ctx.sourcePath);
              const srcStem = basename(ctx.sourcePath, '.pdf');
              const dbgDir = join(srcDir, 'debug', srcStem);
              mkdirSync(dbgDir, { recursive: true });
              copyFileSync(layoutPng, join(dbgDir, `p${page.pageNo}_layout_raw.png`));
              if (bestLayout.label !== 'raw' && existsSync(bestLayout.path))
                copyFileSync(bestLayout.path, join(dbgDir, `p${page.pageNo}_layout_${bestLayout.label}.png`));
              if (existsSync(pngPath)) copyFileSync(pngPath, join(dbgDir, `p${page.pageNo}_fullres.png`));
              if (blocks.length > 0) {
                const dbgDpiScale = page._layoutDpiScale ?? dpiScale;
                const drawArgs = blocks.flatMap(b => {
                  const bx1 = b._geoDetected ? Math.round(b.x1 / dbgDpiScale) : b.x1;
                  const by1 = b._geoDetected ? Math.round(b.y1 / dbgDpiScale) : b.y1;
                  const bx2 = b._geoDetected ? Math.round(b.x2 / dbgDpiScale) : b.x2;
                  const by2 = b._geoDetected ? Math.round(b.y2 / dbgDpiScale) : b.y2;
                  const color = b._geoDetected ? 'blue' : 'red';
                  return ['-fill', 'none', '-stroke', color, '-strokewidth', '3',
                    '-draw', `rectangle ${bx1},${by1} ${bx2},${by2}`];
                });
                await ctx.run('convert', [bestLayout.path, ...drawArgs, join(dbgDir, `p${page.pageNo}_blocks.png`)], { timeout: 10000 });
              }
            } catch { /* debug output is never fatal */ }
          }
        }

        if (blocks.length >= D_MIN_BLOCKS) {
          // Block mode: crop each block, run Tesseract on each in parallel.
          // _geoDetected blocks are in raster-DPI coords; Tesseract blocks need scaling.
          // page._layoutDpiScale overrides when a non-default DPI was used for layout detection.
          const effectiveDpiScale = page._layoutDpiScale ?? dpiScale;
          await Promise.all(blocks.map(async (blk, bi) => {
            const bx1 = blk._geoDetected ? blk.x1 : Math.floor(blk.x1 * effectiveDpiScale);
            const by1 = blk._geoDetected ? blk.y1 : Math.floor(blk.y1 * effectiveDpiScale);
            const bx2 = blk._geoDetected ? blk.x2 : Math.ceil(blk.x2  * effectiveDpiScale);
            const by2 = blk._geoDetected ? blk.y2 : Math.ceil(blk.y2  * effectiveDpiScale);
            const bw = bx2 - bx1, bh = by2 - by1;
            const cropStem = `p${page.pageNo}_b${bi}`;
            const cropPath = join(cropDir, `${cropStem}.png`);
            try {
              await ctx.run('convert', [pngPath, '-crop', `${bw}x${bh}+${bx1}+${by1}`, '+repage', cropPath], { timeout: 15000 });
              if (!existsSync(cropPath)) return;

              const cropEnh = join(tmpDir, `${cropStem}_enh.png`);
              const enh = forceContrast
                ? await tryEnhanceForced(cropPath, cropEnh, extraArgs)
                : await tryEnhance(cropPath, cropEnh, extraArgs);

              // INVARIANT: ocrPath (not cropPath) must be stored in cropRegistry.
              // All batch engines (EasyOCR, Paddle, docTR, Kraken, Surya) read cropPath from the registry.
              // Using raw cropPath here means enhancement is wasted — only Tesseract sees the clean image.
              // This has silently regressed multiple times. Do not change cropPath: ocrPath below.
              const ocrPath = enh?.path ?? cropPath;
              const { words: tessWords, lang: winLang } = await runTesseractBestLang(
                ocrPath, page._langCandidates, page.pageNo, ctx, cleanT);
              // Map crop-relative coords to full-page coords
              const mapped = tessWords.map(w => ({ ...w, x1: w.x1 + bx1, y1: w.y1 + by1, x2: w.x2 + bx1, y2: w.y2 + by1 }));
              cropRegistry.push({ page, blockIdx: bi, bx1, by1, bx2, by2, cropPath: ocrPath, cropStem, tessWords: mapped, lang: winLang });
            } catch { /* skip failed block — Surya/Haiku may recover */ }
          }));

          const blockCount = cropRegistry.filter(c => c.page === page).length;
          ctx.addDecision('s3', `blocks_p${page.pageNo}`, `${blocks.length} blocks detected, ${blockCount} OCR'd`);
          page.words = null; // assembled in Phase 3

        } else {
          // Full-page fallback — try all lang candidates; run enhancement in parallel with first pass
          const [origResult, enhancement] = await Promise.all([
            runTesseractBestLang(pngPath, page._langCandidates, page.pageNo, ctx, cleanT),
            forceContrast
              ? tryEnhanceForced(pngPath, `${outBase}_enhanced.png`, extraArgs)
              : tryEnhance(pngPath, `${outBase}_enhanced.png`, extraArgs),
          ]);
          const origScore = origResult.score;
          let words = origResult.words;

          if (enhancement) {
            try {
              const { words: enhWords, score: enhScore } = await runTesseractBestLang(
                `${outBase}_enhanced.png`, page._langCandidates, page.pageNo, ctx, cleanT);
              if (enhScore > origScore) {
                words = enhWords.map(w => ({ ...w, source: 'tesseract+contrast' }));
                page._pngPath = `${outBase}_enhanced.png`;
                ctx.addDecision('s3', `contrast_p${page.pageNo}`,
                  `${enhancement.applied?.[0] ?? 'enhanced'}: ${(origScore*100).toFixed(0)}%→${(enhScore*100).toFixed(0)}% clean`,
                  enhScore - origScore);
              } else {
                ctx.addDecision('s3', `contrast_p${page.pageNo}`,
                  `${enhancement.applied?.[0] ?? 'bleed_suppression'} tried, kept original (${(origScore*100).toFixed(0)}% vs ${(enhScore*100).toFixed(0)}%)`,
                  0);
              }
            } catch { /* keep original */ }
          }

          page.words = words;
          let clean = 0, fuzzy = 0, dirty = 0;
          for (const w of words) { if (w.conf >= cleanT) clean++; else if (w.conf >= fuzzyT) fuzzy++; else dirty++; }
          page._bucketed = { clean, fuzzy, dirty, needs_vision: 0 };
          if (words.length > 0) pagesAffected++;
        }

      } catch (pageErr) {
        ctx.addError('s3', pageErr, true);
        page.words = [];
        page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
      }
    })));

    // Mirror all per-page lang candidates up to ctx.meta for downstream stages and analytics.
    // Preserves discovery order; deduplicates by lang code.
    const seenLangs = new Set();
    ctx.meta = ctx.meta ?? {};
    ctx.meta.langCandidates = [];
    for (const page of ctx.pages) {
      for (const c of page._langCandidates ?? []) {
        if (!seenLangs.has(c.lang)) { seenLangs.add(c.lang); ctx.meta.langCandidates.push(c); }
      }
    }

    // ── Phase 2: All batch OCR engines in parallel ────────────────────────────────────────────
    // Each engine processes ALL crops in one Python process (amortizes model load).
    // Surya is chunked separately (CLI tool with GPU memory limit).
    // batchResults: [{label, map: Map<cropStem, {text, words|lines}>}]
    const batchResults = [];
    if (cropRegistry.length > 0) {
      const suryaLangs = [...new Set(cropRegistry.map(c => TESS_TO_SURYA[c.lang] ?? 'en'))].join(',');
      const tessLangs  = [...new Set(cropRegistry.map(c => c.lang))].join(',');

      // Skip batch engines for crops where tesseract is already clean — huge speedup for high-quality scans
      const batchRegistry = cropRegistry.filter(c => {
        const tw = c.tessWords.filter(w => w.conf !== undefined);
        if (!tw.length) return true;
        const avgConf = tw.reduce((s, w) => s + w.conf, 0) / tw.length;
        return avgConf < cleanT;
      });
      ctx.addDecision('s3', 'batch_filter', `${batchRegistry.length}/${cropRegistry.length} crops for batch engines`);

      // Detect available engines once, in parallel (skip surya check if no dirty crops)
      const [suryaOk, ...engineOks] = await Promise.all([
        batchRegistry.length > 0 ? checkSuryaCli(ctx) : Promise.resolve(false),
        ...BATCH_ENGINES.map(e => batchRegistry.length > 0 ? checkPythonEngine(e.tool, ctx) : Promise.resolve(false)),
      ]);
      const availableEngines = batchRegistry.length > 0 ? BATCH_ENGINES.filter((_, i) => engineOks[i]) : [];
      ctx.addDecision('s3', 'engines', [
        suryaOk && batchRegistry.length > 0 ? 'surya' : null,
        ...availableEngines.map(e => e.label),
      ].filter(Boolean).join(', ') || 'tesseract-only');

      // Run all engines concurrently (only on dirty crops)
      await Promise.all([
        suryaOk && batchRegistry.length > 0 ? (async () => {
          try {
            const map = await runSuryaChunked(batchRegistry, suryaLangs, tmpDir, ctx);
            batchResults.push({ label: 'surya', map });
          } catch (e) { ctx.addError('s3', new Error(`surya: ${e.message}`), true); }
        })() : Promise.resolve(),

        ...availableEngines.map(engine => (async () => {
          try {
            const map = await runEngineBatch(engine.tool, engine.label, batchRegistry, tessLangs, tmpDir, ctx);
            batchResults.push({ label: engine.label, map });
            ctx.addDecision('s3', `${engine.label}_batch`, `${map.size}/${cropRegistry.length} crops`);
          } catch (e) { ctx.addError('s3', new Error(`${engine.label}: ${e.message}`), true); }
        })()),
      ]);
    }

    // ── Phase 3: Keyed correction synthesis, then page assembly ──────────────────────────────
    // Tesseract words are the spatial anchor. All engine outputs are context for Haiku.
    // Haiku returns only corrections {idx: text|null} — merged back into tessWords to keep bboxes.
    const synthLimit = pLimit(D_SYNTH_CONC);
    await Promise.all(cropRegistry.map(crop => synthLimit(async () => {
      const hasBatch = batchResults.some(b => b.map.get(crop.cropStem)?.text?.trim());
      let words = crop.tessWords;

      if (!crop.tessWords.length && hasBatch) {
        // Tesseract found nothing — fall back to first batch engine with position data
        const first = batchResults.find(b => b.map.get(crop.cropStem)?.text?.trim());
        const r = first.map.get(crop.cropStem);
        words = first.label === 'surya'
          ? suryaLinesToWords(r.lines, crop.page.pageNo, crop.bx1, crop.by1)
          : engineWordsToPageWords(r.words, crop.page.pageNo, crop.bx1, crop.by1, first.label);
      } else if (hasBatch && ctx.config.apiKey && crop.tessWords.length > 0) {
        try {
          const prompt = buildCorrectionPrompt(crop.tessWords, batchResults, crop.cropStem, crop.lang, cleanT);
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ctx.config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,  // corrections only — much cheaper than full text
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          const data = await resp.json();
          const responseText = data.content?.[0]?.text?.trim() ?? '{}';
          const inTok = Math.ceil(prompt.length / 4), outTok = Math.ceil(responseText.length / 4);
          tokensIn += inTok; tokensOut += outTok;
          costUsd  += llmCost('claude-haiku-4-5-20251001', inTok, outTok);
          const corrections = parseCorrectionResponse(responseText);
          if (Object.keys(corrections).length > 0)
            words = applyCorrections(crop.tessWords, corrections);
        } catch { /* keep tessWords on any error */ }
      }

      // Flag block for Mistral escalation if still dirty after synthesis.
      // Carries tessWords (spatial anchor), batchContext (engine texts already collected),
      // and lang so s4 can run a second Haiku keyed-correction with Mistral as richer context.
      // cropPath is the enhanced 300dpi crop (ocrPath from Phase 1) — s4 re-crops at 600dpi for Mistral.
      if (cleanRatio(words, cleanT) < 0.4) {
        crop.page._escalateBlocks = crop.page._escalateBlocks ?? [];
        const batchContext = batchResults
          .map(({ label, map }) => {
            const r = map.get(crop.cropStem);
            return r?.text?.trim() ? `${label.toUpperCase()}: ${r.text.slice(0, 300)}` : null;
          })
          .filter(Boolean);
        crop.page._escalateBlocks.push({
          x1: crop.bx1, y1: crop.by1, x2: crop.bx2, y2: crop.by2,
          cropPath: crop.cropPath,
          tessWords: crop.tessWords,  // spatial anchor — bboxes preserved through synthesis
          batchContext,               // engine outputs already collected; Mistral adds to these
          lang: crop.lang,
        });
      }
      crop.finalWords = words;
    })));

    // Assemble per-page words from block results (preserves block order)
    const cropsByPage = new Map();
    for (const c of cropRegistry) {
      if (!cropsByPage.has(c.page)) cropsByPage.set(c.page, []);
      cropsByPage.get(c.page).push(c);
    }
    for (const [page, crops] of cropsByPage.entries()) {
      crops.sort((a, b) => a.blockIdx - b.blockIdx);
      page.words = crops.flatMap(c => c.finalWords ?? c.tessWords);
      const escalated = page._escalateBlocks?.length ?? 0;
      const synthCount = crops.filter(c => c.finalWords?.some(w => w.source === 'synthesis')).length;
      if (synthCount > 0) ctx.addDecision('s3', `synth_p${page.pageNo}`, `${synthCount}/${crops.length} blocks synthesized`);

      let clean = 0, fuzzy = 0, dirty = 0;
      for (const w of page.words) { if (w.conf >= cleanT) clean++; else if (w.conf >= fuzzyT) fuzzy++; else dirty++; }
      page._bucketed = { clean, fuzzy, dirty, needs_vision: escalated };
      if (page.words.length > 0) pagesAffected++;
    }

    ctx.addDecision('s3', 'routing_summary', JSON.stringify(routingSummary));

    const pagesWithWords = ctx.pages.filter(p => p.words?.length > 0);
    if (pagesWithWords.length > 0) {
      const avgClean = pagesWithWords.reduce((sum, p) => {
        return sum + (p.words.filter(w => w.conf >= cleanT).length / p.words.length);
      }, 0) / pagesWithWords.length;
      ctx.recordStageQuality('s3', Math.round(avgClean * (pagesWithWords.length / ctx.pages.length) * 1000) / 1000);
    }

  } catch (err) {
    ctx.addError('s3', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s3', {
      pages_affected: pagesAffected,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
      notes: Object.keys(routingSummary).join(', ') || null,
    });
  }

  return ctx;
}
