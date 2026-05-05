// Haiku spell/hyphen correction for OCR markdown text. Exports: spellFixMarkdown, spellFixCost. Deps: Anthropic SDK
import Anthropic from '@anthropic-ai/sdk';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const COST_IN  = 0.00025 / 1000;  // $/token input
const COST_OUT = 0.00125 / 1000;  // $/token output

/** Estimated cost in USD to spell-fix a document. */
export const spellFixCost = (pages, avgCharsPerPage = 2000) => {
  const tIn  = pages * (avgCharsPerPage / 4 + 50);  // +50 prompt overhead per chunk
  const tOut = pages * (avgCharsPerPage / 4);
  return tIn * COST_IN + tOut * COST_OUT;
};

const PROMPT = `You are correcting OCR output from a scanned document. Fix these specific error types:
1. Hyphen-broken words: "antici-\npates" → "anticipates", "global-\nization" → "globalization"
2. Missing word boundaries: "worthreading" → "worth reading", "convincingpresentation" → "convincing presentation"
3. Classic OCR confusions: "rn"→"m", "li"→"h", "cl"→"d", zero/O, l/1 where context makes it obvious
4. Obvious spelling errors that context makes clear

Rules:
- Preserve all proper nouns, names, numbers, dates, citations, and specialized terms exactly
- Do not rewrite or paraphrase — only fix the error types above
- Return only the corrected text with identical structure and line breaks`;

/** Spell-fix a single text chunk via Haiku. */
const fixChunk = async (client, text) => {
  const msg = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: Math.min(4096, Math.ceil(text.length / 2) + 100),
    messages: [{ role: 'user', content: `${PROMPT}\n\n${text}` }]
  });
  return {
    text: msg.content[0]?.text || text,
    tokens_in: msg.usage?.input_tokens || 0,
    tokens_out: msg.usage?.output_tokens || 0
  };
};

/**
 * Spell-fix a full OCR markdown document using Haiku.
 * Splits on paragraph breaks so each Haiku call handles ~3000 chars.
 * @param {string} markdown  - Full document text (from marker or tesseract)
 * @param {string} apiKey
 * @returns {{ markdown: string, cost_usd: number, tokens_in: number, tokens_out: number }}
 */
export const spellFixMarkdown = async (markdown, apiKey) => {
  const client = new Anthropic({ apiKey });

  // Split into ~3000-char chunks on paragraph boundaries
  const paragraphs = markdown.split(/\n\n+/);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf.length + p.length > 3000 && buf) { chunks.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) chunks.push(buf);

  // Process chunks with limited concurrency (4 at once)
  let tokIn = 0, tokOut = 0;
  const fixed = [];
  for (let i = 0; i < chunks.length; i += 4) {
    const results = await Promise.all(chunks.slice(i, i + 4).map(c => fixChunk(client, c)));
    for (const r of results) { fixed.push(r.text); tokIn += r.tokens_in; tokOut += r.tokens_out; }
  }

  return {
    markdown: fixed.join('\n\n'),
    cost_usd: tokIn * COST_IN + tokOut * COST_OUT,
    tokens_in: tokIn,
    tokens_out: tokOut
  };
};
