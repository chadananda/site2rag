// Stage 3: Block-level multi-engine OCR + Haiku synthesis. Core product: synthesis always runs.
// Script detection cascade per block (no API cost until Haiku synthesis):
//   1. Page-level OSD (Tesseract --psm 0) sets initial lang candidates
//   2. Block-level OSD on each crop (≥150×80px) — catches multilingual pages
//   3. Unicode post-check on Tesseract output — re-runs if chars indicate wrong script
//   4. Batch engine consensus — if 2+ engines agree on different script, re-runs Tesseract
//   5. Haiku synthesis uses the corrected Tesseract output + all engine outputs as context
// Engine logic: tesseract always; easyocr+paddle+doctr+kraken if available (amortized per page);
//   surya only on dirty blocks (cleanRatio < D_SYNTH_THRESH). Haiku synthesis always unless all failed.
// Exports: s3Ocr, parseHocr, repairHyphens, resolveLang, cleanRatio
// Deps: config.js (shouldRun, pLimit, llmCost), tool-runner.js (queryWorkerCapacity),
//       preprocess_image.py, detect_blocks_cv.py, detect_blocks_paddle.py,
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
const PREPROCESS_PY       = join(__pyDir, 'preprocess_image.py');
const DETECT_BLOCKS_CV_PY = join(__pyDir, 'detect_blocks_cv.py');
const DETECT_BLOCKS_PAD_PY = join(__pyDir, 'detect_blocks_paddle.py');
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

// Detect dominant non-Latin script from OCR output text via Unicode range analysis.
// Returns Tesseract lang code when ≥30% of non-whitespace chars belong to a recognizable script.
// Zero cost — no API, no model load. Used to catch script mismatches after Tesseract and batch engines.
function detectScriptFromText(text) {
  if (!text) return null;
  const chars = [...text].filter(ch => ch.trim() !== '');
  if (chars.length < 4) return null;
  const counts = { ara: 0, heb: 0, chi_sim: 0, jpn: 0, kor: 0, rus: 0 };
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
        (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)) counts.ara++;
    else if (cp >= 0x0590 && cp <= 0x05FF) counts.heb++;
    else if (cp >= 0x4E00 && cp <= 0x9FFF) counts.chi_sim++;
    else if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF)) counts.jpn++;
    else if (cp >= 0xAC00 && cp <= 0xD7A3) counts.kor++;
    else if (cp >= 0x0400 && cp <= 0x04FF) counts.rus++;
  }
  const total = chars.length;
  const [best] = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return (best && best[1] / total >= 0.3) ? best[0] : null;
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

// Tesseract OSD: free CPU-based script/orientation detection. Returns Tesseract lang code or null.
// Maps detected script to lang: Arabic→ara, Han→chi_sim, Latin→eng, etc.
// Run this before OCR when language is unknown — no API cost, ~1s per page.
const OSD_SCRIPT_TO_LANG = { Arabic: 'ara', Persian: 'fas', Hebrew: 'heb', Devanagari: 'hin',
  Han: 'chi_sim', Hangul: 'kor', Japanese: 'jpn', Cyrillic: 'rus', Latin: 'eng',
  Bengali: 'ben', Tamil: 'tam', Telugu: 'tel', Kannada: 'kan', Malayalam: 'mal',
  Thai: 'tha', Georgian: 'kat', Greek: 'ell', Tibetan: 'bod' };

async function detectScriptOSD(pngPath, ctx) {
  try {
    const { stdout } = await ctx.run('tesseract', [pngPath, 'stdout', '--psm', '0'], { timeout: 30000 });
    const scriptM = stdout.match(/Script:\s*(\w+)/);
    const confM   = stdout.match(/Script confidence:\s*([\d.]+)/);
    if (!scriptM) return null;
    const script = scriptM[1], conf = parseFloat(confM?.[1] ?? '0');
    const lang = OSD_SCRIPT_TO_LANG[script] ?? null;
    return lang ? { lang, script, conf } : null;
  } catch { return null; }
}

// Merge page-level and block-level OSD candidates. Block OSD runs on the crop itself and
// detects mixed-script content (e.g., Arabic footnotes on an otherwise English page).
// If OSD has conf ≥0.5 and detects a non-generic non-Latin script, it leads the list.
function buildBlockLangCandidates(pageCandidates, blockOsd) {
  if (!blockOsd) return pageCandidates;
  if (pageCandidates.some(c => c.lang === blockOsd.lang)) return pageCandidates;
  const pageBase = pageCandidates[0]?.lang;
  const metaIsGeneric = ['eng', 'fra', 'deu', 'spa', 'ita', 'por'].includes(pageBase);
  if (blockOsd.conf >= 0.5 && metaIsGeneric && blockOsd.lang !== 'eng') {
    return [{ lang: blockOsd.lang, source: 'block_osd' }, ...pageCandidates];
  }
  if (blockOsd.conf >= 0.3) {
    return [...pageCandidates, { lang: blockOsd.lang, source: 'block_osd' }];
  }
  return pageCandidates;
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

async function checkSuryaCli(ctx) {
  try {
    await ctx.run('surya_ocr', ['--help'], { timeout: 5000 });
    return true;
  } catch (e) { return e.code !== 'ENOENT'; }
}

async function checkPythonEngine(toolName, ctx) {
  try {
    const { stdout } = await ctx.run(toolName, ['--check'], { timeout: 15000 });
    return stdout.trim() === 'ok';
  } catch { return false; }
}

// ── Surya (GPU-friendly batch via CLI, chunked) ───────────────────────────────────────────────

async function runSuryaChunked(cropRegistry, langs, tmpDir, ctx, pageScope = '') {
  const suryaMap = new Map();
  const pfx = pageScope ? `surya-${pageScope}` : 'surya';
  for (let i = 0; i < cropRegistry.length; i += D_SURYA_CHUNK) {
    const chunk = cropRegistry.slice(i, i + D_SURYA_CHUNK);
    const chunkInDir  = join(tmpDir, `${pfx}-in-${i}`);
    const chunkOutDir = join(tmpDir, `${pfx}-out-${i}`);
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

// Run a batch engine over one page's crops via workerPool (falls back to local).
// pageScope is added to dir names so concurrent pages don't collide.
// Returns Map<cropStem, {text, words}>.
async function runEngineBatch(toolName, label, cropRegistry, langs, tmpDir, ctx, pageScope = '') {
  const tag = pageScope ? `${label}-${pageScope}` : label;
  const inputDir  = join(tmpDir, `${tag}-in`);
  const outputJson = join(tmpDir, `${tag}-out.json`);
  mkdirSync(inputDir, { recursive: true });
  for (const c of cropRegistry) {
    if (existsSync(c.cropPath))
      writeFileSync(join(inputDir, `${c.cropStem}.png`), readFileSync(c.cropPath));
  }
  try {
    await ctx.run(toolName, [inputDir, outputJson, langs], { timeout: 600000 });
    if (!existsSync(outputJson)) return new Map();
    const results = JSON.parse(readFileSync(outputJson, 'utf8'));
    const map = new Map();
    for (const [stem, val] of Object.entries(results)) {
      if (val.text?.trim()) map.set(stem, val);
    }
    return map;
  } finally {
    try { rmSync(inputDir, { recursive: true, force: true }); } catch {}
  }
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

  // Check engine availability once — avoids redundant --check calls inside the page loop.
  const [suryaOk, ...engineOks] = await Promise.all([
    checkSuryaCli(ctx),
    ...BATCH_ENGINES.map(e => checkPythonEngine(e.tool, ctx)),
  ]);
  const availableEngines = BATCH_ENGINES.filter((_, i) => engineOks[i]);
  ctx.addDecision('s3', 'engines_available',
    [suryaOk ? 'surya' : null, ...availableEngines.map(e => e.label)].filter(Boolean).join(', ') || 'tesseract-only');

  // Calibration page: page 2 (first real text page after cover).
  // Winning {method, dpi} is shared via ctx._layoutCalibration before pages 3+ start.
  const calibPageNo = ctx.pages.length >= 2 ? 2 : 1;

  // Haiku synthesis concurrency limit — shared across all pages.
  const synthLimit = pLimit(D_SYNTH_CONC);

  try {
    // ── Pre-calibration: find best layout settings from page 2 ──────────────────────────────
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

    // ── Per-page pipeline: all pages run concurrently, each self-contained ──────────────────
    // Each page: rasterize → OSD → layout → Tesseract per block → all engines in parallel
    //            → wait for all engine results → Haiku synthesis → assemble words.
    // Engine calls use pageScope in dir names so concurrent pages don't collide in tmpDir.
    await Promise.all(ctx.pages.map(async (page) => {
      try {
        if (page.regions?.length && page.regions.every(r => r.type === 'figure')) {
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
          return;
        }

        const regionType = page.regions?.[0]?.type ?? null;
        const lang = ctx.config.s3Lang ?? resolveLang(regionType, ctx.meta?.language);
        page._lang = lang;
        page._langCandidates = [{ lang, source: 'metadata' }];

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

        // OSD script detection — free, ~1s, no API cost.
        const osd = existsSync(pngPath) ? await detectScriptOSD(pngPath, ctx) : null;
        if (osd) {
          const metaLangBase = lang.split('+')[0];
          if (osd.lang !== metaLangBase && !page._langCandidates.some(c => c.lang === osd.lang)) {
            page._langCandidates.push({ lang: osd.lang, source: 'osd' });
            ctx.addDecision('s3', `script_p${page.pageNo}`,
              `OSD: ${osd.script} (${osd.lang}) conf=${osd.conf.toFixed(2)} — differs from metadata lang=${lang}`);
            const metaIsGeneric = ['eng', 'fra', 'deu', 'spa', 'ita', 'por'].includes(lang);
            if (osd.lang !== 'eng' && metaIsGeneric) {
              page._langCandidates = [{ lang: osd.lang, source: 'osd' }, ...page._langCandidates];
              ctx.addDecision('s3', `script_p${page.pageNo}`, `OSD non-Latin override: using ${osd.lang} (was ${lang})`);
            }
          } else if (osd.lang === metaLangBase) {
            ctx.addDecision('s3', `script_p${page.pageNo}`, `OSD confirms: ${osd.script} (${osd.lang}) conf=${osd.conf.toFixed(2)}`);
          }
        }

        const effectiveLang = page._langCandidates[0].lang;
        routingSummary[effectiveLang] = (routingSummary[effectiveLang] ?? 0) + 1;

        // ── Layout detection ────────────────────────────────────────────────────────────────
        let blocks = [];
        const layoutExists = existsSync(layoutPng) && statSync(layoutPng).size > 100;

        if (layoutExists) {
          let bestLayout = { label: 'raw', path: layoutPng, blocks: [], rawCount: 0, filteredSizes: [] };

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
                  bestLayout = calResult; blocks = calResult.blocks;
                  if (calDpi !== D_LAYOUT_DPI) page._layoutDpiScale = dpi / calDpi;
                  ctx.addDecision('s3', `layout_p${page.pageNo}`, `calibrated ${calMethod}@${calDpi}dpi: ${calResult.rawCount} raw → ${blocks.length} usable`);
                }
              }
            } catch { /* fall through */ }
          }

          if (blocks.length < D_MIN_BLOCKS) {
            try {
              bestLayout = await findBestLayoutForSegmentation(layoutPng, lang, tmpDir, page.pageNo, ctx);
              blocks = bestLayout.blocks;
              const filterNote = bestLayout.filteredSizes.length ? `, filtered ${bestLayout.filteredSizes.length} noise` : '';
              ctx.addDecision('s3', `layout_p${page.pageNo}`, `${bestLayout.label}: ${bestLayout.rawCount} raw → ${blocks.length} usable${filterNote}`);
            } catch (e) { ctx.addDecision('s3', `layout_p${page.pageNo}`, `layout detection failed: ${e.message}`); }
          }

          if (blocks.length < D_MIN_BLOCKS && ctx._scanIssues?.length > 0) {
            try {
              const dpiSearch = await findBestLayoutDpi(ctx.sourcePath, page.pageNo, lang, tmpDir, ctx);
              if (dpiSearch && dpiSearch.result.blocks.length > blocks.length) {
                bestLayout = dpiSearch.result; blocks = dpiSearch.result.blocks;
                page._layoutDpiScale = dpiSearch.dpiScale;
                ctx.addDecision('s3', `layout_p${page.pageNo}`, `dpi_search ${dpiSearch.dpi}: ${dpiSearch.result.rawCount} raw → ${blocks.length} usable via ${dpiSearch.result.label}`);
              }
            } catch (e) { ctx.addDecision('s3', `layout_p${page.pageNo}`, `dpi_search failed: ${e.message}`); }
          }

          if (blocks.length < D_MIN_BLOCKS && ctx._scanIssues?.length > 0 && ctx.config.apiKey) {
            try {
              const { methods: visionMethods, lang: visionLang } = await consultVisionForPreprocessing(layoutPng, ctx.config.apiKey, ctx);
              if (visionLang && !page._langCandidates.some(c => c.lang === visionLang)) {
                page._langCandidates.push({ lang: visionLang, source: 's3_vision' });
                routingSummary[visionLang] = (routingSummary[visionLang] ?? 0) + 1;
                ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision lang candidate: ${visionLang}`);
              }
              if (visionMethods.length > 0) {
                ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision suggested: [${visionMethods.join(', ')}]`);
                const visionBest = await findBestLayoutForSegmentation(layoutPng, visionLang ?? lang, tmpDir, page.pageNo, ctx, visionMethods);
                if (visionBest.blocks.length > blocks.length) {
                  bestLayout = visionBest; blocks = visionBest.blocks;
                  ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision-guided ${visionBest.label}: ${visionBest.rawCount} raw → ${blocks.length} usable`);
                }
              }
            } catch (e) { ctx.addDecision('s3', `layout_p${page.pageNo}`, `vision consult failed: ${e.message}`); }
          }

          const cvImg = bestLayout.path ?? layoutPng;
          if (blocks.length < D_MIN_BLOCKS) {
            try {
              const cvOut = await execFileAsync('python3', [DETECT_BLOCKS_CV_PY, cvImg], { timeout: 15000 });
              const cvBlocks = JSON.parse(cvOut.stdout.trim() || '[]').map(b => ({
                x1: Math.round(b.x1 * dpiScale), y1: Math.round(b.y1 * dpiScale),
                x2: Math.round(b.x2 * dpiScale), y2: Math.round(b.y2 * dpiScale),
              }));
              if (cvBlocks.length > 0) { blocks = cvBlocks; ctx.addDecision('s3', `layout_p${page.pageNo}`, `opencv: ${cvBlocks.length} blocks`); }
            } catch (e) { ctx.addDecision('s3', `layout_p${page.pageNo}`, `opencv failed: ${e.message}`); }
          }

          if (blocks.length < D_MIN_BLOCKS) {
            try {
              const padOut = await execFileAsync('python3', [DETECT_BLOCKS_PAD_PY, cvImg], { timeout: 60000 });
              const padBlocks = JSON.parse(padOut.stdout.trim() || '[]').map(b => ({
                x1: Math.round(b.x1 * dpiScale), y1: Math.round(b.y1 * dpiScale),
                x2: Math.round(b.x2 * dpiScale), y2: Math.round(b.y2 * dpiScale),
              }));
              if (padBlocks.length > 0) { blocks = padBlocks; ctx.addDecision('s3', `layout_p${page.pageNo}`, `paddle_detect: ${padBlocks.length} blocks`); }
            } catch (e) { ctx.addDecision('s3', `layout_p${page.pageNo}`, `paddle_detect failed: ${e.message}`); }
          }

          if (blocks.length < D_MIN_BLOCKS) {
            const suryaLayoutDir = join(tmpDir, `surya-layout-p${page.pageNo}-in`);
            const suryaLayoutOut = join(tmpDir, `surya-layout-p${page.pageNo}-out`);
            try {
              mkdirSync(suryaLayoutDir, { recursive: true });
              mkdirSync(suryaLayoutOut, { recursive: true });
              writeFileSync(join(suryaLayoutDir, `p${page.pageNo}.png`), readFileSync(bestLayout.path ?? layoutPng));
              await ctx.run('surya_layout', [suryaLayoutDir, '--results_dir', suryaLayoutOut], { timeout: 120000 });
              const resultsPath = join(suryaLayoutOut, 'results.json');
              if (existsSync(resultsPath)) {
                const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
                const layoutEntry = Object.values(results)[0];
                const pageLayout = Array.isArray(layoutEntry) ? layoutEntry[0] : layoutEntry;
                const suryaBlocks = (pageLayout?.bboxes ?? []).filter(b => b.label !== 'Figure').map(b => ({
                  x1: Math.round(b.bbox[0] * dpiScale), y1: Math.round(b.bbox[1] * dpiScale),
                  x2: Math.round(b.bbox[2] * dpiScale), y2: Math.round(b.bbox[3] * dpiScale),
                }));
                if (suryaBlocks.length > 0) { blocks = suryaBlocks; ctx.addDecision('s3', `layout_p${page.pageNo}`, `surya_layout: ${suryaBlocks.length} blocks`); }
              }
            } catch (e) { ctx.addDecision('s3', `layout_p${page.pageNo}`, `surya_layout failed: ${e.message}`); }
            finally {
              try { rmSync(suryaLayoutDir, { recursive: true, force: true }); } catch {}
              try { rmSync(suryaLayoutOut, { recursive: true, force: true }); } catch {}
            }
          }

          if (ctx.config.debug) {
            try {
              const dbgDir = join(dirname(ctx.sourcePath), 'debug', basename(ctx.sourcePath, '.pdf'));
              mkdirSync(dbgDir, { recursive: true });
              copyFileSync(layoutPng, join(dbgDir, `p${page.pageNo}_layout_raw.png`));
              if (bestLayout.label !== 'raw' && existsSync(bestLayout.path))
                copyFileSync(bestLayout.path, join(dbgDir, `p${page.pageNo}_layout_${bestLayout.label}.png`));
              if (existsSync(pngPath)) copyFileSync(pngPath, join(dbgDir, `p${page.pageNo}_fullres.png`));
              if (blocks.length > 0) {
                const dbgScale = page._layoutDpiScale ?? dpiScale;
                const drawArgs = blocks.flatMap(b => ['-fill', 'none', '-stroke', b._geoDetected ? 'blue' : 'red', '-strokewidth', '3',
                  '-draw', `rectangle ${b._geoDetected ? Math.round(b.x1/dbgScale) : b.x1},${b._geoDetected ? Math.round(b.y1/dbgScale) : b.y1} ${b._geoDetected ? Math.round(b.x2/dbgScale) : b.x2},${b._geoDetected ? Math.round(b.y2/dbgScale) : b.y2}`]);
                await ctx.run('convert', [bestLayout.path, ...drawArgs, join(dbgDir, `p${page.pageNo}_blocks.png`)], { timeout: 10000 });
              }
            } catch { /* debug never fatal */ }
          }
        }

        if (blocks.length < D_MIN_BLOCKS) {
          ctx.addError('s3', new Error(`p${page.pageNo}: block detection found no blocks — escalating to s4`), true);
          page.words = [];
          page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 1 };
          page._escalateBlocks = [{ x1: 0, y1: 0, x2: 9999, y2: 9999, cropPath: pngPath,
            tessWords: [], batchContext: [], lang: page._langCandidates?.[0]?.lang ?? 'eng', fullPage: true }];
          return;
        }

        // ── Tesseract per block (parallel within this page) ─────────────────────────────────
        const effectiveDpiScale = page._layoutDpiScale ?? dpiScale;
        const pageCrops = [];
        await Promise.all(blocks.map(async (blk, bi) => {
          const bx1 = blk._geoDetected ? blk.x1 : Math.floor(blk.x1 * effectiveDpiScale);
          const by1 = blk._geoDetected ? blk.y1 : Math.floor(blk.y1 * effectiveDpiScale);
          const bx2 = blk._geoDetected ? blk.x2 : Math.ceil(blk.x2  * effectiveDpiScale);
          const by2 = blk._geoDetected ? blk.y2 : Math.ceil(blk.y2  * effectiveDpiScale);
          const cropStem = `p${page.pageNo}_b${bi}`;
          const cropPath = join(cropDir, `${cropStem}.png`);
          try {
            await ctx.run('convert', [pngPath, '-crop', `${bx2-bx1}x${by2-by1}+${bx1}+${by1}`, '+repage', cropPath], { timeout: 15000 });
            if (!existsSync(cropPath)) return;
            const cropEnh = join(tmpDir, `${cropStem}_enh.png`);
            const enh = forceContrast ? await tryEnhanceForced(cropPath, cropEnh, extraArgs) : await tryEnhance(cropPath, cropEnh, extraArgs);
            // INVARIANT: store ocrPath (enhanced), not raw cropPath — all engines must see the enhanced image.
            const ocrPath = enh?.path ?? cropPath;

            // Block-level OSD: detects scripts in mixed-language pages (Arabic footnotes, etc.).
            // Only run on blocks ≥150×80px — smaller blocks have too few characters for OSD.
            const blockW = bx2 - bx1, blockH = by2 - by1;
            const blockOsd = (blockW >= 150 && blockH >= 80) ? await detectScriptOSD(ocrPath, ctx) : null;
            const blockLangCandidates = buildBlockLangCandidates(page._langCandidates, blockOsd);

            let { words: tessWords, lang: winLang } = await runTesseractBestLang(ocrPath, blockLangCandidates, page.pageNo, ctx, cleanT);

            // Unicode post-check: if Tesseract output contains characters from a different script
            // (OSD missed it or block was too small), re-run with the detected lang.
            const tessText = tessWords.map(w => w.text).join(' ');
            const unicodeLang = detectScriptFromText(tessText);
            if (unicodeLang && unicodeLang !== winLang && !blockLangCandidates.some(c => c.lang === unicodeLang)) {
              const augmented = [{ lang: unicodeLang, source: 'unicode' }, ...blockLangCandidates];
              const retry = await runTesseractBestLang(ocrPath, augmented, page.pageNo, ctx, cleanT);
              if (retry.words.length > 0 && cleanRatio(retry.words, cleanT) >= cleanRatio(tessWords, cleanT)) {
                tessWords = retry.words; winLang = retry.lang;
              }
            }

            // Page-lang safety net: if the result is still garbage and a block-level detector
            // (OSD or unicode) chose a different lang from the page, re-run with the page's
            // original candidates. Block OSD on small crops has a higher false-positive rate
            // than page-level OSD — this prevents a misfire from locking the block into the
            // wrong script before escalation.
            const pageLang = page._langCandidates[0]?.lang;
            if (pageLang && pageLang !== winLang && cleanRatio(tessWords, cleanT) < 0.3) {
              const pageFallback = await runTesseractBestLang(ocrPath, page._langCandidates, page.pageNo, ctx, cleanT);
              if (pageFallback.words.length > 0 && cleanRatio(pageFallback.words, cleanT) > cleanRatio(tessWords, cleanT)) {
                tessWords = pageFallback.words; winLang = pageFallback.lang;
              }
            }

            const mapped = tessWords.map(w => ({ ...w, x1: w.x1 + bx1, y1: w.y1 + by1, x2: w.x2 + bx1, y2: w.y2 + by1 }));
            pageCrops.push({ page, blockIdx: bi, bx1, by1, bx2, by2, cropPath: ocrPath, cropStem, tessWords: mapped, lang: winLang });
          } catch { /* skip failed block */ }
        }));
        ctx.addDecision('s3', `blocks_p${page.pageNo}`, `${blocks.length} blocks detected, ${pageCrops.length} OCR'd`);

        // ── All batch engines in parallel for this page's crops ─────────────────────────────
        // Engine calls use page.pageNo as scope so concurrent pages don't collide in tmpDir.
        const batchResults = [];
        if (pageCrops.length > 0 && (availableEngines.length > 0 || suryaOk)) {
          const tessLangs = [...new Set(pageCrops.map(c => c.lang))].join(',');
          const suryaCrops = suryaOk ? pageCrops.filter(c => cleanRatio(c.tessWords, cleanT) < D_SYNTH_THRESH) : [];
          const scope = `p${page.pageNo}`;

          await Promise.all([
            ...availableEngines.map(engine => (async () => {
              try {
                const map = await runEngineBatch(engine.tool, engine.label, pageCrops, tessLangs, tmpDir, ctx, scope);
                batchResults.push({ label: engine.label, map });
                ctx.addDecision('s3', `${engine.label}_p${page.pageNo}`, `${map.size}/${pageCrops.length} crops`);
              } catch (e) { ctx.addError('s3', new Error(`${engine.label} p${page.pageNo}: ${e.message}`), true); }
            })()),
            suryaCrops.length > 0 ? (async () => {
              try {
                const suryaLangs = [...new Set(suryaCrops.map(c => TESS_TO_SURYA[c.lang] ?? 'en'))].join(',');
                const map = await runSuryaChunked(suryaCrops, suryaLangs, tmpDir, ctx, scope);
                batchResults.push({ label: 'surya', map });
              } catch (e) { ctx.addError('s3', new Error(`surya p${page.pageNo}: ${e.message}`), true); }
            })() : Promise.resolve(),
          ]);
        }

        // ── Haiku synthesis — all engines done, full context available ──────────────────────
        await Promise.all(pageCrops.map(crop => synthLimit(async () => {
          // Batch engine script consensus: if 2+ engines agree on a script different from
          // crop.lang, re-run Tesseract with the consensus lang before Haiku synthesis.
          // This catches blocks where page-level and block-level OSD both missed the script
          // (e.g., a small Arabic block on an English page where OSD had insufficient text).
          const batchTexts = batchResults
            .map(b => b.map.get(crop.cropStem)?.text?.trim()).filter(Boolean);
          if (batchTexts.length >= 2) {
            const scriptVotes = batchTexts.map(detectScriptFromText).filter(Boolean);
            const voteCounts = {};
            for (const l of scriptVotes) voteCounts[l] = (voteCounts[l] ?? 0) + 1;
            const topEntry = Object.entries(voteCounts).sort(([, a], [, b]) => b - a)[0];
            if (topEntry) {
              const [topLang, topCount] = topEntry;
              if (topCount >= 2 && topLang !== crop.lang) {
                try {
                  const retry = await runTesseractBestLang(crop.cropPath,
                    [{ lang: topLang, source: 'batch_consensus' }], crop.page.pageNo, ctx, cleanT);
                  if (retry.words.length > 0) {
                    crop.tessWords = retry.words.map(w => ({
                      ...w, x1: w.x1 + crop.bx1, y1: w.y1 + crop.by1,
                      x2: w.x2 + crop.bx1, y2: w.y2 + crop.by1,
                    }));
                    crop.lang = topLang;
                    ctx.addDecision('s3', `consensus_p${crop.page.pageNo}_b${crop.blockIdx}`,
                      `batch engines agree on ${topLang} (${topCount}/${batchTexts.length}) — re-ran tesseract`);
                  }
                } catch { /* keep existing */ }
              }
            }
          }

          const hasBatch = batchResults.some(b => b.map.get(crop.cropStem)?.text?.trim());
          let words = crop.tessWords;

          if (!crop.tessWords.length && hasBatch) {
            const first = batchResults.find(b => b.map.get(crop.cropStem)?.text?.trim());
            const r = first.map.get(crop.cropStem);
            words = first.label === 'surya'
              ? suryaLinesToWords(r.lines, crop.page.pageNo, crop.bx1, crop.by1)
              : engineWordsToPageWords(r.words, crop.page.pageNo, crop.bx1, crop.by1, first.label);
          } else if (hasBatch && ctx.config.apiKey && !ctx.config.disableCloudVision && crop.tessWords.length > 0) {
            try {
              const prompt = buildCorrectionPrompt(crop.tessWords, batchResults, crop.cropStem, crop.lang, cleanT);
              const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'x-api-key': ctx.config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200,
                  messages: [{ role: 'user', content: prompt }] }),
              });
              const data = await resp.json();
              const responseText = data.content?.[0]?.text?.trim() ?? '{}';
              const inTok = Math.ceil(prompt.length / 4), outTok = Math.ceil(responseText.length / 4);
              tokensIn += inTok; tokensOut += outTok;
              costUsd  += llmCost('claude-haiku-4-5-20251001', inTok, outTok);
              const corrections = parseCorrectionResponse(responseText);
              if (Object.keys(corrections).length > 0) words = applyCorrections(crop.tessWords, corrections);
            } catch { /* keep tessWords */ }
          }

          if (cleanRatio(words, cleanT) < 0.4) {
            page._escalateBlocks = page._escalateBlocks ?? [];
            const batchContext = batchResults
              .map(({ label, map }) => { const r = map.get(crop.cropStem); return r?.text?.trim() ? `${label.toUpperCase()}: ${r.text.slice(0, 300)}` : null; })
              .filter(Boolean);
            page._escalateBlocks.push({ x1: crop.bx1, y1: crop.by1, x2: crop.bx2, y2: crop.by2,
              cropPath: crop.cropPath, tessWords: crop.tessWords, batchContext, lang: crop.lang });
          }
          crop.finalWords = words;
        })));

        // ── Assemble page words ─────────────────────────────────────────────────────────────
        pageCrops.sort((a, b) => a.blockIdx - b.blockIdx);
        page.words = pageCrops.flatMap(c => c.finalWords ?? c.tessWords);
        const escalated = page._escalateBlocks?.length ?? 0;
        const synthCount = pageCrops.filter(c => c.finalWords?.some(w => w.source === 'synthesis')).length;
        if (synthCount > 0) ctx.addDecision('s3', `synth_p${page.pageNo}`, `${synthCount}/${pageCrops.length} blocks synthesized`);
        let clean = 0, fuzzy = 0, dirty = 0;
        for (const w of page.words) { if (w.conf >= cleanT) clean++; else if (w.conf >= fuzzyT) fuzzy++; else dirty++; }
        page._bucketed = { clean, fuzzy, dirty, needs_vision: escalated };
        if (page.words.length > 0) pagesAffected++;

      } catch (pageErr) {
        ctx.addError('s3', pageErr, true);
        page.words = [];
        page._bucketed = { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
      }
    }));

    // Mirror per-page lang candidates to ctx.meta for downstream stages.
    const seenLangs = new Set();
    ctx.meta = ctx.meta ?? {};
    ctx.meta.langCandidates = [];
    for (const page of ctx.pages) {
      for (const c of page._langCandidates ?? []) {
        if (!seenLangs.has(c.lang)) { seenLangs.add(c.lang); ctx.meta.langCandidates.push(c); }
      }
    }

    ctx.addDecision('s3', 'routing_summary', JSON.stringify(routingSummary));
    const pagesWithWords = ctx.pages.filter(p => p.words?.length > 0);
    if (pagesWithWords.length > 0) {
      const avgClean = pagesWithWords.reduce((sum, p) =>
        sum + p.words.filter(w => w.conf >= cleanT).length / p.words.length, 0) / pagesWithWords.length;
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
