// Classify stage -- rules-first 4-role classifier. Exports: classifyPage, runClassify. Deps: cheerio, jsdom, readability, rules, constants
import { readFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { compileRules, applyClassifyOverride } from './rules.js';
import { DOC_EXTS } from './constants.js';
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
  let dom;
  try {
    dom = new JSDOM(html, { url: 'https://example.com' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    return article ? article.textContent.replace(/\s+/g, ' ').trim() : toText(html);
  } catch { return toText(html); } finally { dom?.window.close(); }
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
/** Populate the hosts table for a host_page. */
const populateHosts = ($, pageUrl, db) => {
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const ext = href.split('.').pop().toLowerCase().split('?')[0];
    if (!DOC_EXTS.has(`.${ext}`)) return;
    let hosted_url;
    try { hosted_url = new URL(href, pageUrl).toString().split('#')[0]; } catch { return; }
    const hosted_title = $(el).text().trim() || href.split('/').pop();
    db.prepare('INSERT OR REPLACE INTO hosts (host_url, hosted_url, hosted_title, detected_at) VALUES (?, ?, ?, ?)').run(pageUrl, hosted_url, hosted_title, new Date().toISOString());
  });
};
/**
 * Classify a single HTML page given its content. Called inline during crawl and as backfill.
 * @param {string} html - HTML content string
 * @param {string} url - Page URL (for host population and rule matching)
 * @param {object} compiled - Compiled rules from compileRules()
 * @param {number} wordThreshold - Min words for content role
 * @param {object} db - SQLite db (for hosts table population)
 * @returns {{ role, classify_method, word_count_clean }}
 */
export const classifyPage = (html, url, compiled, wordThreshold, db) => {
  const overrideRole = applyClassifyOverride(compiled, url);
  if (overrideRole) {
    if (overrideRole === 'host_page' && db) {
      const $ = cheerio.load(html);
      populateHosts($, url, db);
    }
    return { role: overrideRole, classify_method: 'rules', word_count_clean: null };
  }
  const $ = cheerio.load(html);
  const title = $('title').text().trim() || $('h1').first().text().trim() || '';
  const cleanText = extractCleanText($, html, compiled);
  const wc = wordCount(cleanText);
  const { doc_link_count, title_doc_overlap } = computeDocFeatures($, title);
  const outbound_link_count = $('a[href]').length;
  const ttr = textToLinkRatio($, cleanText);
  const role = heuristicRole({ wc, doc_link_count, title_doc_overlap, outbound_link_count, ttr }, wordThreshold);
  if (role === 'host_page' && db) populateHosts($, url, db);
  return { role, classify_method: 'heuristic', word_count_clean: wc };
};
/**
 * Backfill: classify all unclassified HTML pages from disk. Used for pages mirrored
 * before inline classification was wired up.
 */
export const runClassify = async (db, siteConfig) => {
  const wordThreshold = siteConfig.classify?.word_threshold ?? 200;
  const compiled = compileRules(siteConfig.rules);
  const pages = db.prepare("SELECT * FROM pages WHERE gone=0 AND mime_type LIKE 'text/html%' AND local_path IS NOT NULL AND (page_role IS NULL OR COALESCE(classify_method,'') != 'heuristic') LIMIT 50").all();
  const stats = { classified: 0, host_pages: 0, rule_overrides: 0 };
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!existsSync(page.local_path)) continue;
    const html = readFileSync(page.local_path, 'utf8');
    const { role, classify_method, word_count_clean } = classifyPage(html, page.url, compiled, wordThreshold, db);
    db.prepare('UPDATE pages SET page_role=?, classify_method=?, word_count_clean=? WHERE url=?').run(role, classify_method, word_count_clean, page.url);
    if (role === 'host_page') stats.host_pages++;
    if (classify_method === 'rules') stats.rule_overrides++;
    stats.classified++;
    // Yield every page so GC can reclaim JSDOM memory
    await new Promise(r => setImmediate(r));
  }
  return stats;
};
