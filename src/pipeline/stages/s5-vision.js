// Stage 5: Vision model escalation for pages Tesseract couldn't handle.
// Exports: s5Vision
//   s5Vision(ctx) → ctx  — Phase 1: Surya CLI batch; Phase 2: per-page backend chain
// CONFIG: s5Mode:'haiku'|'sonnet' — forces ALL pages through named Anthropic model
//         escalation.suryaVision:2 — min importance for Surya Phase 1
//         escalation.localVision   — min importance for Phase 2 backends
//         maxTokenBudget           — hard token cap; checked per page via withinBudget()
//         toolBackends.surya_ocr   — route Surya to remote GPU host
//         toolBackends.pdftoppm    — route rasterization to remote host
// ERRORS: surya_ocr ENOENT → recoverable; surya batch fail → recoverable
//         backend chain exhausted → page skipped (recoverable)
//         pdftoppm fail → page skipped (recoverable)
// CONTRACT:
//   Reads:  ctx.pages[n]._needsFullVision, _bucketed, words, _pngPath, _lang, _suryaText
//   Writes: ctx.pages[n].visionMd — final corrected markdown; clears page.words for vision pages
//
// Phase 1 — Surya pre-pass (batch): surya_ocr CLI, chunked by SURYA_CHUNK_SIZE pages.
//           Skipped if s3 already ran Surya (ctx.pages.some(p=>p._suryaText)).
// Phase 2 — Per-page backend chain: s5Mode model → boss → azure → google → claude-opus.
//           Only pages surya didn't cover.
import { shouldRun, withinBudget, llmCost } from '../config.js'; // shouldRun(stage,ctx)→bool; withinBudget(ctx,n?)→bool; llmCost(model,in,out)→usd
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';
// ── config defaults ──────────────────────────────────────────────────────────
const D_SURYA_CHUNK = 20;     // SURYA_CHUNK_SIZE — pages per surya_ocr batch call
const D_MAX_PNG_MB  = 12;     // max PNG size in MB before skipping page

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const VISION_PROMPT = 'Transcribe all text from this document page exactly as it appears. Output only the transcribed text in clean Markdown. Preserve headings, paragraphs, lists, and tables. Do not add commentary.';
const HANDWRITING_PROMPT = 'Carefully transcribe all handwritten and printed text from this document page. The text may include multiple languages and scripts including Arabic, Persian, and English. Preserve paragraph breaks. Mark words that are truly illegible as [illegible]. Output only the transcribed text in clean Markdown. Do not add commentary.';

// SURYA_CHUNK_SIZE moved to D_SURYA_CHUNK above

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

export const shouldVisionPage = (page) => {
  const visionWords = (page.words ?? []).filter(w => w.needs_vision);
  const needsFull = page._needsFullVision || (page.words?.length === 0 && page.regions?.some(r => r.type !== 'figure'));
  const dirty = page._bucketed?.dirty ?? 0;
  const total = page.words?.length ?? 0;
  const highDirty = total > 0 && dirty / total > 0.5;
  return { shouldVision: needsFull || highDirty || visionWords.length > 10, needsFull };
};

// ── page PNG helper ───────────────────────────────────────────────────────────

const MAX_PNG_BYTES = D_MAX_PNG_MB * 1024 * 1024; // larger pages downsampled by vision model anyway

async function getPagePng(page, ctx) {
  if (page._pngPath && existsSync(page._pngPath)) {
    const buf = readFileSync(page._pngPath);
    return buf.length <= MAX_PNG_BYTES ? buf : null; // skip oversized pages
  }
  const stableDir = join(getTmpDir(), 'site2rag-s3-' + sha256(ctx.docId).slice(0, 16));
  mkdirSync(stableDir, { recursive: true });
  const outBase = join(stableDir, `page-${page.pageNo}`);
  await ctx.run('pdftoppm', ['-png', '-r', '200', '-f', String(page.pageNo),
    '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, outBase], { timeout: 30000 });
  const pngPath = outBase + '.png';
  if (!existsSync(pngPath)) return null;
  const buf = readFileSync(pngPath);
  return buf.length <= MAX_PNG_BYTES ? buf : null;
}

// ── Phase 1: Surya batch pre-pass ────────────────────────────────────────────

async function checkSuryaCli(ctx) {
  try {
    await ctx.run('surya_ocr', ['--help'], { timeout: 5000 });
    return true;
  } catch (e) {
    // surya_ocr --help exits non-zero but that still means it's installed
    return e.code !== 'ENOENT';
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
    // Directory input → results.json written directly in outDir
    // Requires transformers==4.44.2 (4.45+ breaks surya 0.6.x model loading)
    await ctx.run('surya_ocr', [chunkDir, '--langs', langs, '--results_dir', outDir],
      { timeout: 300000 }); // 5 min max per chunk

    const resultsPath = join(outDir, 'results.json');
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

  // Process in chunks to avoid OOM on large documents
  for (let i = 0; i < visionPages.length; i += D_SURYA_CHUNK) {
    const chunk = visionPages.slice(i, i + D_SURYA_CHUNK);
    const chunkDir = `${base}-chunk${Math.floor(i / D_SURYA_CHUNK)}`;
    mkdirSync(chunkDir, { recursive: true });
    await runSuryaChunk(chunk, chunkDir, ctx);
  }
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
        max_tokens: 2048, temperature: 0,
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

async function synthesizeWithOcrContext(b64, apiKey, model, page) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: 120000 });
  const ocrDrafts = [];
  if (page?.words?.length > 0) {
    const tessText = page.words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    if (tessText) ocrDrafts.push(`Tesseract OCR:\n${tessText.slice(0, 2000)}`);
  }
  if (page?._suryaText) {
    ocrDrafts.push(`Secondary OCR (Surya):\n${page._suryaText.slice(0, 2000)}`);
  }
  const prompt = ocrDrafts.length > 0
    ? `You are correcting OCR output for a scanned historical document page.\n\nOCR drafts:\n\n${ocrDrafts.join('\n\n')}\n\nReview the page image carefully and provide the corrected, accurate transcription. Output only the transcribed text in clean Markdown. Preserve paragraph breaks, headings, and structure.`
    : VISION_PROMPT;
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
  const order = ctx.config.implementations?.vision ?? ['boss', 'azure', 'google', 'claude-opus-4-7'];
  const difficulty = ctx.quality?.baseline?.processing_difficulty ?? 0;
  // Hard/handwritten docs escalate to cloud vision regardless of importance (difficulty >= 0.5).
  // Standard cloud gate still applies for easy docs (importance >= cloudVision threshold).
  const cloudVisionGate = ctx.config.escalation?.cloudVision ?? 3;
  const needsCloud = ctx.importance >= cloudVisionGate || difficulty >= 0.5;
  // Use handwriting-aware prompt for very hard docs (dense image scans, handwritten scripts).
  const visionPrompt = difficulty >= 0.7 ? HANDWRITING_PROMPT : VISION_PROMPT;
  const chain = [];
  for (const name of order.filter(n => n !== 'surya')) {
    if (name === 'boss') {
      if (ctx.importance >= (ctx.config.escalation?.localVision ?? 1)) {
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
  // s5Mode: inject preferred model at front of chain for synthesis with OCR context
  if (ctx.config.s5Mode && ctx.config.apiKey) {
    const modeModel = ctx.config.s5Mode === 'haiku' ? 'claude-haiku-4-5-20251001' :
                      ctx.config.s5Mode === 'sonnet' ? 'claude-sonnet-4-6' : null;
    if (modeModel) {
      chain.unshift({ name: modeModel, call: (b64, _lang, page) => synthesizeWithOcrContext(b64, ctx.config.apiKey, modeModel, page) });
    }
  }
  return chain;
}

// ── main stage ────────────────────────────────────────────────────────────────

export async function s5Vision(ctx) {
  if (!shouldRun('s5', ctx)) return ctx;

  ctx.beginStage('s5');
  let pagesAffected = 0, totalCost = 0, totalIn = 0, totalOut = 0;

  try {
    const forcedByMode = !!ctx.config.s5Mode;
    const visionPages = ctx.pages.filter(p => forcedByMode || shouldVisionPage(p).shouldVision);

    // Phase 1: Surya batch pre-pass (free, handles difficult scripts well).
    // Always run for hard docs (difficulty >= 0.3) — they need it most.
    const difficulty = ctx.quality?.baseline?.processing_difficulty ?? 0;
    const suryaGate = ctx.config.escalation?.suryaVision ?? 2;
    const s3RanSurya = ctx.pages.some(p => p._suryaText);
    if (!s3RanSurya && visionPages.length > 0 && (ctx.importance >= suryaGate || difficulty >= 0.3)) {
      const suryaOk = await checkSuryaCli(ctx);
      if (!suryaOk) {
        ctx.addError('s5', new Error(`surya_ocr CLI not found — install surya or set SURYA_PATH`), true);
      } else {
        try {
          await runSuryaBatch(visionPages, ctx);
          const suryaCount = visionPages.filter(p => p._suryaMd).length;
          if (suryaCount) ctx.addDecision('s5', 'surya_batch', `${suryaCount}/${visionPages.length} pages`);
        } catch (e) {
          ctx.addError('s5', new Error(`surya batch failed: ${e.message}`), true);
        }
      }
    }

    // Phase 2: per-page chain for pages surya didn't cover
    const chain = await buildBackendChain(ctx);
    const remainingPages = visionPages.filter(p => !p._suryaMd);

    if (remainingPages.length > 0 && chain.length === 0) {
      ctx.addDecision('s5', 'skip', 'no HTTP vision backend available');
    }

    // Commit surya results to visionMd
    for (const page of visionPages) {
      const { needsFull } = shouldVisionPage(page);
      if (page._suryaMd) {
        page.visionMd = page._suryaMd;
        delete page._suryaMd;
        if (needsFull) page.words = [];
        pagesAffected++;
        ctx.addDecision('s5', `page_${page.pageNo}`, 'surya', page.visionMd.length);
      }
    }

    // Per-page HTTP backends for remaining pages
    for (const page of remainingPages) {
      if (!withinBudget(ctx, 2000)) {
        ctx.addDecision('s5', 'budget_stop', `page ${page.pageNo}: token budget exhausted`);
        break;
      }

      let pngBuf;
      try { pngBuf = await getPagePng(page, ctx); }
      catch (e) { ctx.addError('s5', new Error(`page ${page.pageNo} PNG failed: ${e.message}`), true); continue; }
      if (!pngBuf) { ctx.addDecision('s5', `page_${page.pageNo}`, 'skip: oversized PNG'); continue; }

      const b64 = pngBuf.toString('base64');
      const lang = page._lang ?? 'eng';
      let result = null, usedBackend = null;

      for (const backend of chain) {
        try { result = await backend.call(b64, lang, page); usedBackend = backend.name; break; }
        catch (e) { ctx.addDecision('s5', `${backend.name}_failed`, `page ${page.pageNo}: ${e.message}`); }
      }

      if (!result) continue;

      const { needsFull } = shouldVisionPage(page);
      page.visionMd = result.text.trim();
      if (needsFull) page.words = [];
      totalIn += result.tokens_in;
      totalOut += result.tokens_out;
      totalCost += result.cost;
      pagesAffected++;
      ctx.addDecision('s5', `page_${page.pageNo}`, usedBackend, page.visionMd.length);
    }

    // Record quality after vision: coverage of vision-processed pages weighted by prior s3 score
    if (pagesAffected > 0) {
      const totalPages = ctx.pages.length;
      const visionCoverage = pagesAffected / totalPages;
      const s3Score = ctx.quality.perStage['s3'] ?? ctx.quality.baseline?.composite_score ?? 0;
      // Vision fills gaps s3 missed — estimate combined quality
      const s5Score = Math.min(1, s3Score + visionCoverage * (1 - s3Score));
      ctx.recordStageQuality('s5', Math.round(s5Score * 1000) / 1000);
    }
  } catch (err) {
    ctx.addError('s5', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s5', { pages_affected: pagesAffected, tokens_in: totalIn, tokens_out: totalOut, cost_usd: totalCost });
  }

  return ctx;
}
