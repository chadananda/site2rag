// Stage 5: Vision model escalation for pages where tesseract failed or output is mostly dirty.
// Exports: s5Vision. Deps: config.js, pdftoppm (system), surya_ocr (optional CLI)
// CONTRACT:
//   Reads:  ctx.pages[n]._needsFullVision, _bucketed, words, _pngPath, _lang
//   Writes: ctx.pages[n].visionMd; clears page.words for full-vision pages
//
// Two-phase approach:
//   Phase 1 — Surya pre-pass (batch): calls surya_ocr CLI once per document chunk,
//             stores results in page._suryaMd. Free, handles Arabic/CJK handwriting well.
//             Large docs are chunked (SURYA_CHUNK_SIZE pages) to avoid OOM.
//   Phase 2 — Per-page backend chain: boss → azure → google → claude.
//             Only runs for pages surya didn't cover.

import { shouldRun, withinBudget, llmCost } from '../config.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const VISION_PROMPT = 'Transcribe all text from this document page exactly as it appears. Output only the transcribed text in clean Markdown. Preserve headings, paragraphs, lists, and tables. Do not add commentary.';

const SURYA_CHUNK_SIZE = 20; // pages per surya_ocr call — limits memory on large docs
const SURYA_BIN = process.env.SURYA_PATH ?? 'surya_ocr'; // path to surya_ocr CLI

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

const shouldVisionPage = (page) => {
  const visionWords = (page.words ?? []).filter(w => w.needs_vision);
  const needsFull = page._needsFullVision || (page.words?.length === 0 && page.regions?.some(r => r.type !== 'figure'));
  const dirty = page._bucketed?.dirty ?? 0;
  const total = page.words?.length ?? 0;
  const highDirty = total > 0 && dirty / total > 0.5;
  return { shouldVision: needsFull || highDirty || visionWords.length > 10, needsFull };
};

// ── page PNG helper ───────────────────────────────────────────────────────────

async function getPagePng(page, ctx) {
  if (page._pngPath && existsSync(page._pngPath)) return readFileSync(page._pngPath);
  const stableDir = join(tmpdir(), 'site2rag-s3-' + sha256(ctx.docId).slice(0, 16));
  mkdirSync(stableDir, { recursive: true });
  const outBase = join(stableDir, `page-${page.pageNo}`);
  await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', String(page.pageNo),
    '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, outBase]);
  return readFileSync(outBase + '.png');
}

// ── Phase 1: Surya batch pre-pass ────────────────────────────────────────────

async function checkSuryaCli() {
  try {
    await execFileAsync(SURYA_BIN, ['--help'], { timeout: 5000 });
    return true;
  } catch (e) {
    // surya_ocr --help exits non-zero but that still means it's installed
    return e.code !== 'ENOENT';
  }
}

async function runSuryaChunk(pages, chunkDir, ctx) {
  // Write PNGs into the chunk directory
  const pngMap = new Map(); // filename → page
  for (const page of pages) {
    const buf = await getPagePng(page, ctx);
    const filename = `page-${String(page.pageNo).padStart(4, '0')}.png`;
    writeFileSync(join(chunkDir, filename), buf);
    pngMap.set(filename, page);
  }

  // Collect unique langs for this chunk
  const langs = [...new Set(pages.map(p => TESS_TO_SURYA[p._lang] ?? 'en'))].join(',');

  const outDir = chunkDir + '-out';
  mkdirSync(outDir, { recursive: true });

  try {
    // Directory input → results.json written directly in outDir
    // Requires transformers==4.44.2 (4.45+ breaks surya 0.6.x model loading)
    await execFileAsync(SURYA_BIN, [chunkDir, '--langs', langs, '--results_dir', outDir],
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
  const base = join(tmpdir(), `site2rag-surya-${docHash}`);

  // Process in chunks to avoid OOM on large documents
  for (let i = 0; i < visionPages.length; i += SURYA_CHUNK_SIZE) {
    const chunk = visionPages.slice(i, i + SURYA_CHUNK_SIZE);
    const chunkDir = `${base}-chunk${Math.floor(i / SURYA_CHUNK_SIZE)}`;
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
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{
      image: { content: b64 },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: [langHint] },
    }]}),
  });
  if (!res.ok) throw new Error(`google HTTP ${res.status}`);
  const data = await res.json();
  const text = data.responses?.[0]?.fullTextAnnotation?.text ?? '';
  if (!text) throw new Error('google returned empty text');
  return { text, tokens_in: 0, tokens_out: 0, cost: 0.0015 };
}

async function visionViaCloud(b64, apiKey, model) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model, max_tokens: 2048,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: VISION_PROMPT },
    ]}],
  });
  const text = msg.content.map(b => b.type === 'text' ? b.text : '').join('');
  const cost = llmCost(model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
  return { text, tokens_in: msg.usage?.input_tokens ?? 0, tokens_out: msg.usage?.output_tokens ?? 0, cost };
}

async function buildBackendChain(ctx) {
  const order = ctx.config.implementations?.vision ?? ['boss', 'azure', 'google', 'claude-opus-4-7'];
  const chain = [];
  for (const name of order.filter(n => n !== 'surya')) {
    if (name === 'boss') {
      if (ctx.importance >= (ctx.config.escalation?.localVision ?? 1)) {
        const ok = await checkService(ctx.config.bossUrl.replace(/\/v1$/, ''));
        if (ok) chain.push({ name: 'boss', call: (b64) => visionViaBoss(ctx.config.bossUrl, b64) });
      }
    } else if (name === 'azure') {
      if (ctx.importance >= (ctx.config.escalation?.cloudVision ?? 3) && ctx.config.azureKey && ctx.config.azureEndpoint)
        chain.push({ name: 'azure', call: (b64) => visionViaAzure(ctx.config.azureEndpoint, ctx.config.azureKey, b64) });
    } else if (name === 'google') {
      if (ctx.importance >= (ctx.config.escalation?.cloudVision ?? 3) && ctx.config.googleKey)
        chain.push({ name: 'google', call: (b64, lang) => visionViaGoogle(ctx.config.googleKey, b64, lang) });
    } else if (name.startsWith('claude')) {
      if (ctx.importance >= (ctx.config.escalation?.cloudVision ?? 3) && ctx.config.apiKey)
        chain.push({ name, call: (b64) => visionViaCloud(b64, ctx.config.apiKey, name) });
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
    const visionPages = ctx.pages.filter(p => shouldVisionPage(p).shouldVision);

    // Phase 1: Surya batch pre-pass (free, handles difficult scripts well)
    if (visionPages.length > 0 && ctx.importance >= (ctx.config.escalation?.suryaVision ?? 2)) {
      const suryaOk = await checkSuryaCli();
      if (suryaOk) {
        try {
          await runSuryaBatch(visionPages, ctx);
          const suryaCount = visionPages.filter(p => p._suryaMd).length;
          if (suryaCount) ctx.addDecision('s5', 'surya_batch', `${suryaCount}/${visionPages.length} pages`);
        } catch (e) {
          ctx.addDecision('s5', 'surya_failed', e.message);
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

      const b64 = pngBuf.toString('base64');
      const lang = page._lang ?? 'eng';
      let result = null, usedBackend = null;

      for (const backend of chain) {
        try { result = await backend.call(b64, lang); usedBackend = backend.name; break; }
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

  } catch (err) {
    ctx.addError('s5', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s5', { pages_affected: pagesAffected, tokens_in: totalIn, tokens_out: totalOut, cost_usd: totalCost });
  }

  return ctx;
}
