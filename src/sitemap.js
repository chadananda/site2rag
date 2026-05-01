// Sitemap stage -- discovers, parses, diffs sitemaps; populates added/changed/removed queues.
import { fetch } from 'undici';
import { XMLParser } from 'fast-xml-parser';
import { upsertSitemap, markSitemapRemoved, getMeta, setMeta } from './db.js';
const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: '@_' };
const parser = new XMLParser(XML_OPTS);
/** Fetch text from URL, return null on error. */
const fetchText = async (url, ua) => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
};
/** Parse sitemap XML into array of { url, lastmod } entries. */
const parseSitemapXml = (xml) => {
  const parsed = parser.parse(xml);
  const sitemapIndex = parsed.sitemapindex?.sitemap;
  if (sitemapIndex) {
    const items = Array.isArray(sitemapIndex) ? sitemapIndex : [sitemapIndex];
    return { type: 'index', urls: items.map(s => ({ url: s.loc, lastmod: s.lastmod || null })) };
  }
  const urlset = parsed.urlset?.url;
  if (urlset) {
    const items = Array.isArray(urlset) ? urlset : [urlset];
    return { type: 'urlset', urls: items.map(u => ({ url: u.loc, lastmod: u.lastmod || null, hreflang: u['xhtml:link'] })) };
  }
  return { type: 'empty', urls: [] };
};
/** Discover sitemap URLs via robots.txt and common paths. */
const discoverSitemapUrls = async (siteUrl, ua) => {
  const base = new URL(siteUrl);
  const robotsUrl = `${base.origin}/robots.txt`;
  const robotsTxt = await fetchText(robotsUrl, ua);
  const fromRobots = robotsTxt ? [...robotsTxt.matchAll(/^Sitemap:\s*(.+)$/gim)].map(m => m[1].trim()) : [];
  const fallbacks = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap1.xml'].map(p => `${base.origin}${p}`);
  return [...new Set([...fromRobots, ...fallbacks])];
};
/** Recursively fetch and resolve a sitemap URL. Returns flat array of { url, lastmod, source_sitemap }. */
const resolveSitemap = async (sitemapUrl, ua, depth = 0) => {
  if (depth > 5) return [];
  const text = await fetchText(sitemapUrl, ua);
  if (!text) return [];
  const { type, urls } = parseSitemapXml(text);
  if (type === 'index') {
    const nested = await Promise.all(urls.map(u => resolveSitemap(u.url, ua, depth + 1)));
    return nested.flat();
  }
  return urls.map(u => ({ url: u.url, lastmod: u.lastmod, source_sitemap: sitemapUrl }));
};
/** Filter sitemap entries by include/exclude rules and optional language filter. */
const filterEntries = (entries, siteConfig) => {
  const { include = [], exclude = [], sitemap: sitemapCfg = {} } = siteConfig;
  const langs = sitemapCfg.include_languages || [];
  return entries.filter(e => {
    if (!e.url) return false;
    let path;
    try { path = new URL(e.url).pathname; } catch { return false; }
    if (exclude.some(p => path.startsWith(p))) return false;
    if (include.length && !include.some(p => path.startsWith(p))) return false;
    return true;
  });
};
/**
 * Run sitemap stage for a site. Discovers, parses, diffs sitemaps.
 * Returns { added, changed, removed, total, cached } URL arrays.
 */
export const runSitemap = async (db, siteConfig) => {
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const sitemapCfg = siteConfig.sitemap || {};
  const diffEveryHours = sitemapCfg.diff_every_hours ?? 24;
  const lastDiff = getMeta(db, 'last_sitemap_diff_at');
  const hoursSinceDiff = lastDiff ? (Date.now() - new Date(lastDiff).getTime()) / 3600000 : Infinity;
  // Skip diff if within window -- return empty delta (mirror will use existing DB state)
  if (hoursSinceDiff < diffEveryHours) {
    const existing = db.prepare('SELECT url FROM sitemaps WHERE removed=0').all().map(r => r.url);
    return { added: [], changed: [], removed: [], total: existing.length, cached: true };
  }
  const discovered = await discoverSitemapUrls(siteConfig.url, ua);
  const allEntries = [];
  for (const sitemapUrl of discovered) {
    const entries = await resolveSitemap(sitemapUrl, ua);
    allEntries.push(...entries);
  }
  const filtered = filterEntries(allEntries, siteConfig);
  // Diff against DB
  const seenUrls = [];
  const added = [], changed = [];
  for (const entry of filtered) {
    const existing = db.prepare('SELECT * FROM sitemaps WHERE url=?').get(entry.url);
    upsertSitemap(db, entry);
    seenUrls.push(entry.url);
    if (!existing || existing.removed) { added.push(entry.url); continue; }
    if (entry.lastmod && entry.lastmod !== existing.lastmod) changed.push(entry.url);
  }
  const removedCount = markSitemapRemoved(db, seenUrls);
  const removedUrls = db.prepare("SELECT url FROM sitemaps WHERE removed=1 AND removed_at >= datetime('now','-1 day')").all().map(r => r.url);
  setMeta(db, 'last_sitemap_diff_at', new Date().toISOString());
  return { added, changed, removed: removedUrls, total: filtered.length, cached: false };
};
/** Return true if site has a usable sitemap or fallback_to_crawl is enabled. */
export const hasSitemapOrFallback = async (siteConfig) => {
  if (!siteConfig.sitemap?.enabled) return siteConfig.sitemap?.fallback_to_crawl !== false;
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const discovered = await discoverSitemapUrls(siteConfig.url, ua);
  for (const u of discovered) {
    const text = await fetchText(u, ua);
    if (text) return true;
  }
  return siteConfig.sitemap?.fallback_to_crawl !== false;
};
