// Pure crawl utilities: URL→path mapping, scope checks, robots, link extraction. Exports: urlToMirrorPath, urlPathToSlug, inScope, parseRobots, extractLinks. Deps: config
import { createHash } from 'crypto';
import { extname, join } from 'path';
import { mirrorDir } from './config.js';

const hashQuery = (q) => createHash('sha256').update(q).digest('hex').slice(0, 4);

/** Convert URL to mirror file path. Query strings get a hash suffix; long names are truncated. */
export const urlToMirrorPath = (domain, urlStr) => {
  const u = new URL(urlStr);
  let p = u.pathname;
  if (p.endsWith('/') || !extname(p)) p = p.replace(/\/?$/, '/index.html');
  if (u.search) {
    const ext = extname(p);
    p = `${p.slice(0, -ext.length)}__${hashQuery(u.search)}${ext}`;
  }
  // Truncate to 200 bytes to avoid ENAMETOOLONG (Linux 255-byte limit)
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

/** Convert URL path to MD slug: /foo/bar.html → foo-bar */
export const urlPathToSlug = (urlPath) =>
  urlPath.replace(/^\//, '').replace(/\//g, '-').replace(/\.\w+$/, '') || 'index';

/** Return true if URL is within crawl scope (domain, include/exclude rules, depth). */
export const inScope = (url, siteConfig, seedHost) => {
  const { include = [], exclude = [], same_domain_only: sameDomain = true, allow_domains = [] } = siteConfig;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (sameDomain && u.hostname !== seedHost && !allow_domains.includes(u.hostname)) return false;
  const path = u.pathname;
  if (exclude.some(p => path.startsWith(p))) return false;
  if (include.length && !include.some(p => path.startsWith(p))) return false;
  return true;
};

/** Parse robots.txt, returning Set of disallowed path prefixes for our UA. */
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

/** Extract all followed links from HTML, returning absolute URL strings. */
export const extractLinks = ($, baseUrl) => {
  const links = [];
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('data:')) return;
      links.push(new URL(href, baseUrl).toString().split('#')[0]);
    } catch {}
  });
  return links;
};
