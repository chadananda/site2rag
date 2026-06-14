// Builds the free-text `context` block sent with an SLP job. Distills the document's hosting
// page(s) — title, link text, description, author, language, subject, likely proper nouns — via a
// cheap DeepSeek call. SLP feeds this into OCR synthesis + metadata extraction (better proper-noun
// and archaic-spelling resolution). Cache-optimized: the system prompt is byte-stable across calls
// (cached prefix), only the page signals vary. Deps: DEEPSEEK_API_KEY. See db.js (hosts, pdf_quality).
import { readFileSync, existsSync } from 'fs';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Stable system prompt — keep byte-identical across calls so DeepSeek caches it as the shared prefix.
const SYS = [
  'You write a short, factual CONTEXT note about a document to help an OCR + metadata service process it accurately.',
  'You are given text gathered from the library web page(s) that link to the document.',
  'Output 2–5 plain-text sentences (no markdown, no JSON, no preamble) stating ONLY what the input supports:',
  "the document's title, author or editor, publication/date, source collection or journal, primary language,",
  'subject, and any proper nouns, names, or archaic/transliterated spellings likely to appear in the text.',
  'Omit anything not supported by the input. Never invent. Keep under 200 words.',
].join(' ');

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&aacute;/g, 'á').replace(/&iacute;/g, 'í').replace(/&eacute;/g, 'é')
  .replace(/&[a-z]+;/gi, ' ');

const metaTags = (html) => {
  const out = {};
  const t = html.match(/<title>([^<]*)<\/title>/i); if (t) out.title = t[1].trim();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (m[0].match(/(?:property|name)=["']([^"']+)["']/i) || [])[1];
    const val = (m[0].match(/content=["']([^"']*)["']/i) || [])[1];
    if (key && val) out[key.toLowerCase()] = val;
  }
  return out;
};

const bodyText = (html) => decodeEntities(
  html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
).replace(/\s+/g, ' ').trim();

/** Gather raw signals about a document from its hosting page(s) + existing DB hints. Returns a string or null. */
export function gatherSignals(db, url) {
  let out = `Filename: ${url.split('/').pop()}`;
  const hosts = db.prepare('SELECT host_url FROM hosts WHERE hosted_url=?').all(url);
  for (const h of hosts) {
    const pg = db.prepare('SELECT local_path FROM pages WHERE url=?').get(h.host_url);
    if (!pg?.local_path || !existsSync(pg.local_path)) continue;
    const html = readFileSync(pg.local_path, 'utf8');
    const mt = metaTags(html);
    out += `\nPAGE ${h.host_url}`;
    if (mt.title) out += `\n  title: ${mt.title}`;
    if (mt['og:title']) out += `\n  og:title: ${mt['og:title']}`;
    const desc = mt.description || mt['og:description'];
    if (desc) out += `\n  description: ${desc}`;
    out += `\n  body: ${bodyText(html).slice(0, 1000)}`;
  }
  const q = db.prepare('SELECT pdf_title, excerpt, ai_author FROM pdf_quality WHERE url=?').get(url);
  if (q?.excerpt) out += `\nText excerpt: ${q.excerpt.slice(0, 400)}`;
  return out.trim() ? out : null;
}

/**
 * Build the SLP `context` string for a document. Returns a string (≤ ~3500 chars) or null if no signals.
 * @param {object}   o
 * @param {Database} o.db       open per-site DB (read access to hosts, pages, pdf_quality)
 * @param {string}   o.url      document URL
 * @param {string}   o.apiKey   DEEPSEEK_API_KEY
 * @param {string}  [o.model]   DeepSeek model (default deepseek-v4-flash)
 */
export async function buildJobContext({ db, url, apiKey, model = 'deepseek-v4-flash' }) {
  if (!apiKey) return null;
  const signals = gatherSignals(db, url);
  if (!signals) return null;
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // deepseek-v4-flash is a reasoning model; disable thinking so the token budget goes to output
      // (otherwise reasoning_tokens consume max_tokens and content comes back empty/truncated).
      model, temperature: 0, max_tokens: 400, thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: signals.slice(0, 8000) }],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek context ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content?.trim() || '';
  const usage = j.usage || {};
  return { context: text.slice(0, 3800) || null, cacheHit: usage.prompt_cache_hit_tokens ?? 0, cacheMiss: usage.prompt_cache_miss_tokens ?? 0 };
}
