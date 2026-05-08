// Stage 2: Per-page region classification via Haiku on low-res thumbnail.
// Exports: s2Classify, langToRegionType
//   s2Classify(ctx) → ctx   — classifies pages into region types; falls back to lang default
//   langToRegionType(lang)  — 'ar'|'fa'|'zh'|'ja'|'ko' → region type string
// CONFIG: apiKey                     — required for Haiku classification
//         escalation.regionClassify:3 — min importance to use Haiku (default 3)
//         toolBackends.pdftoppm      — route thumbnail rasterization to remote
// ERRORS: pdftoppm fail → fallback to language default (recoverable)
//         Haiku API error → fallback to language default (recoverable)
// CONTRACT:
//   Reads:  ctx.pages, ctx.config.escalation.regionClassify, ctx.importance, ctx.meta.language
//   Writes: ctx.pages[n].regions = [{type, bbox:[x1,y1,x2,y2]}]
//   Types:  printed_latin|printed_arabic|printed_persian|printed_cjk|handwritten|table|figure|degraded
import { shouldRun } from '../config.js';          // shouldRun(stage,ctx)→bool
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getTmpDir } from '../../config.js';

export async function s2Classify(ctx) {
  if (!shouldRun('s2', ctx)) return ctx;

  ctx.beginStage('s2');
  let pagesAffected = 0, totalCost = 0, totalIn = 0, totalOut = 0;

  try {
    const defaultType = langToRegionType(ctx.meta?.language);
    const apiKey = ctx.config.apiKey;
    const gate = ctx.config.escalation?.regionClassify ?? 3;
    const canUseHaiku = apiKey && ctx.importance >= gate && existsSync(ctx.sourcePath ?? '');

    if (!canUseHaiku) {
      ctx.addDecision('s2', 'fallback', apiKey ? `importance ${ctx.importance} < gate ${gate}` : 'no apiKey — language default');
    }

    await Promise.all(ctx.pages.map(async (page) => {
      if (page.regions?.length) { pagesAffected++; return; }
      if (canUseHaiku) {
        try {
          const result = await classifyPageWithHaiku(page.pageNo, ctx, apiKey);
          if (result?.regions?.length) {
            page.regions = result.regions;
            totalCost += result.cost ?? 0;
            totalIn += result.tokensIn ?? 0;
            totalOut += result.tokensOut ?? 0;
            pagesAffected++;
            ctx.addDecision('s2', `page_${page.pageNo}`, `haiku:${result.regions.map(r => r.type).join(',')}`);
            return;
          }
        } catch (e) {
          ctx.addDecision('s2', `page_${page.pageNo}_err`, e.message.slice(0, 80));
        }
      }
      page.regions = [{ type: defaultType, bbox: [0, 0, 1700, 2200] }];
      pagesAffected++;
    }));
  } catch (err) {
    ctx.addError('s2', err, true);
    if (ctx.config.failFast) throw err;
  } finally {
    ctx.endStage('s2', { pages_affected: pagesAffected, tokens_in: totalIn, tokens_out: totalOut, cost_usd: totalCost });
  }

  return ctx;
}

async function classifyPageWithHaiku(pageNo, ctx, apiKey) {
  const docHash = createHash('sha256').update(ctx.docId).digest('hex').slice(0, 12);
  const tmpDir = join(getTmpDir(), `site2rag-s2-${docHash}`);
  mkdirSync(tmpDir, { recursive: true });
  const outBase = join(tmpDir, `p${pageNo}`);
  await ctx.run('pdftoppm', ['-r', '100', '-jpeg', '-f', String(pageNo), '-l', String(pageNo), '-singlefile', ctx.sourcePath, outBase], { timeout: 30000 });
  const jpegPath = `${outBase}.jpg`;
  if (!existsSync(jpegPath)) return null;
  const b64 = readFileSync(jpegPath).toString('base64');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: 30000 });
  const prompt = `Analyze this document page and return JSON with text regions.
Return ONLY valid JSON: {"regions": [{"type": "printed_latin", "bbox": [x1, y1, x2, y2]}]}
Valid types: printed_latin, printed_arabic, printed_persian, printed_cjk, handwritten, table, figure, degraded
Use one region for uniform pages. Multiple regions only for clearly distinct content types.
bbox is [left, top, right, bottom] in thumbnail pixel coordinates.`;
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 512,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const text = msg.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  return {
    regions: parsed.regions ?? null,
    cost: 0,
    tokensIn: msg.usage?.input_tokens ?? 0,
    tokensOut: msg.usage?.output_tokens ?? 0,
  };
}

export const langToRegionType = (lang) => {
  if (!lang) return 'printed_latin';
  if (['ar', 'ara'].includes(lang)) return 'printed_arabic';
  if (['fa', 'fas', 'per'].includes(lang)) return 'printed_persian';
  if (['zh', 'ja', 'ko'].includes(lang)) return 'printed_cjk';
  return 'printed_latin';
};
