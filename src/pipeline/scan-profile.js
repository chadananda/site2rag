// Language + scan-quality inference from a small page thumbnail.
// Exports: inferScanProfile(ctx) → { language, languageConfidence, scanIssues, tokensIn, tokensOut, costUsd }
// One cheap Haiku call per document — runs in s0 before any heavy processing.
// Deps: config.js (getTmpDir), anthropic SDK, pdftoppm + convert via ctx.run

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { rm } from 'fs/promises';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getTmpDir } from '../config.js';
import { llmCost } from './config.js';

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 12);
const MODEL = 'claude-haiku-4-5-20251001';

const PROMPT = `Examine this scanned document sample and the metadata below. Return JSON only.

%METADATA%

Identify:
1. The ACTUAL document language — look at the characters on the page (Arabic script? Latin? CJK?).
   Use ISO 639-2 Tesseract codes: eng, fra, deu, spa, ara, fas, heb, rus, chi_sim, jpn, kor, etc.
   IMPORTANT: Base language on what you SEE in the image, not on any default assumption.
2. Visible scan quality issues

Return exactly:
{
  "language": "<code>",
  "language_confidence": <0.0-1.0>,
  "scan_issues": [<zero or more of: bleed_through, low_contrast, noise, skew, faded, stained>]
}

JSON only, no explanation. If you cannot read the characters, set language_confidence below 0.4.`;

export async function inferScanProfile(ctx) {
  const apiKey = ctx.config.apiKey;
  if (!apiKey) return {};
  if (!existsSync(ctx.sourcePath ?? '')) return {};

  const tmpDir = join(getTmpDir(), `site2rag-scanprofile-${sha(ctx.docId)}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Sample a body page, not the cover. Page 1 is often a title/cover image that
    // looks nothing like the document content. Use page 3 for longer docs, page 2
    // for short ones, falling back to page 1 only for single-page documents.
    const pageCount = ctx.pageCount ?? 1;
    const samplePage = pageCount >= 3 ? 3 : pageCount >= 2 ? 2 : 1;
    const thumbBase = join(tmpDir, 'thumb');
    await ctx.run('pdftoppm', [
      '-r', '72', '-jpeg', '-f', String(samplePage), '-l', String(samplePage), '-singlefile',
      ctx.sourcePath, thumbBase,
    ], { timeout: 15000 });
    const thumbPath = `${thumbBase}.jpg`;
    if (!existsSync(thumbPath)) return {};

    // Crop a 300×200px sample from the center-left body area (not just the header).
    // At 72dpi this covers most of the text area — enough to see script type clearly.
    const samplePath = join(tmpDir, 'sample.jpg');
    await ctx.run('convert', [
      thumbPath, '-crop', '300x200+50+120', '+repage', '-resize', '300x200>', samplePath,
    ], { timeout: 10000 });
    if (!existsSync(samplePath)) return {};

    const b64 = readFileSync(samplePath).toString('base64');

    const meta = [
      `Filename: ${basename(ctx.sourcePath)}`,
      ctx.sourceUrl         ? `URL: ${ctx.sourceUrl}` : null,
      ctx.meta?.title       ? `Title: ${ctx.meta.title}` : null,
      ctx.meta?.anchorText  ? `Link text: ${ctx.meta.anchorText}` : null,
      ctx.meta?.pageTitle   ? `Containing page: ${ctx.meta.pageTitle}` : null,
    ].filter(Boolean).join('\n');

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, timeout: 30000 });
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: PROMPT.replace('%METADATA%', meta) },
      ]}],
    });

    const raw = msg.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : {};

    const tokensIn  = msg.usage?.input_tokens  ?? 0;
    const tokensOut = msg.usage?.output_tokens ?? 0;

    return {
      language:           result.language           ?? null,
      languageConfidence: result.language_confidence ?? 0,
      scanIssues:         Array.isArray(result.scan_issues) ? result.scan_issues : [],
      tokensIn,
      tokensOut,
      costUsd: llmCost(MODEL, tokensIn, tokensOut),
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
