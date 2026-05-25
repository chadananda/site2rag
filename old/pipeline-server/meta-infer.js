// Infer missing PDF metadata (title, authors, description, keywords) via Haiku.
// Called from s0-baseline when PDF has no or sparse XMP/info metadata.
// Exports: inferMissingMeta(ctx, { excerpt, apiKey }) → { tokensIn, tokensOut, costUsd }
// Only fills fields absent from ctx.meta — never overwrites caller-provided data.
import { llmCost } from './config.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Infer missing metadata from available signals (excerpt, URL, anchor text, existing meta).
 * Mutates ctx.meta in-place, adding only missing fields.
 */
export async function inferMissingMeta(ctx, { excerpt, apiKey }) {
  const hasTitle       = !!ctx.meta?.title?.trim();
  const hasDescription = !!ctx.meta?.description?.trim();
  const hasAuthors     = !!(ctx.meta?.authors?.length || ctx.meta?.author?.trim());
  const hasKeywords    = !!ctx.meta?.keywords?.length;

  // Skip if already fully enriched, or nothing to work with
  if ((hasTitle && hasDescription && hasAuthors && hasKeywords) || !apiKey) {
    return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }

  const signals = buildSignals(ctx, excerpt);
  if (!signals) return { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const missing = [
      !hasTitle       && 'title',
      !hasAuthors     && 'authors',
      !hasDescription && 'description',
      !hasKeywords    && 'keywords',
    ].filter(Boolean).join(', ');

    const msg = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: `Extract document metadata. Missing fields needed: ${missing}.

${signals}

Respond with valid JSON only — no explanation, no markdown fences:
{
  "title": "document title or null",
  "authors": ["Author Name"] or [],
  "description": "1-2 sentence description of what this document is about, or null",
  "keywords": ["up to 10 relevant search terms"],
  "year": 2024 or null
}`
      }]
    });

    const tokensIn  = msg.usage?.input_tokens  ?? 0;
    const tokensOut = msg.usage?.output_tokens ?? 0;
    const costUsd   = llmCost(HAIKU_MODEL, tokensIn, tokensOut);

    const text = msg.content[0]?.text?.trim() ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { tokensIn, tokensOut, costUsd };

    const inferred = JSON.parse(jsonMatch[0]);
    ctx.meta = ctx.meta ?? {};

    // Only fill what was missing — caller-provided data always wins
    if (!hasTitle       && inferred.title)              ctx.meta.title       = inferred.title;
    if (!hasAuthors     && inferred.authors?.length)    ctx.meta.authors     = inferred.authors;
    if (!hasDescription && inferred.description)        ctx.meta.description = inferred.description;
    if (!hasKeywords    && inferred.keywords?.length)   ctx.meta.keywords    = inferred.keywords;
    if (!ctx.meta.year  && inferred.year)               ctx.meta.year        = inferred.year;

    return { tokensIn, tokensOut, costUsd };
  } catch {
    return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }
}

function buildSignals(ctx, excerpt) {
  const parts = [
    ctx.meta?.title       && `Known title: "${ctx.meta.title}"`,
    ctx.meta?.authors?.length && `Known author: "${[].concat(ctx.meta.authors).join(', ')}"`,
    ctx.meta?.pageTitle   && `Hosting page title: "${ctx.meta.pageTitle}"`,
    ctx.meta?.anchorText  && `Link anchor text: "${ctx.meta.anchorText}"`,
    ctx.meta?.sourceUrl   && `Source URL: ${ctx.meta.sourceUrl}`,
    ctx.meta?.language    && `Language: ${ctx.meta.language}`,
    excerpt?.trim()       && `Text sample:\n${excerpt.slice(0, 1000)}`,
  ].filter(Boolean);
  return parts.length >= 1 ? parts.join('\n') : null;
}
