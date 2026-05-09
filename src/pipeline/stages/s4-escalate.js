// Stage 4: High-DPI re-OCR for dirty pages; parallel vision drafts from boss+marker.
// Exports: s4Escalate, buildDraftPrompt, parseHocr, meanConf
//   s4Escalate(ctx) → ctx   — re-OCRs dirty pages at 600 DPI; fetches boss/marker vision drafts
//   buildDraftPrompt(ctx)   — assembles LLM transcription prompt from doc meta + domain context
//   parseHocr(hocr,pageNo) — Tesseract hOCR XML → word objects (NOTE: also in s3; s4 uses source='tesseract-600')
//   meanConf(words) → 0-100 — average Tesseract confidence
// CONFIG: thresholds.dirtyWord:0.40 — below this conf = dirty word requiring escalation
//         bossUrl    — local LLM vision endpoint (POST /chat/completions OpenAI-style)
//         markerUrl  — marker service (POST /convert, full-doc PDF→markdown, cached per doc)
//         toolBackends.pdftoppm — route 600dpi rasterization to remote
// ERRORS: boss fetch fail → null draft (recoverable); marker fetch fail → null draft (recoverable)
//         pdftoppm/tesseract fail per page → recoverable; dirty words still marked needs_vision
// CONTRACT:
//   Reads:  ctx.pages[n].words, ctx.pages[n]._lang, ctx.pages[n]._bucketed, ctx.pages[n]._pngPath
//   Writes: ctx.pages[n].words (may replace with 600dpi version)
//           ctx.pages[n]._visionDraft = {boss:string|null, marker:string|null}
//           ctx.pages[n]._needsFullVision = true (if no tesseract output at all)
//           ctx.pages[n]._bucketed.needs_vision (count of dirty words after escalation)
//           ctx._markerDoc (cached full-doc markdown, set once)
import { shouldRun, pLimit } from '../config.js';  // shouldRun(stage,ctx)→bool; pLimit(n)
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';
// ── config defaults ──────────────────────────────────────────────────────────
const D_DIRTY_WORD = 0.40;   // thresholds.dirtyWord
const MISTRAL_OCR_MODEL = 'mistral-ocr-latest';
const MISTRAL_OCR_URL   = 'https://api.mistral.ai/v1/ocr';

// ── Mistral block OCR ─────────────────────────────────────────────────────────
// Mistral returns MD text only — no bboxes. It is synthesis CONTEXT, not a replacement OCR engine.
// Flow: re-crop block at 600dpi → send to Mistral → get MD text → second Haiku keyed-correction
// pass using tessWords as spatial anchor + Mistral text as high-quality reference → apply
// corrections to tessWords, preserving all bboxes. Mistral never overrides positions.
//
// 600dpi crop: dirty blocks failed at 300dpi; giving Mistral a 2× resolution image improves accuracy.
// Crops are re-extracted from the 600dpi rasterization already done for Tesseract re-OCR.
async function mistralOcrBlock(cropPath, apiKey) {
  try {
    const imgB64 = readFileSync(cropPath).toString('base64');
    const res = await fetch(MISTRAL_OCR_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MISTRAL_OCR_MODEL, document: { type: 'image_url', image_url: `data:image/png;base64,${imgB64}` } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.pages ?? []).map(p => p.markdown || p.text || '').join('\n').trim();
    return text || null;
  } catch { return null; }
}

// Parse Haiku correction dict {"idx": "corrected"|null} — same contract as s3 parseCorrectionResponse.
function parseCorrectionDict(text) {
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

// Apply corrections to tessWords preserving bboxes — same contract as s3 applyCorrections.
function applyBlockCorrections(tessWords, corrections) {
  if (!Object.keys(corrections).length) return tessWords;
  const result = [];
  for (let i = 0; i < tessWords.length; i++) {
    const w = tessWords[i];
    if (!(i in corrections)) { result.push({ ...w }); continue; }
    const v = corrections[i];
    if (v === null) {
      if (result.length > 0) {
        const prev = result[result.length - 1];
        const lineH = Math.max(1, prev.y2 - prev.y1);
        if (Math.abs((prev.y1 + prev.y2) / 2 - (w.y1 + w.y2) / 2) < lineH * 0.75)
          prev.x2 = Math.max(prev.x2, w.x2);
      }
    } else {
      result.push({ ...w, text: v + ' ', source: 'mistral-synthesis' });
    }
  }
  return result;
}

// ── vision draft helpers (boss + marker, run in parallel) ─────────────────────

export function buildDraftPrompt(ctx) {
  const parts = [];
  if (ctx.meta?.title) parts.push(`Document: "${ctx.meta.title}"`);
  if (ctx.meta?.language) parts.push(`Language: ${ctx.meta.language}`);
  if (ctx.domain?.prompt_context) parts.push(ctx.domain.prompt_context);
  parts.push('Transcribe all text from this page exactly as it appears. Output only the transcribed text. Do not add commentary.');
  return parts.join('\n');
}

async function fetchBossDraft(pngPath, ctx) {
  const bossUrl = ctx.config.bossUrl;
  if (!bossUrl) return null;
  try {
    const b64 = readFileSync(pngPath).toString('base64');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(`${bossUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'vision',
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          { type: 'text', text: buildDraftPrompt(ctx) },
        ]}],
        max_tokens: 1024, temperature: 0,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// Marker service (POST /convert) takes the PDF file path and returns full-document markdown.
// Called once per document — promise is cached immediately so concurrent page calls share one fetch.
function fetchMarkerDoc(ctx) {
  if (ctx._markerDocPromise !== undefined) return ctx._markerDocPromise;
  const markerUrl = ctx.config.markerUrl;
  if (!markerUrl) { ctx._markerDocPromise = Promise.resolve(null); return ctx._markerDocPromise; }
  ctx._markerDocPromise = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const res = await fetch(`${markerUrl}/convert`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_path: ctx.sourcePath }),
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      return data.markdown?.trim() || null;
    } catch { return null; }
  })();
  return ctx._markerDocPromise;
}

async function fetchPageDrafts(page, ctx) {
  const pngPath = page._pngPath;
  const bossPromise = (pngPath && existsSync(pngPath))
    ? fetchBossDraft(pngPath, ctx)
    : Promise.resolve(null);
  // Marker is a doc-level draft (full PDF → markdown), not page-specific; cache in ctx
  const [boss, marker] = await Promise.all([bossPromise, fetchMarkerDoc(ctx)]);
  return { boss, marker };
}

// ── hOCR parser ───────────────────────────────────────────────────────────────

export function parseHocr(hocr, pageNo) {
  const words = [];
  const re = /<span[^>]+class='(?:ocr|ocrx)_word'[^>]+title='([^']*)'[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(hocr)) !== null) {
    const title = m[1];
    const inner = m[2];
    const bboxM = title.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const x1 = parseInt(bboxM[1]), y1 = parseInt(bboxM[2]), x2 = parseInt(bboxM[3]), y2 = parseInt(bboxM[4]);
    const confM = title.match(/x_wconf\s+(\d+)/);
    const conf = confM ? parseInt(confM[1]) : 0;
    const raw = inner.replace(/<[^>]+>/g, '');
    const text = raw
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
      .trim();
    if (!text) continue;
    words.push({ text, x1, y1, x2, y2, conf, source: 'tesseract-600', pageNo });
  }
  return words;
}

export function meanConf(words) {
  if (!words.length) return 0;
  return words.reduce((s, w) => s + (w.conf ?? 0), 0) / words.length;
}

async function rasterizeAt(pdfPath, pageNo, outDir, dpi, ctx) {
  const outBase = join(outDir, `p${pageNo}-${dpi}`);
  const pngPath = `${outBase}.png`;
  if (!existsSync(pngPath)) {
    await ctx.run('pdftoppm', [
      '-png', '-r', String(dpi), '-f', String(pageNo), '-l', String(pageNo),
      '-singlefile', pdfPath, outBase,
    ], { timeout: 90000 });
  }
  return pngPath;
}

export async function s4Escalate(ctx) {
  if (!shouldRun('s4', ctx)) return ctx;

  ctx.beginStage('s4');
  let pagesAffected = 0;
  const dirtyT = (ctx.config.thresholds?.dirtyWord ?? D_DIRTY_WORD) * 100;
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 16);
  const tmpDir = join(getTmpDir(), `site2rag-s3-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });

  const pageLimit = pLimit(8);
  try {
    await Promise.all(ctx.pages.map(page => pageLimit(async () => {
      const words = page.words ?? [];
      const dirtyWords = words.filter(w => (w.conf ?? 100) < dirtyT);
      const noOutput = words.length === 0;
      if (!noOutput && (dirtyWords.length === 0 || (dirtyWords.length < 3 && words.length > 10))) return;

      const lang = page._lang ?? 'eng';
      try {
        // 600dpi re-OCR + boss draft + marker doc all in parallel
        const [reOcrResult, visionDraft] = await Promise.all([
          noOutput ? Promise.resolve(null) : (async () => {
            const pngPath600 = await rasterizeAt(ctx.sourcePath, page.pageNo, tmpDir, 600, ctx);
            const { stdout } = await ctx.run('tesseract', [pngPath600, 'stdout', 'hocr', '-l', lang, '--psm', '3'], {
              timeout: 120000, maxBuffer: 20 * 1024 * 1024,
            });
            return parseHocr(stdout, page.pageNo);
          })(),
          fetchPageDrafts(page, ctx),
        ]);

        page._visionDraft = visionDraft;
        if (visionDraft.boss || visionDraft.marker)
          ctx.addDecision('s4', `draft_p${page.pageNo}`,
            `boss=${!!visionDraft.boss} marker=${!!visionDraft.marker}`);

        if (!noOutput && reOcrResult) {
          const words600 = reOcrResult;
          const oldMean = meanConf(words);
          const newMean = meanConf(words600);
          const delta = newMean - oldMean;
          if (words600.length > 0 && newMean > oldMean + 5) {
            page.words = words600;
            page._words600 = true; // coords are now 600dpi; Mistral block replacement must scale _escalateBlocks bboxes
            ctx.addDecision('s4', `page_${page.pageNo}`, 'replaced-600dpi', delta);
          } else {
            ctx.addDecision('s4', `page_${page.pageNo}`, 'kept-original', delta);
          }
          for (const w of page.words) {
            if ((w.conf ?? 100) < dirtyT) w.needs_vision = true;
          }
        } else if (noOutput) {
          page._needsFullVision = true;
          ctx.addDecision('s4', `page_${page.pageNo}`, 'needs-full-vision', 0);
        }
        // Mistral block escalation — only for blocks s3 flagged dirty after local OCR + Haiku synthesis.
        // Mistral returns MD text used as HIGH-QUALITY CONTEXT for a second Haiku keyed-correction pass.
        // tessWords remain the spatial anchor; Mistral never overrides bboxes.
        // Blocks re-cropped at 600dpi (already rasterized above) for best Mistral accuracy.
        const mistralKey = process.env.MISTRAL_API_KEY;
        const dirtyBlocks = page._escalateBlocks ?? [];
        if (mistralKey && ctx.config.apiKey && dirtyBlocks.length > 0) {
          // _escalateBlocks coords are in 300dpi space; if words600 replaced page.words, scale for matching
          const coordScale = page._words600 ? 2 : 1;
          const pngPath600 = await rasterizeAt(ctx.sourcePath, page.pageNo, tmpDir, 600, ctx).catch(() => null);

          const synthLimit = pLimit(4);
          const resynthesized = await Promise.all(dirtyBlocks.map(blk => synthLimit(async () => {
            try {
              // Re-crop the block from 600dpi page image for Mistral (2× resolution of original crop)
              let mistralCropPath = blk.cropPath; // fallback to 300dpi crop
              if (pngPath600 && existsSync(pngPath600)) {
                const mx1 = blk.x1 * 2, my1 = blk.y1 * 2;
                const mw = (blk.x2 - blk.x1) * 2, mh = (blk.y2 - blk.y1) * 2;
                const mCrop = join(tmpDir, `mistral_p${page.pageNo}_${blk.x1}_${blk.y1}.png`);
                await ctx.run('convert', [pngPath600, '-crop', `${mw}x${mh}+${mx1}+${my1}`, '+repage', mCrop], { timeout: 10000 });
                if (existsSync(mCrop)) mistralCropPath = mCrop;
              }

              const mistralText = await mistralOcrBlock(mistralCropPath, mistralKey);
              if (!mistralText) return null;

              // Second Haiku keyed-correction: tessWords anchor + all batch engine context + Mistral
              const cleanT = (ctx.config.thresholds?.cleanPage ?? 0.9) * 100;
              const tessLine = blk.tessWords
                .map((w, i) => `${i}:${w.conf < cleanT ? '*' : ''}${w.text.trim()}`)
                .join(' ');
              const contextLines = (blk.batchContext ?? []).join('\n');
              const prompt = `Correct OCR errors in this ${blk.lang} text. Tesseract words are the spatial anchor (* = low confidence). Other engines and Mistral are context only.\n\nTESSERACT:\n${tessLine}${contextLines ? `\n\n${contextLines}` : ''}\n\nMISTRAL (high-quality reference):\n${mistralText.slice(0, 600)}\n\nReturn ONLY JSON mapping word index to corrected string or null. Omit unchanged. Example: {"3":"corrected","7":null}\nJSON only.`;

              const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'x-api-key': ctx.config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
              });
              const data = await resp.json();
              const corrections = parseCorrectionDict(data.content?.[0]?.text?.trim() ?? '{}');
              if (!Object.keys(corrections).length) return null;

              const correctedWords = applyBlockCorrections(blk.tessWords, corrections);
              return { blk, correctedWords };
            } catch { return null; }
          })));

          const succeeded = resynthesized.filter(Boolean);
          if (succeeded.length > 0) {
            let words = [...page.words];
            for (const { blk, correctedWords } of succeeded) {
              // Scale block bbox to match current page.words coordinate space
              const sx1 = blk.x1 * coordScale, sy1 = blk.y1 * coordScale;
              const sx2 = blk.x2 * coordScale, sy2 = blk.y2 * coordScale;
              words = words.filter(w => !(w.x1 >= sx1 && w.y1 >= sy1 && w.x2 <= sx2 && w.y2 <= sy2));
              // correctedWords are in 300dpi space (tessWords coords); scale if needed
              const scaled = coordScale === 1 ? correctedWords : correctedWords.map(w => ({
                ...w, x1: w.x1 * coordScale, y1: w.y1 * coordScale, x2: w.x2 * coordScale, y2: w.y2 * coordScale,
              }));
              words.push(...scaled);
            }
            words.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
            page.words = words;
            ctx.addDecision('s4', `mistral_p${page.pageNo}`,
              `${succeeded.length}/${dirtyBlocks.length} blocks re-synthesized with Mistral context`);
          }
        }

        page._bucketed = page._bucketed ?? { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
        page._bucketed.needs_vision = page.words.filter(w => w.needs_vision).length;
        pagesAffected++;
      } catch (pageErr) {
        ctx.addError('s4', pageErr, true);
        for (const w of (page.words ?? [])) {
          if ((w.conf ?? 100) < dirtyT) w.needs_vision = true;
        }
        if (page._bucketed) page._bucketed.needs_vision = (page.words ?? []).filter(w => w.needs_vision).length;
      }
    })));
  } catch (err) {
    ctx.addError('s4', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s4', { pages_affected: pagesAffected });
  }

  return ctx;
}
