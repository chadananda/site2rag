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
const inScope = (url, siteConfig, seedHost) => {
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
const parseRobots = (text, ua) => {
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
const extractLinks = ($, baseUrl) => {
  const links = [];
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;
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
  const timeout = (siteConfig.timeout_seconds ?? 1800) * 1000;
  const compiled = compileRules(siteConfig.rules);
  const seedHost = new URL(seedUrl).hostname;
  // Resume support: if a prior run was interrupted, continue from its start time
  const RESUME_KEY = 'mirror_run_started_at';
  const savedStart = db.prepare('SELECT value FROM site_meta WHERE key=?').get(RESUME_KEY)?.value;
  const isResume = savedStart && (Date.now() - new Date(savedStart).getTime()) < timeout;
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
  // Build queue: sitemap priority URLs first, then seed URL
  const toVisit = [
    ...priorityQueue.filter(u => inScope(u, siteConfig, seedHost)).map(u => ({ url: u, depth: 0, fromSitemap: true })),
    { url: seedUrl, depth: 0, fromSitemap: false }
  ];
  // Re-check existing pages only if stale (not seen within check_every_days)
  const staleMs = (siteConfig.check_every_days ?? 3) * 86400000;
  const staleCutoff = new Date(Date.now() - staleMs).toISOString();
  const existingPages = db.prepare('SELECT url, depth FROM pages WHERE gone=0 AND last_seen_at < ?').all(staleCutoff);
  for (const p of existingPages) {
    if (!priorityQueue.includes(p.url) && inScope(p.url, siteConfig, seedHost)) {
      toVisit.push({ url: p.url, depth: p.depth || 0, fromSitemap: false });
    }
  }
  const stats = { checked: 0, new_pages: 0, changed: 0, gone: 0 };
  // Use live page count as total estimate — toVisit grows as links are discovered
  const totalToCheck = db.prepare('SELECT COUNT(*) as n FROM pages WHERE gone=0').get().n || toVisit.length;
  const upsertMeta = db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)');
  const started = Date.now();
  while (toVisit.length > 0 && (Date.now() - started) < timeout) {
    const { url, depth, fromSitemap } = toVisit.shift();
    let canonical;
    try { canonical = stripQueryParams(compiled, url); new URL(canonical); } catch {
      console.warn(`[mirror] skipping malformed URL: ${url}`); continue;
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (depth > maxDepth) continue;
    if (siteConfig.respect_robots_txt && !isRobotsAllowed(canonical)) continue;
    const followOverride = applyFollowOverride(compiled, canonical);
    if (followOverride === false) continue;
    // Conditional GET
    const existing = db.prepare('SELECT * FROM pages WHERE url=?').get(canonical);
    const headers = { 'User-Agent': ua };
    if (existing?.etag) headers['If-None-Match'] = existing.etag;
    if (existing?.last_modified) headers['If-Modified-Since'] = existing.last_modified;
    let res;
    try {
      res = await fetch(canonical, { headers, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    } catch (err) {
      console.error(`[mirror] fetch error ${canonical}: ${err.message}`);
      continue;
    }
    stats.checked++;
    // Write live progress every 100 pages so the API can show crawl status
    if (stats.checked % 100 === 0) {
      upsertMeta.run('mirror_progress', JSON.stringify({ checked: stats.checked, total: totalToCheck, new_pages: stats.new_pages, changed: stats.changed, started_at: runStartedAt }));
    }
    if (res.status === 404 || res.status === 410) {
      if (existing) db.prepare('UPDATE pages SET gone=1, gone_since=COALESCE(gone_since, ?) WHERE url=?').run(new Date().toISOString(), canonical);
      continue;
    }
    if (res.status === 304) {
      db.prepare('UPDATE pages SET last_seen_at=? WHERE url=?').run(new Date().toISOString(), canonical);
      continue;
    }
    if (!res.ok) continue;
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (bodyErr) {
      // Connection dropped / reset while reading body (undici "terminated", ECONNRESET, etc.)
      console.warn(`[mirror] body read error ${canonical}: ${bodyErr.message}`);
      continue;
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
          // A file exists where we need a directory: use a hash-named sibling instead
          const ext = extname(mirrorPath);
          const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
          const dir = dirname(dirname(mirrorPath));
          savedPath = join(dir, `${hash}${ext || '.html'}`);
          try {
            mkdirSync(dirname(savedPath), { recursive: true });
            writeFileSync(savedPath, buf);
            if (isNew) stats.new_pages++; else stats.changed++;
          } catch (e2) {
            console.warn(`[mirror] skipping ${canonical}: ${e2.message}`);
            continue;
          }
        } else {
          console.warn(`[mirror] skipping ${canonical}: ${writeErr.message}`);
          continue;
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
      url: canonical,
      path_slug: pathSlug,
      local_path: savedPath,
      from_sitemap: fromSitemap ? 1 : 0,
      etag: res.headers.get('etag'),
      last_modified: res.headers.get('last-modified'),
      content_hash: contentHash,
      mime_type: mimeType,
      status_code: res.status,
      depth,
      page_role: null,
      word_count_clean: null
    });
    // Extract links from HTML for crawl queue
    if (mimeType.includes('text/html') && depth < maxDepth) {
      const $ = cheerio.load(buf.toString('utf8'));
      const links = extractLinks($, canonical);
      for (const link of links) {
        if (!visited.has(link) && inScope(link, siteConfig, seedHost)) {
          toVisit.push({ url: link, depth: depth + 1, fromSitemap: false });
        }
      }
    }
  }
  const ranToCompletion = toVisit.length === 0;
  // Only mark gone if crawl completed fully — partial runs (timeout/crash) must not destroy live pages
  if (ranToCompletion) {
    stats.gone = markGoneUrls(db, runStartedAt);
    db.prepare('DELETE FROM site_meta WHERE key=?').run(RESUME_KEY);
    db.prepare('DELETE FROM site_meta WHERE key=?').run('mirror_progress');
  }
  return stats;
};
