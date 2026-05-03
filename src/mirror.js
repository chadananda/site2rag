// Mirror stage -- crawls site, conditional GET, writes mirror files, tracks pages in DB.
import { fetch } from 'undici';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, extname } from 'path';
import * as cheerio from 'cheerio';
import { mirrorDir } from './config.js';
import { upsertPage, markGoneUrls } from './db.js';
import { compileRules, applyFollowOverride, stripQueryParams } from './rules.js';
import { scorePdf, saveQualityScore, maybeQueue } from './pdf-upgrade/score.js';
import { exportHtmlPage } from './export-html.js';
import { exportTextPdf } from './export-doc.js';
// Document MIME types that get treated as downloadable documents
const DOC_MIMES = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text', 'application/epub+zip', 'text/plain']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.odt', '.epub', '.txt']);
/** Hash a query string suffix (first 4 bytes hex). */
const hashQuery = (q) => createHash('sha256').update(q).digest('hex').slice(0, 4);
/** sha256 of buffer. */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/**
 * Convert URL to mirror file path. Pure function -- no DB lookup.
 * @param {string} domain - Site domain folder name
 * @param {string} urlStr - Absolute URL
 */
export const urlToMirrorPath = (domain, urlStr) => {
  const u = new URL(urlStr);
  let p = u.pathname;
  // Trailing slash or no extension -> index.html
  if (p.endsWith('/') || !extname(p)) p = p.replace(/\/?$/, '/index.html');
  // Query string -> hash suffix before extension
  if (u.search) {
    const ext = extname(p);
    const base = p.slice(0, -ext.length);
    p = `${base}__${hashQuery(u.search)}${ext}`;
  }
  // Truncate filename component to 200 bytes to avoid ENAMETOOLONG (Linux 255-byte limit).
  // Keeps the extension and uses a hash prefix for uniqueness.
  const parts = p.split('/');
  const last = parts[parts.length - 1];
  if (Buffer.byteLength(last, 'utf8') > 200) {
    const ext = extname(last) || '';
    const hash = createHash('sha256').update(last).digest('hex').slice(0, 12);
    parts[parts.length - 1] = `${hash}${ext}`;
    p = parts.join('/');
  }
  return join(mirrorDir(domain), p.replace(/^\//, ''));
};
/**
 * Convert URL path to MD slug (/ -> -, strip leading/).
 * @param {string} urlPath - URL pathname
 */
export const urlPathToSlug = (urlPath) => urlPath.replace(/^\//, '').replace(/\//g, '-').replace(/\.\w+$/, '') || 'index';
/** Check if URL is in scope for crawling. */
export const inScope = (url, siteConfig, seedHost) => {
  const { include = [], exclude = [], same_domain_only: sameDomain = true, max_depth: maxDepth = 8 } = siteConfig;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (sameDomain && u.hostname !== seedHost) return false;
  const path = u.pathname;
  if (exclude.some(p => path.startsWith(p))) return false;
  if (include.length && !include.some(p => path.startsWith(p))) return false;
  return true;
};
/** Parse robots.txt rules for a host. Returns Set of disallowed path prefixes for our UA. */
export const parseRobots = (text, ua) => {
  const disallowed = new Set();
  if (!text) return disallowed;
  let active = false;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('User-agent:')) {
      const agent = l.split(':')[1].trim();
      active = agent === '*' || agent.toLowerCase().includes('site2rag');
    }
    if (active && l.startsWith('Disallow:')) {
      const path = l.split(':')[1]?.trim();
      if (path) disallowed.add(path);
    }
  }
  return disallowed;
};
/** Extract links from HTML, returning absolute URL strings. */
export const extractLinks = ($, baseUrl) => {
  const links = [];
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('data:')) return;
      const resolved = new URL(href, baseUrl).toString().split('#')[0];
      links.push(resolved);
    } catch {}
  });
  return links;
};
/**
 * Run mirror stage for a site. Crawls pages, writes files, updates DB.
 * @param {object} db - SQLite db for this domain
 * @param {object} siteConfig - Merged site config
 * @param {string[]} priorityQueue - URLs from sitemap diff (fetched first)
 * @returns {object} Stats: { checked, new_pages, changed, gone }
 */
export const runMirror = async (db, siteConfig, priorityQueue = []) => {
  const domain = siteConfig.domain;
  const seedUrl = siteConfig.url;
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const maxDepth = siteConfig.max_depth ?? 8;
  const requestDelay = siteConfig.request_delay_ms ?? 0;
  const compiled = compileRules(siteConfig.rules);
  const seedHost = new URL(seedUrl).hostname;
  // Resume support: if a prior run was interrupted, continue from its start time
  const RESUME_KEY = 'mirror_run_started_at';
  const savedStart = db.prepare('SELECT value FROM site_meta WHERE key=?').get(RESUME_KEY)?.value;
  const isResume = savedStart && (Date.now() - new Date(savedStart).getTime()) < 86400000; // 24h resume window
  const runStartedAt = isResume ? savedStart : new Date().toISOString();
  if (!isResume) db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run(RESUME_KEY, runStartedAt);
  // Fetch robots.txt
  let disallowed = new Set();
  if (siteConfig.respect_robots_txt) {
    try {
      const robotsRes = await fetch(`${new URL(seedUrl).origin}/robots.txt`, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(5000) });
      if (robotsRes.ok) disallowed = parseRobots(await robotsRes.text(), ua);
    } catch {}
  }
  const isRobotsAllowed = (url) => {
    const path = new URL(url).pathname;
    return ![...disallowed].some(d => path.startsWith(d));
  };
  // Pre-populate visited from pages already fetched in this run (resume support)
  const visited = new Set();
  if (isResume) {
    for (const { url } of db.prepare('SELECT url FROM pages WHERE last_seen_at >= ?').all(runStartedAt)) {
      visited.add(url);
    }
  }
  // discoverQueue: seed + sitemap + newly found links (drained first)
  // recheckQueue: stale existing pages (only processed after discoverQueue is empty)
  // On resume: skip re-seeding from the top of the site — just continue with recheckQueue.
  // Seeding on every restart causes top-level pages to be re-fetched on every PM2 reload.
  const discoverQueue = isResume ? [] : [
    ...priorityQueue.filter(u => inScope(u, siteConfig, seedHost)).map(u => ({ url: u, depth: 0, fromSitemap: true })),
    { url: seedUrl, depth: 0, fromSitemap: false }
  ];
  const staleMs = (siteConfig.check_every_days ?? 3) * 86400000;
  // Determine which pages to re-check:
  // - Resume: pages not yet seen in this run (continue where we left off)
  // - Fresh run: pages not seen since the last complete crawl (or all pages if no complete crawl)
  const COMPLETE_KEY = 'last_complete_crawl_at';
  const lastComplete = db.prepare('SELECT value FROM site_meta WHERE key=?').get(COMPLETE_KEY)?.value;
  const staleCutoff = isResume ? runStartedAt : (lastComplete ?? runStartedAt);
  const existingPages = db.prepare('SELECT url, depth FROM pages WHERE gone=0 AND last_seen_at < ?').all(staleCutoff);
  const recheckQueue = [];
  for (const p of existingPages) {
    if (!priorityQueue.includes(p.url) && inScope(p.url, siteConfig, seedHost)) {
      recheckQueue.push({ url: p.url, depth: p.depth || 0, fromSitemap: false });
    }
  }
  const stats = { checked: 0, new_pages: 0, changed: 0, gone: 0 };
  const countPages = db.prepare('SELECT COUNT(*) as n FROM pages WHERE gone=0');
  const upsertMeta = db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)');
  const concurrency = siteConfig.crawl_concurrency ?? 4;
  const inFlight = new Set();

  // Process one URL: fetch, save, extract links. Runs concurrently with other fetches.
  const processOne = async (canonical, depth, fromSitemap) => {
    const existing = db.prepare('SELECT * FROM pages WHERE url=?').get(canonical);
    const headers = { 'User-Agent': ua };
    if (existing?.etag) headers['If-None-Match'] = existing.etag;
    if (existing?.last_modified) headers['If-Modified-Since'] = existing.last_modified;
    let res;
    try {
      res = await fetch(canonical, { headers, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    } catch (err) {
      console.error(`[mirror] fetch error ${canonical}: ${err.message}`);
      return;
    }
    stats.checked++;
    if (stats.checked % 10 === 0) {
      upsertMeta.run('mirror_progress', JSON.stringify({ checked: visited.size, total: countPages.get().n, new_pages: stats.new_pages, changed: stats.changed, started_at: runStartedAt }));
    }
    if (res.status === 404 || res.status === 410) {
      if (existing) db.prepare('UPDATE pages SET gone=1, gone_since=COALESCE(gone_since, ?) WHERE url=?').run(new Date().toISOString(), canonical);
      return;
    }
    if (res.status === 304) {
      db.prepare('UPDATE pages SET last_seen_at=? WHERE url=?').run(new Date().toISOString(), canonical);
      return;
    }
    if (!res.ok) return;
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (bodyErr) {
      console.warn(`[mirror] body read error ${canonical}: ${bodyErr.message}`);
      return;
    }
    const contentHash = `sha256:${sha256(buf)}`;
    const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const mirrorPath = urlToMirrorPath(domain, canonical);
    const pathSlug = urlPathToSlug(new URL(canonical).pathname);
    const isNew = !existing;
    const isChanged = existing && existing.content_hash !== contentHash;
    let savedPath = mirrorPath;
    if (isNew || isChanged) {
      try {
        mkdirSync(dirname(mirrorPath), { recursive: true });
        writeFileSync(mirrorPath, buf);
        if (isNew) stats.new_pages++; else stats.changed++;
      } catch (writeErr) {
        if (writeErr.code === 'EEXIST') {
          const ext = extname(mirrorPath);
          const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
          savedPath = join(dirname(dirname(mirrorPath)), `${hash}${ext || '.html'}`);
          try {
            mkdirSync(dirname(savedPath), { recursive: true });
            writeFileSync(savedPath, buf);
            if (isNew) stats.new_pages++; else stats.changed++;
          } catch (e2) {
            console.warn(`[mirror] skipping ${canonical}: ${e2.message}`);
            return;
          }
        } else {
          console.warn(`[mirror] skipping ${canonical}: ${writeErr.message}`);
          return;
        }
      }
      if (mimeType === 'application/pdf') {
        try {
          const metrics = await Promise.race([
            scorePdf(savedPath),
            new Promise((_, rej) => setTimeout(() => rej(new Error('score timeout')), 30000))
          ]);
          saveQualityScore(db, canonical, contentHash, metrics);
          maybeQueue(db, canonical, contentHash, metrics.composite_score, 0.7, metrics.language);
        } catch (scoreErr) {
          console.warn(`[mirror] score failed ${canonical}: ${scoreErr.message}`);
        }
      }
    }
    upsertPage(db, {
      url: canonical, path_slug: pathSlug, local_path: savedPath,
      from_sitemap: fromSitemap ? 1 : 0,
      etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified'),
      content_hash: contentHash, mime_type: mimeType, status_code: res.status,
      depth, page_role: null, word_count_clean: null
    });
    // Inline MD export for new/changed pages
    if (isNew || isChanged) {
      const pageRow = { url: canonical, path_slug: pathSlug, local_path: savedPath,
        content_hash: contentHash, mime_type: mimeType, depth, from_sitemap: fromSitemap ? 1 : 0,
        page_role: null, last_seen_at: new Date().toISOString(), backup_url: null,
        backup_archived_at: null, archive_only: 0, last_changed_at: null };
      if (mimeType.includes('text/html')) {
        try { exportHtmlPage(db, siteConfig, pageRow, buf.toString('utf8')); }
        catch (e) { console.warn(`[mirror] html export ${canonical}: ${e.message}`); }
      } else if (mimeType === 'application/pdf') {
        exportTextPdf(db, siteConfig, pageRow).catch(e =>
          console.warn(`[mirror] pdf export ${canonical}: ${e.message}`)
        );
      }
    }
    if (mimeType.includes('text/html') && depth < maxDepth) {
      const $ = cheerio.load(buf.toString('utf8'));
      for (const link of extractLinks($, canonical)) {
        if (!visited.has(link) && inScope(link, siteConfig, seedHost)) {
          discoverQueue.push({ url: link, depth: depth + 1, fromSitemap: false });
        }
      }
    }
  };

  // Pump: dequeue URLs and fire concurrent fetches, rate-limited by requestDelay.
  while (discoverQueue.length > 0 || recheckQueue.length > 0 || inFlight.size > 0) {
    // Drain completed promises
    if (inFlight.size >= concurrency || (discoverQueue.length === 0 && recheckQueue.length === 0)) {
      await Promise.race(inFlight);
      continue;
    }
    const { url, depth, fromSitemap } = discoverQueue.length > 0 ? discoverQueue.shift() : recheckQueue.shift();
    let canonical;
    try { canonical = stripQueryParams(compiled, url); new URL(canonical); } catch {
      console.warn(`[mirror] skipping malformed URL: ${url}`); continue;
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (depth > maxDepth) continue;
    if (siteConfig.respect_robots_txt && !isRobotsAllowed(canonical)) continue;
    if (applyFollowOverride(compiled, canonical) === false) continue;
    const p = processOne(canonical, depth, fromSitemap).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (requestDelay > 0) await new Promise(r => setTimeout(r, requestDelay));
  }
  const ranToCompletion = discoverQueue.length === 0 && recheckQueue.length === 0;
  if (ranToCompletion) {
    // Safe gone detection: only mark pages gone if they haven't been seen in 3× the check interval.
    // Per-URL 404/410 already marks individual dead pages. This catches pages that silently
    // disappeared from the link graph over many cycles without ever returning 404.
    const safeGoneCutoff = new Date(Date.now() - staleMs * 3).toISOString();
    stats.gone = markGoneUrls(db, safeGoneCutoff);
    db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run(COMPLETE_KEY, runStartedAt);
    db.prepare('DELETE FROM site_meta WHERE key=?').run(RESUME_KEY);
    db.prepare('DELETE FROM site_meta WHERE key=?').run('mirror_progress');
  }
  return stats;
};
