// API response utilities: HTML stripping, link context, free summary, doc mapping. Exports: stripHtml, getLinkContext, buildFreeSummary, mapDoc, buildSummaryPrompt. Deps: language
import { detectLanguage, LANG_COST, LANG_DISPLAY } from '../src/language.js';

/** Strip HTML tags and decode common entities. */
export const stripHtml = (html) => html
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Extract the paragraph surrounding a PDF link in a host page's HTML. */
export const getLinkContext = (html, pdfUrl) => {
  const candidates = [pdfUrl.split('/').pop(), decodeURIComponent(pdfUrl.split('/').pop())];
  for (const needle of candidates) {
    const idx = html.indexOf(needle);
    if (idx < 0) continue;
    const pStart = html.lastIndexOf('<p', idx);
    const pEnd = html.indexOf('</p>', idx);
    const start = (pStart > 0 && pStart > idx - 1000) ? pStart : Math.max(0, idx - 400);
    const end   = (pEnd > 0  && pEnd  < idx + 1000)  ? pEnd + 4 : Math.min(html.length, idx + 400);
    const ctx = stripHtml(html.slice(start, end)).slice(0, 600).trim();
    if (ctx.length > 30) return ctx;
  }
  return null;
};

/** Compose a free (no-API) summary from available metadata. */
export const buildFreeSummary = (row) => {
  const title = row.title || null;
  const domain = row.source_url ? row.source_url.replace(/^https?:\/\//, '').split('/')[0] : null;
  const excerpt = row.excerpt ? row.excerpt.replace(/\s+/g, ' ').trim() : null;
  if (title && excerpt && excerpt.length > 40) {
    const short = excerpt.length > 160 ? excerpt.slice(0, 160).replace(/\s\S*$/, '…') : excerpt;
    return domain ? `${title} — ${short} [${domain}]` : `${title} — ${short}`;
  }
  if (excerpt && excerpt.length > 40) {
    return excerpt.length > 200 ? excerpt.slice(0, 200).replace(/\s\S*$/, '…') : excerpt;
  }
  if (title && domain) return `${title} (from ${domain})`;
  return title || null;
};

/** Transform a DB doc row to API response shape with language normalization + effort estimate. */
export const mapDoc = (d, domain) => {
  const ai_summary = d.ai_summary || buildFreeSummary(d) || null;
  const summary_tier = d.summary_tier || (ai_summary && !d.ai_summary ? 'free' : null);
  const langKey = d.ai_language || detectLanguage([d.excerpt, d.title].filter(Boolean).join(' ')) || 'unknown';
  const ai_language = LANG_DISPLAY[langKey] ?? null;
  const lang_cost_mult = LANG_COST[langKey] ?? LANG_COST.unknown;
  const pages = d.pages || 0;
  const readablePct = d.readable_pages_pct ?? 0;
  const pagesNeeded = Math.round(pages * (1 - readablePct));
  const effort_mins = pagesNeeded > 0 ? Math.max(1, Math.round(pagesNeeded * 0.5 * lang_cost_mult)) : 0;
  return {
    ...d,
    ai_summary,
    summary_tier,
    ai_language,
    lang_key: langKey,
    effort_mins,
    archive_url: d.status === 'done' && d.upgraded_pdf_path
      ? `https://${domain}.lnker.com/_upgraded/${d.path_slug || d.url.replace(/[^a-z0-9]/gi,'_').slice(-60)}.pdf`
      : null,
  };
};

/** Build Haiku summarization prompt for a batch row. Returns null if insufficient metadata. */
export const buildSummaryPrompt = (row) => {
  const title = row.hosted_title || row.pdf_title || null;
  const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
  const displayTitle = title || (slug.length > 3 && !/^\d+$/.test(slug.trim()) ? slug : null);
  if (!displayTitle && !row.excerpt && !row.source_url) return null;
  return `Metadata for a PDF document:\n${[
    displayTitle && `Title: ${displayTitle}`,
    `URL: ${row.url}`,
    row.source_url && `Source page: ${row.source_url}`,
    row.excerpt && `Excerpt: ${row.excerpt.slice(0, 500)}`
  ].filter(Boolean).join('\n')}\n\nRespond with exactly two plain-text lines (no markdown, no numbering):\nLine 1: one sentence describing this document.\nLine 2: Author: [full name, or Unknown]`;
};
