// Haiku OCR spell/hyphen correction for search-layer word bbox objects.
// Exports: spellFixWordObjects, spellFixMarkdown, spellFixCost. Deps: Anthropic SDK
import Anthropic from '@anthropic-ai/sdk';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
// Haiku 4.5 pricing: $0.80/MTok in, $4.00/MTok out
const COST_IN  = 0.80 / 1e6;
const COST_OUT = 4.00 / 1e6;

/** Estimated cost in USD to spell-fix a document. */
export const spellFixCost = (pages, avgCharsPerPage = 2000) => {
  const tIn  = pages * (avgCharsPerPage / 4 + 50);
  const tOut = pages * (avgCharsPerPage / 4);
  return tIn * COST_IN + tOut * COST_OUT;
};

const BASE_SYSTEM = `You correct OCR errors in scanned document text. You receive a numbered word list and return ONLY the entries that need fixing, in the format N:corrected_word. Nothing else.

Fix only:
1. Hyphen-broken words: "antici-¶pates" is one entry representing a line-end hyphen split — return "anticipates" at that index
2. Missing spaces: "worthreading" → "worth reading"
3. Clear OCR character confusions (rn→m, li→h, 0→O, l→1) where context is obvious
4. Obvious misspellings resolvable from context

Do NOT fix proper nouns, names, numbers, dates, foreign terms, or anything uncertain.
Output: one correction per line as N:corrected text. Emit nothing for correct words.`;

/** Build system prompt with optional document context and vision drafts for broker mode. */
const buildSystem = ({ title, pageNo, totalPages, prevPageTail, language, domainContext, visionDraft } = {}) => {
  const lines = [];
  if (title) lines.push(`Document: "${title}"`);
  if (language) lines.push(`Language: ${language}`);
  if (pageNo && totalPages) lines.push(`Page: ${pageNo} of ${totalPages}`);
  else if (pageNo) lines.push(`Page: ${pageNo}`);
  if (domainContext) lines.push(domainContext);
  if (prevPageTail) lines.push(`Previous page ends with: "...${prevPageTail.slice(-200).trim()}"`);
  if (visionDraft?.boss || visionDraft?.marker) {
    lines.push('');
    lines.push('Independent vision readings of this page (use as reference — they may have different errors):');
    if (visionDraft.boss)   lines.push(`Vision A: ${visionDraft.boss.slice(0, 800)}`);
    if (visionDraft.marker) lines.push(`Vision B: ${visionDraft.marker.slice(0, 800)}`);
  }
  return lines.length ? `${lines.join('\n')}\n\n${BASE_SYSTEM}` : BASE_SYSTEM;
};

/**
 * Build a numbered entry list from bbox word objects for Haiku.
 * Hyphen-at-end-of-line pairs (word ends with '-', next word starts lowercase)
 * are merged into a single entry "word-¶continuation" so the AI sees both halves.
 * The second half's original index is tracked for removal after correction.
 *
 * Returns { entries: [{idx, display, srcIdx, mergedSrcIdx}] }
 *   srcIdx = index in bboxWords for this entry's primary object
 *   mergedSrcIdx = index of the second-half object to drop (or null)
 */
const buildEntries = (bboxWords) => {
  const entries = [];
  const skip = new Set();
  let idx = 0;
  for (let i = 0; i < bboxWords.length; i++) {
    if (skip.has(i)) continue;
    const text = bboxWords[i].text ?? '';
    if (text.endsWith('-') && i + 1 < bboxWords.length) {
      const nextText = bboxWords[i + 1].text ?? '';
      if (nextText && /^[a-z]/.test(nextText)) {
        entries.push({ idx: ++idx, display: `${text}¶${nextText}`, srcIdx: i, mergedSrcIdx: i + 1 });
        skip.add(i + 1);
        continue;
      }
    }
    entries.push({ idx: ++idx, display: text, srcIdx: i, mergedSrcIdx: null });
  }
  return entries;
};

/** Call Haiku with a numbered word list; parse sparse N:correction output. */
const fixChunk = async (client, entries, system) => {
  const wordList = entries.map(({ idx, display }) => `${idx}:${display}`).join('\n');
  const msg = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: Math.min(1024, entries.length * 6 + 50),
    system,
    messages: [{ role: 'user', content: wordList }]
  });
  const corrections = new Map();
  const raw = msg.content[0]?.text || '';
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\d+):(.*)$/);
    if (m) corrections.set(parseInt(m[1], 10), m[2].trim());
  }
  return {
    corrections,
    tokens_in: msg.usage?.input_tokens || 0,
    tokens_out: msg.usage?.output_tokens || 0
  };
};

/**
 * Spell-fix an array of OCR word bbox objects.
 * Each object must have a .text property; bbox fields (x1, y1, x2, y2, conf) are preserved.
 *
 * Hyphen-merged pairs: the first object gets the corrected word, its bbox is extended
 * to cover the second object, and the second object is removed from the output.
 *
 * @param {Array<{text: string, [k: string]: any}>} bboxWords
 * @param {string} apiKey
 * @param {object} [ctx]                    - Document context for better accuracy
 * @param {string} [ctx.title]
 * @param {string} [ctx.language]
 * @param {string} [ctx.domainContext]      - domain.prompt_context (2-4 sentence expert briefing)
 * @param {number} [ctx.pageNo]
 * @param {number} [ctx.totalPages]
 * @param {string} [ctx.prevPageTail]       - Last ~200 chars of previous page
 * @param {{boss:string|null, marker:string|null}} [ctx.visionDraft] - parallel vision readings
 * @returns {{ words: Array, cost_usd: number, tokens_in: number, tokens_out: number }}
 */
export const spellFixWordObjects = async (bboxWords, apiKey, ctx = {}) => {
  const client = new Anthropic({ apiKey });
  const system = buildSystem(ctx);
  const entries = buildEntries(bboxWords);

  // Chunk into ~500-entry groups, process 4 at a time
  const CHUNK_SIZE = 500;
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) chunks.push(entries.slice(i, i + CHUNK_SIZE));

  let tokIn = 0, tokOut = 0;
  const corrections = new Map();
  for (let i = 0; i < chunks.length; i += 4) {
    const batch = await Promise.all(chunks.slice(i, i + 4).map(c => fixChunk(client, c, system)));
    for (const r of batch) {
      for (const [idx, val] of r.corrections) corrections.set(idx, val);
      tokIn += r.tokens_in;
      tokOut += r.tokens_out;
    }
  }

  // Apply corrections back to bbox objects; merge hyphen-pair bboxes; drop second-half objects
  // _srcIdx: index in original bboxWords this result word came from
  // _mergedSrcIdx: index of the second-half word that was consumed (for callers to skip it)
  const result = [];
  for (const { idx, display, srcIdx, mergedSrcIdx } of entries) {
    const corrected = corrections.get(idx);
    const obj = { ...bboxWords[srcIdx] };
    // Use corrected text, or strip ¶ from uncorrected merged display
    obj.text = corrected !== undefined ? corrected : display.replace(/¶/g, '');
    obj._srcIdx = srcIdx;
    if (mergedSrcIdx !== null) {
      obj._mergedSrcIdx = mergedSrcIdx;
      const next = bboxWords[mergedSrcIdx];
      // Only extend bbox when both words are on the same line (cross-line hyphen splits
      // keep the first word's bbox — the continuation is on the next line).
      if (next && next.y1 !== undefined && obj.y2 !== undefined && next.y1 <= obj.y2) {
        obj.x2 = Math.max(obj.x2 ?? 0, next.x2 ?? 0);
        obj.y2 = Math.max(obj.y2 ?? 0, next.y2 ?? 0);
      }
    }
    result.push(obj);
  }

  return {
    words: result,
    cost_usd: tokIn * COST_IN + tokOut * COST_OUT,
    tokens_in: tokIn,
    tokens_out: tokOut
  };
};

/**
 * Convenience wrapper: spell-fix plain markdown text (e.g. marker output, no bboxes).
 * Splits on whitespace, treats each token as a pseudo word object, reassembles with spaces.
 * Structural whitespace (paragraph breaks, indentation) is not preserved — use per-paragraph
 * calls if layout matters.
 */
export const spellFixMarkdown = async (markdown, apiKey, ctx = {}) => {
  const wordTexts = markdown.split(/\s+/).filter(Boolean);
  const pseudoWords = wordTexts.map(text => ({ text }));
  const { words: fixed, cost_usd, tokens_in, tokens_out } = await spellFixWordObjects(pseudoWords, apiKey, ctx);
  return {
    markdown: fixed.map(w => w.text).join(' '),
    cost_usd, tokens_in, tokens_out
  };
};
