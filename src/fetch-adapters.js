// Pluggable fetch adapters for mirror.js. Each adapter: fetch(url, existingPage) → { status, buf, mimeType, etag, lastModified } | null (304/skip).
// Exports: getAdapter. Deps: undici, playwright-fetch
import { fetch } from 'undici';
import { createPlaywrightPool, isHtmlShell, isWorthRendering } from './playwright-fetch.js';

const FETCH_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [2000, 5000];

/** Fetch with automatic retry on timeout/network error. */
const fetchWithRetry = async (url, headers) => {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    try {
      return await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    } catch (err) {
      lastErr = err;
      if (!err.message?.includes('timeout') && !err.message?.includes('ECONNRESET') && !err.message?.includes('ECONNREFUSED')) throw err;
    }
  }
  throw lastErr;
};

/** Standard HTTP adapter with conditional GET and optional Playwright fallback. */
export const createHttpAdapter = async (siteConfig) => {
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const playwrightEnabled = siteConfig.playwright?.enabled !== false;
  const forcePlaywright = siteConfig.playwright?.force === true;
  const pool = playwrightEnabled ? await createPlaywrightPool(siteConfig.playwright ?? {}).catch(() => null) : null;
  let playwrightNeeded = forcePlaywright ? true : null;

  return {
    async fetch(url, existing) {
      const headers = { 'User-Agent': ua };
      if (existing?.etag) headers['If-None-Match'] = existing.etag;
      if (existing?.last_modified) headers['If-Modified-Since'] = existing.last_modified;

      const res = await fetchWithRetry(url, headers);
      if (res.status === 304) return { status: 304, buf: null, mimeType: null, etag: null, lastModified: null };
      if (!res.ok) return { status: res.status, buf: null, mimeType: null, etag: null, lastModified: null };

      let buf = Buffer.from(await res.arrayBuffer());
      let mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();

      if (mimeType.includes('text/html') && pool && playwrightNeeded !== false) {
        const staticHtml = buf.toString('utf8');
        const isShell = isHtmlShell(staticHtml);
        if (isShell || playwrightNeeded === true) {
          try {
            const rendered = await pool.render(url);
            if (playwrightNeeded === null) {
              if (isWorthRendering(staticHtml, rendered)) {
                playwrightNeeded = true;
                buf = Buffer.from(rendered, 'utf8');
                console.log(`[mirror] playwright mode enabled for ${siteConfig.domain}`);
              } else if (isShell) {
                buf = Buffer.from(rendered, 'utf8');
                console.log(`[mirror] shell page — using playwright despite low ratio for ${siteConfig.domain}`);
              } else {
                playwrightNeeded = false;
              }
            } else {
              buf = Buffer.from(rendered, 'utf8');
            }
          } catch (e) {
            console.warn(`[mirror] playwright render failed ${url}: ${e.message}`);
          }
        }
      }

      return {
        status: res.status,
        buf,
        mimeType,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    },
    async close() { if (pool) await pool.close(); },
  };
};

/** MediaWiki API adapter — fetches article HTML via api.php?action=parse, bypassing Cloudflare bot protection. */
export const createMediaWikiAdapter = (siteConfig) => {
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const origin = new URL(siteConfig.url).origin;
  const wikiPrefix = siteConfig.mediawiki?.wiki_path ?? '/wiki/';

  const titleFromUrl = (url) => {
    const path = new URL(url).pathname;
    if (!path.startsWith(wikiPrefix)) return null;
    return decodeURIComponent(path.slice(wikiPrefix.length)).replace(/_/g, ' ');
  };

  const buildHtml = (title, bodyHtml) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title></head>` +
    `<body><h1 id="firstHeading">${title.replace(/</g, '&lt;')}</h1>` +
    `<div id="mw-content-text"><div class="mw-parser-output">${bodyHtml}</div></div></body></html>`;

  return {
    async fetch(url, _existing) {
      const title = titleFromUrl(url);
      if (!title) {
        // Fall back to plain HTTP for non-article URLs (images, special pages, etc.)
        const res = await fetchWithRetry(url, { 'User-Agent': ua }).catch(() => null);
        if (!res?.ok) return { status: res?.status ?? 0, buf: null, mimeType: null, etag: null, lastModified: null };
        const buf = Buffer.from(await res.arrayBuffer());
        const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
        return { status: res.status, buf, mimeType, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
      }

      const apiUrl = `${origin}/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&disablelimitreport=1&format=json`;
      let res;
      try {
        res = await fetchWithRetry(apiUrl, { 'User-Agent': ua });
      } catch (err) {
        console.warn(`[mediawiki] fetch error ${url}: ${err.message}`);
        return { status: 0, buf: null, mimeType: null, etag: null, lastModified: null };
      }
      if (!res.ok) return { status: res.status, buf: null, mimeType: null, etag: null, lastModified: null };

      let data;
      try { data = await res.json(); } catch { return { status: 500, buf: null, mimeType: null, etag: null, lastModified: null }; }
      if (data.error) {
        // Missing page or invalid title
        const code = data.error.code;
        const status = code === 'missingtitle' || code === 'invalidtitle' ? 404 : 500;
        return { status, buf: null, mimeType: null, etag: null, lastModified: null };
      }

      const bodyHtml = data.parse?.text?.['*'] ?? '';
      const pageTitle = data.parse?.title ?? title;
      const html = buildHtml(pageTitle, bodyHtml);
      return { status: 200, buf: Buffer.from(html, 'utf8'), mimeType: 'text/html', etag: null, lastModified: null };
    },
    async close() {},
  };
};

/** Parse <item> blocks from RSS XML. Returns [{link, title, pubDate, author, description}]. */
const parseRssItems = (xml) => {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const s = m[1];
    const get = (tag) => {
      const r = s.match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>'));
      return r ? r[1].trim() : '';
    };
    const link = get('link');
    if (link) items.push({ link, title: get('title'), pubDate: get('pubDate'), author: get('dc:creator'), description: get('description') });
  }
  return items;
};

/**
 * WordPress RSS adapter — enumerates posts via /feed/?paged=N (bypasses Cloudflare),
 * then fetches full article content from Wayback Machine for each post.
 */
export const createWordPressRssAdapter = async (siteConfig) => {
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const origin = new URL(siteConfig.url).origin;
  const feedBase = `${origin}/feed/`;
  const ENUM_CONCURRENCY = siteConfig.wordpress_rss?.enum_concurrency ?? 2;
  const ENUM_RETRIES = siteConfig.wordpress_rss?.enum_retries ?? 4;
  const wmYear = siteConfig.wordpress_rss?.wayback_year ?? '2025';

  const postMap = new Map(); // normalized url → {title, pubDate, author, description}

  const fetchRssPage = async (p) => {
    try {
      const res = await fetch(`${feedBase}?paged=${p}`, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return [];
      return parseRssItems(await res.text());
    } catch { return []; }
  };

  // Binary search for last page (some pages may transiently return empty due to Cloudflare)
  let lo = 1, hi = 2000;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    const items = await fetchRssPage(mid);
    if (items.length > 0) lo = mid; else hi = mid;
  }
  const lastPage = lo;
  console.log(`[wordpress-rss] found ~${lastPage * 10} posts (${lastPage} pages) at ${origin}`);

  // Enumerate all pages in parallel batches with retry on empty
  const addItems = (items) => {
    for (const item of items) {
      postMap.set(item.link.replace(/\/$/, '') + '/', { title: item.title, pubDate: item.pubDate, author: item.author, description: item.description });
    }
  };
  const fetchRssPageWithRetry = async (p) => {
    for (let attempt = 0; attempt < ENUM_RETRIES; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500 * attempt));
      const items = await fetchRssPage(p);
      if (items.length > 0) return items;
    }
    return [];
  };
  for (let p = 1; p <= lastPage; p += ENUM_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(ENUM_CONCURRENCY, lastPage - p + 1) }, (_, i) => p + i);
    const results = await Promise.all(batch.map(fetchRssPageWithRetry));
    for (const items of results) addItems(items);
    if (postMap.size % 1000 === 0 && postMap.size > 0) {
      console.log(`[wordpress-rss] enumerated ${postMap.size} posts...`);
    }
  }
  console.log(`[wordpress-rss] ready: ${postMap.size} posts from ${origin}`);

  const normalize = (url) => url.split('?')[0].replace(/#.*/, '').replace(/\/$/, '') + '/';

  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const buildFallbackHtml = (url, { title, pubDate, author, description }) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>` +
    `<article><h1>${esc(title)}</h1>` +
    (author ? `<p class="author">By ${esc(author)}</p>` : '') +
    (pubDate ? `<time>${esc(pubDate)}</time>` : '') +
    `<div class="entry-content">${description}</div></article></body></html>`;

  const buildIndexHtml = () => {
    const links = [...postMap.keys()].map(u => `<li><a href="${u}">${esc(u)}</a></li>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(siteConfig.domain)}</title></head>` +
      `<body><ul>${links}</ul></body></html>`;
  };

  const fetchFromWayback = async (url) => {
    const wmUrl = `https://web.archive.org/web/${wmYear}id_/${url}`;
    try {
      const res = await fetch(wmUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch { return null; }
  };

  return {
    async fetch(url, _existing) {
      const canonical = normalize(url);
      if (canonical === normalize(siteConfig.url)) {
        return { status: 200, buf: Buffer.from(buildIndexHtml(), 'utf8'), mimeType: 'text/html', etag: null, lastModified: null };
      }
      const post = postMap.get(canonical);
      if (!post) return { status: 404, buf: null, mimeType: null, etag: null, lastModified: null };
      // Try Wayback Machine for full content; fall back to RSS description excerpt
      const wmBuf = await fetchFromWayback(url);
      if (wmBuf) return { status: 200, buf: wmBuf, mimeType: 'text/html', etag: null, lastModified: null };
      return { status: 200, buf: Buffer.from(buildFallbackHtml(url, post), 'utf8'), mimeType: 'text/html', etag: null, lastModified: null };
    },
    async close() {},
  };
};

/** Return the right adapter instance for a site config. */
export const getAdapter = async (siteConfig) => {
  const strategy = siteConfig.fetch_adapter ?? 'http';
  if (strategy === 'mediawiki_api') return createMediaWikiAdapter(siteConfig);
  if (strategy === 'wordpress_rss') return createWordPressRssAdapter(siteConfig);
  return createHttpAdapter(siteConfig);
};
