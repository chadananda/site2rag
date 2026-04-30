// Classify stage -- rules-first 4-role classifier. No runtime LLM.
import { readFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { compileRules, applyClassifyOverride } from './rules.js';
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.odt', '.epub', '.txt']);
/** Strip HTML to plain text. */
const toText = (html) => cheerio.load(html).text().replace(/\s+/g, ' ').trim();
/** Count words in text. */
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
/** String similarity -- Jaccard on word sets. Used for title_doc_overlap. */
const jaccard = (a, b) => {
  const sa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...sa].filter(w => sb.has(w)).length;
  return intersection / (sa.size + sb.size - intersection || 1);
};
/** Extract clean body text via rules content_selector or Readability fallback. */
const extractCleanText = ($, html, compiled) => {
  if (compiled.content_selector) {
    let $content = $(compiled.content_selector);
    compiled.exclude_selectors.forEach(sel => $content.find(sel).remove());
    return $content.text().replace(/\s+/g, ' ').trim();
  }
  try {
    const dom = new JSDOM(html, { url: 'https://example.com' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    return article ? article.textContent.replace(/\s+/g, ' ').trim() : toText(html);
  } catch { return toText(html); }
};
/** Compute doc_link_count and title_doc_overlap for host_page detection. */
const computeDocFeatures = ($, pageTitle) => {
  let doc_link_count = 0;
  let max_overlap = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const ext = href.split('.').pop().toLowerCase().split('?')[0];
    if (DOC_EXTS.has(`.${ext}`)) {
      doc_link_count++;
      const linkText = $(el).text().trim() || href.split('/').pop().replace(/\.\w+$/, '');
      const overlap = jaccard(pageTitle, linkText);
      if (overlap > max_overlap) max_overlap = overlap;
    }
  });
  return { doc_link_count, title_doc_overlap: max_overlap };
};
/** Compute text-to-link ratio. */
const textToLinkRatio = ($, text) => {
  const linkCount = $('a[href]').length;
  const wc = wordCount(text);
  return linkCount > 0 ? wc / linkCount : wc;
};
/** Heuristic 4-role classification based on computed features. */
const heuristicRole = (features, wordThreshold) => {
  const { wc, doc_link_count, title_doc_overlap, outbound_link_count, ttr } = features;
  if (wc < wordThreshold && doc_link_count >= 1 && (title_doc_overlap > 0.3 || doc_link_count >= 1)) return 'host_page';
  if (wc < 50 && outbound_link_count === 1) return 'redirect';
  if (ttr < 5 && outbound_link_count > 10) return 'index';
  return 'content';
};
/**
 * Classify all unclassified pages for a site.
 * @param {object} db - SQLite db for domain
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { classified, host_pages, rule_overrides }
 */
export const runClassify = (db, siteConfig) => {
  const wordThreshold = siteConfig.classify?.word_threshold ?? 200;
  const compiled = compileRules(siteConfig.rules);
  const pages = db.prepare("SELECT * FROM pages WHERE gone=0 AND mime_type LIKE 'text/html%' AND local_path IS NOT NULL").all();
  const stats = { classified: 0, host_pages: 0, rule_overrides: 0 };
  for (const page of pages) {
    if (!existsSync(page.local_path)) continue;
    const html = readFileSync(page.local_path, 'utf8');
    // Rules-first: check classify_overrides
    const overrideRole = applyClassifyOverride(compiled, page.url);
    if (overrideRole) {
      db.prepare('UPDATE pages SET page_role=?, classify_method=? WHERE url=?').run(overrideRole, 'rules', page.url);
      stats.classified++;
      stats.rule_overrides++;
      if (overrideRole === 'host_page') stats.host_pages++;
      continue;
    }
    // Compute features
    const $ = cheerio.load(html);
    const title = $('title').text().trim() || $('h1').first().text().trim() || '';
    const cleanText = extractCleanText($, html, compiled);
    const wc = wordCount(cleanText);
    const { doc_link_count, title_doc_overlap } = computeDocFeatures($, title);
    const outbound_link_count = $('a[href]').length;
    const ttr = textToLinkRatio($, cleanText);
    const role = heuristicRole({ wc, doc_link_count, title_doc_overlap, outbound_link_count, ttr }, wordThreshold);
    db.prepare('UPDATE pages SET page_role=?, classify_method=?, word_count_clean=? WHERE url=?').run(role, 'heuristic', wc, page.url);
    // Populate hosts table for host_page role
    if (role === 'host_page') {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const ext = href.split('.').pop().toLowerCase().split('?')[0];
        if (!DOC_EXTS.has(`.${ext}`)) return;
        let hosted_url;
        try { hosted_url = new URL(href, page.url).toString().split('#')[0]; } catch { return; }
        const hosted_title = $(el).text().trim() || href.split('/').pop();
        db.prepare('INSERT OR REPLACE INTO hosts (host_url, hosted_url, hosted_title, detected_at) VALUES (?, ?, ?, ?)').run(page.url, hosted_url, hosted_title, new Date().toISOString());
      });
      stats.host_pages++;
    }
    stats.classified++;
  }
  return stats;
};
