// HTML export -- converts HTML pages to MD with rich frontmatter. Skips unchanged source.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { mdDir, assetsDir } from './config.js';
import { upsertExport } from './db.js';
import { extractMetadata } from './metadata.js';
import { compileRules } from './rules.js';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const mkTurndown = () => { const td = new TurndownService({ codeBlockStyle: 'fenced', linkStyle: 'inlined' }); td.use(gfm); return td; };
/** Build YAML frontmatter block from object. */
const buildFrontmatter = (obj) => {
  const yaml = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
  return `---\n${yaml}\n---\n\n`;
};
/** Rewrite asset URLs in MD to local relative paths; preserve original URL in comment. */
const rewriteAssetLinks = (md, db, domain) => {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const row = db.prepare('SELECT path FROM assets WHERE original_url=?').get(url);
    if (!row) return match;
    const rel = row.path.replace(assetsDir(domain), '../_assets');
    return `![${alt}](${rel})<!-- src: ${url} -->`;
  });
};
/** Extract and convert HTML page to MD string + metadata. */
const convertHtml = (html, url, page, compiled, rewriteLinks, db, domain) => {
  const $ = cheerio.load(html);
  let $content;
  let method;
  // Apply rules selectors or Readability fallback
  if (compiled.content_selector) {
    $content = $(compiled.content_selector).clone();
    compiled.exclude_selectors.forEach(sel => $content.find(sel).remove());
    method = 'rules+turndown';
  } else {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      if (article?.content) {
        $content = cheerio.load(article.content)('body');
        method = 'readability+turndown';
      }
    } catch {}
    if (!$content) { $content = $('body'); method = 'cheerio+turndown'; }
  }
  // Strip scripts, styles, comments
  $content.find('script, style').remove();
  const titleEl = compiled.title_selector ? $(compiled.title_selector).first().text().trim() : null;
  const td = mkTurndown();
  let md = td.turndown($content.html() || '');
  if (rewriteLinks) md = rewriteAssetLinks(md, db, domain);
  return { md, method, titleOverride: titleEl };
};
/**
 * Export a single HTML page to MD. Called inline during mirror (page_role may be null)
 * and by runExportHtml after classify (page_role set). source_hash=null marks preliminary
 * exports so the batch stage re-exports with full metadata after classify.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @param {object} page - Page row
 * @param {string} htmlStr - HTML content (avoids re-reading from disk)
 */
export const exportHtmlPage = (db, siteConfig, page, htmlStr) => {
  const domain = siteConfig.domain;
  const compiled = compileRules(siteConfig.rules);
  const rewriteLinks = siteConfig.assets?.rewrite_links ?? true;
  const outDir = mdDir(domain);
  mkdirSync(outDir, { recursive: true });
  try {
    const meta = extractMetadata(htmlStr, page.url);
    const { md, method, titleOverride } = convertHtml(htmlStr, page.url, page, compiled, rewriteLinks, db, domain);
    const mdPath = join(outDir, `${page.path_slug}.md`);
    let hostsArr = null;
    if (page.page_role === 'host_page') {
      const hosted = db.prepare('SELECT h.*, e.md_path FROM hosts h LEFT JOIN exports e ON h.hosted_url=e.url WHERE h.host_url=?').all(page.url);
      hostsArr = hosted.map(h => ({ url: h.hosted_url, backup_url: h.backup_url || null, title: h.hosted_title, md_path: h.md_path || null }));
    }
    const frontmatter = {
      source_url: page.url, canonical_url: meta.canonical_url || page.url,
      backup_url: page.backup_url || null, backup_archived_at: page.backup_archived_at || null,
      archive_only: page.archive_only === 1, domain,
      title: titleOverride || meta.title, title_source: meta.title_source,
      fetched_at: page.last_seen_at, modified_at: page.last_changed_at,
      date_published: meta.date_published || null, date_modified: meta.date_modified || null,
      content_hash: page.content_hash, mime_type: page.mime_type,
      mirror_path: page.local_path, url_path: new URL(page.url).pathname,
      crawl_depth: page.depth, from_sitemap: page.from_sitemap === 1,
      language: meta.language || null, page_role: page.page_role,
      conversion_method: method, ocr_used: false,
      word_count: md.split(/\s+/).filter(Boolean).length,
      authors: meta.authors?.length ? JSON.stringify(meta.authors) : null,
      keywords: meta.keywords?.length ? JSON.stringify(meta.keywords) : null,
      schema_org_type: meta.schema_org_type || null,
      ...(hostsArr ? { hosts: JSON.stringify(hostsArr) } : {})
    };
    const fullMd = buildFrontmatter(frontmatter) + md;
    writeFileSync(mdPath, fullMd, 'utf8');
    // source_hash=null when page_role is unset (preliminary) so batch re-exports after classify
    upsertExport(db, {
      url: page.url, md_path: mdPath,
      source_hash: page.page_role ? page.content_hash : null,
      md_hash: `sha256:${sha256(fullMd)}`, exported_at: new Date().toISOString(),
      conversion_method: method, word_count: frontmatter.word_count,
      ocr_used: 0, ocr_engines: null, reconciler: null, pages: null,
      agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'ok', error: null
    });
    return true;
  } catch (err) {
    console.error(`[export-html] ${page.url}: ${err.message}`);
    upsertExport(db, {
      url: page.url, md_path: null, source_hash: page.content_hash, md_hash: null,
      exported_at: new Date().toISOString(), conversion_method: null, word_count: null,
      ocr_used: 0, ocr_engines: null, reconciler: null, pages: null,
      agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'failed', error: err.message
    });
    return false;
  }
};

/**
 * Run HTML export stage for a site. Exports all classified pages; re-exports
 * preliminary exports (source_hash=null) with correct page_role after classify.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { written, skipped, failed }
 */
export const runExportHtml = (db, siteConfig) => {
  const stats = { written: 0, skipped: 0, failed: 0 };
  // Include pages with exp_hash=null (preliminary exports) even if content unchanged
  const pages = db.prepare("SELECT p.*, e.source_hash as exp_hash FROM pages p LEFT JOIN exports e ON p.url=e.url WHERE p.gone=0 AND p.mime_type LIKE 'text/html%' AND p.local_path IS NOT NULL AND p.page_role IS NOT NULL").all();
  for (const page of pages) {
    if (!existsSync(page.local_path)) { stats.failed++; continue; }
    if (page.exp_hash && page.exp_hash === page.content_hash) { stats.skipped++; continue; }
    try {
      const html = readFileSync(page.local_path, 'utf8');
      if (exportHtmlPage(db, siteConfig, page, html)) stats.written++;
      else stats.failed++;
    } catch (err) {
      console.error(`[export-html] ${page.url}: ${err.message}`);
      stats.failed++;
    }
  }
  return stats;
};
