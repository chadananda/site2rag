// Metadata extractor -- JSON-LD, OpenGraph, meta tags, byline heuristics. All fallback chains deterministic.
import * as cheerio from 'cheerio';
/** Extract JSON-LD objects from page HTML. */
const extractJsonLd = ($) => {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { results.push(JSON.parse($(el).text())); } catch {}
  });
  return results;
};
/** Find first JSON-LD object matching type. */
const findJsonLd = (items, ...types) => items.find(item => types.some(t => item['@type'] === t || (Array.isArray(item['@type']) && item['@type'].includes(t))));
/** Normalize ISO date string or return null. */
const normDate = (v) => { try { return v ? new Date(v).toISOString() : null; } catch { return null; } };
/** Extract authors from JSON-LD Person/Organization or string. */
const parseAuthors = (raw) => {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(a => {
    if (typeof a === 'string') return { name: a };
    return { name: a.name, url: a.url, bio: a.description, job_title: a.jobTitle, organization: a.worksFor?.name };
  }).filter(a => a.name);
};
/**
 * Extract rich metadata from HTML string. Returns frontmatter-ready object.
 * @param {string} html - Raw HTML content
 * @param {string} pageUrl - Canonical URL for fallback
 * @param {object} httpHeaders - HTTP response headers
 */
export const extractMetadata = (html, pageUrl = '', httpHeaders = {}) => {
  const $ = cheerio.load(html);
  const jsonLdItems = extractJsonLd($);
  const article = findJsonLd(jsonLdItems, 'Article', 'NewsArticle', 'BlogPosting', 'WebPage');
  // title fallback chain: JSON-LD headline/name -> og:title -> <title> -> first h1 -> filename
  let title = article?.headline || article?.name || $('meta[property="og:title"]').attr('content') || $('title').text().trim() || $('h1').first().text().trim() || pageUrl.split('/').pop().replace(/\.\w+$/, '');
  const title_source = article?.headline ? 'json_ld' : article?.name ? 'json_ld' : $('meta[property="og:title"]').attr('content') ? 'og' : $('title').text().trim() ? 'meta' : $('h1').first().text().trim() ? 'h1' : 'filename';
  // authors
  let authors = parseAuthors(article?.author);
  if (!authors.length) {
    const metaAuthor = $('meta[name="author"]').attr('content') || $('meta[name="DC.Creator"]').attr('content');
    if (metaAuthor) authors = [{ name: metaAuthor }];
  }
  if (!authors.length) {
    const byline = $('.byline, .author, [rel="author"]').first().text().trim();
    if (byline) authors = [{ name: byline }];
  }
  // dates
  const date_published = normDate(article?.datePublished) || normDate($('meta[property="article:published_time"]').attr('content')) || normDate(httpHeaders['last-modified']);
  const date_modified = normDate(article?.dateModified) || normDate($('meta[property="article:modified_time"]').attr('content')) || normDate(httpHeaders['last-modified']);
  // language
  const language = $('html').attr('lang')?.split('-')[0] || null;
  // keywords
  const metaKw = ($('meta[name="keywords"]').attr('content') || '').split(',').map(k => k.trim()).filter(Boolean);
  const jsonKw = Array.isArray(article?.keywords) ? article.keywords : (article?.keywords ? [article.keywords] : []);
  const keywords = [...new Set([...metaKw, ...jsonKw])];
  // schema type
  const schema_org_type = (article && article['@type']) ? (Array.isArray(article['@type']) ? article['@type'][0] : article['@type']) : null;
  // canonical
  const canonical_url = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || pageUrl;
  return { title, title_source, authors, date_published, date_modified, language, keywords, schema_org_type, canonical_url };
};
