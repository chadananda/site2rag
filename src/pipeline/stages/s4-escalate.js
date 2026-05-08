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
import { shouldRun } from '../config.js';          // shouldRun(stage,ctx)→bool
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';
// ── config defaults ──────────────────────────────────────────────────────────
const D_DIRTY_WORD = 0.40;   // thresholds.dirtyWord

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
// Called once per document (not per page) and cached in ctx._markerDoc.
async function fetchMarkerDoc(ctx) {
  if (ctx._markerDoc !== undefined) return ctx._markerDoc;
  const markerUrl = ctx.config.markerUrl;
  if (!markerUrl) { ctx._markerDoc = null; return null; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const res = await fetch(`${markerUrl}/convert`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_path: ctx.sourcePath }),
    });
    clearTimeout(timer);
    if (!res.ok) { ctx._markerDoc = null; return null; }
    const data = await res.json();
    ctx._markerDoc = data.markdown?.trim() || null;
    return ctx._markerDoc;
  } catch { ctx._markerDoc = null; return null; }
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

  try {
    for (const page of ctx.pages) {
      const words = page.words ?? [];
      const dirtyWords = words.filter(w => (w.conf ?? 100) < dirtyT);
      const noOutput = words.length === 0;
      // Skip if no dirty words and page has output
      if (!noOutput && (dirtyWords.length === 0 || (dirtyWords.length < 3 && words.length > 10))) continue;

      const lang = page._lang ?? 'eng';
      try {
        // Fan out: re-OCR at 600dpi + vision drafts from boss+marker, all in parallel
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
            ctx.addDecision('s4', `page_${page.pageNo}`, 'replaced-600dpi', delta);
          } else {
            ctx.addDecision('s4', `page_${page.pageNo}`, 'kept-original', delta);
          }
          // Mark remaining dirty words as needs_vision
          for (const w of page.words) {
            if ((w.conf ?? 100) < dirtyT) w.needs_vision = true;
          }
        } else if (noOutput) {
          // No tesseract output at all — mark page for full vision
          page._needsFullVision = true;
          ctx.addDecision('s4', `page_${page.pageNo}`, 'needs-full-vision', 0);
        }
        page._bucketed = page._bucketed ?? { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 };
        page._bucketed.needs_vision = page.words.filter(w => w.needs_vision).length;
        pagesAffected++;
      } catch (pageErr) {
        ctx.addError('s4', pageErr, true);
        // On error, still mark dirty words as needs_vision
        for (const w of (page.words ?? [])) {
          if ((w.conf ?? 100) < dirtyT) w.needs_vision = true;
        }
        if (page._bucketed) page._bucketed.needs_vision = (page.words ?? []).filter(w => w.needs_vision).length;
      }
    }
  } catch (err) {
    ctx.addError('s4', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s4', { pages_affected: pagesAffected });
  }

  return ctx;
}
