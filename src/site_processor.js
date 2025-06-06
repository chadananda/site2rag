import fetch from 'node-fetch';
import { load } from 'cheerio';
import pLimit from 'p-limit';
import { URL } from 'url';
import robotsParser from 'robots-parser';
import TurndownService from 'turndown';
import fs from 'fs';

// Simple glob matcher for URL paths (supports * and **)
function matchGlob(pattern, path) {
  // Special case: '/**' matches everything including '/'
  if (pattern === '/**') return true;
  // Escape regex special chars except *
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  regex = regex.replace(/\*\*/g, '.*'); // ** => .*
  regex = regex.replace(/\*/g, '[^/]*'); // * => any except /
  return new RegExp('^' + regex + '$').test(path);
}

function safeFilename(url) {
  try {
    const { pathname } = new URL(url);
    let file = pathname.replace(/\/+$/, '') || 'index';
    file = file.replace(/[^a-zA-Z0-9-_\.]+/g, '_');
    if (!file.endsWith('.md')) file += '.md';
    return file;
  } catch {
    return 'page.md';
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove duplicate slashes, normalize trailing slash
    let pathname = u.pathname.replace(/\/+/g, '/');
    if (pathname !== '/' && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    u.pathname = pathname;
    u.hash = '';
    u.search = '';
    return u.href;
  } catch {
    return url;
  }
}

class CrawlLimitReached extends Error {
  constructor() {
    super('Crawl limit reached');
    this.name = 'CrawlLimitReached';
  }
}

export class SiteProcessor {
  constructor(startUrl, options = {}) {
    this.startUrl = /^https?:/.test(startUrl) ? startUrl : `https://${startUrl}`;
    this.limit = pLimit(Number(options.concurrency) || 4);
    this.maxPages = Number(options.limit) || 100;
    this.maxDepth = Number(options.maxDepth) || 3;
    this.visited = new Set();
    this.found = [];
    this.robots = null;
    this.domain = new URL(this.startUrl).origin;
    this.politeDelay = 1000; // ms between requests
    this.crawlState = options.crawlState || null; // Abstracted crawl state
    this.activeControllers = new Set(); // Track AbortControllers
    this.outputDir = options.outputDir || './output';
    this.turndownService = new TurndownService();
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    // For pattern-based crawling
    this.crawlPatterns = (options.config && options.config.crawlPatterns) || options.crawlPatterns || ["/*"];
  }

  async fetchRobotsTxt() {
    try {
      const robotsUrl = new URL('/robots.txt', this.domain).href;
      const res = await fetch(robotsUrl);
      if (!res.ok) return null;
      const txt = await res.text();
      this.robots = robotsParser(robotsUrl, txt);
    } catch (e) {
      this.robots = null;
    }
  }

  async canCrawl(url) {
    if (!this.robots) return true;
    return this.robots.isAllowed(url, '*');
  }

  async crawl(url, depth = 0) {
    if (!this.crawlState) throw new Error('SiteProcessor requires a crawlState instance for re-crawl detection and aborts.');
    if (this.found.length >= this.maxPages) {
      console.log(`[CRAWL] Throwing CrawlLimitReached at ${url}`);
      throw new CrawlLimitReached();
    }
    url = normalizeUrl(url);
    console.log(`[CRAWL] Enter: ${url} (depth ${depth}) visited=${this.visited.size} found=${this.found.length}`);
    console.log(`[CRAWL] Enter: ${url} (depth ${depth}) visited=${this.visited.size} found=${this.found.length}`);
    if (this.visited.has(url) || this.found.length >= this.maxPages || depth > this.maxDepth) {
      console.log(`[CRAWL] Skip: ${url} (already visited or limit/depth reached)`);
      return;
    }
    // Only crawl URLs matching a crawl pattern
    const urlObj = new URL(url);
    const pathOnly = urlObj.pathname;
    if (!this.crawlPatterns.some(pattern => matchGlob(pattern, pathOnly))) {
      console.log(`[CRAWL] Skip: ${url} (does not match crawlPatterns)`);
      return;
    }
    if (!(await this.canCrawl(url))) return;
    if (this.found.length >= this.maxPages) {
      console.log(`[CRAWL] Max pages reached (${this.maxPages}), stopping crawl.`);
      // Abort all active fetches
      for (const ctrl of this.activeControllers) ctrl.abort();
      this.activeControllers.clear();
      return;
    }
    try {
      // Check DB for previous crawl
      const prev = this.crawlState.getPage(url);
      const headers = {};
      if (prev) {
        if (prev.etag) headers['If-None-Match'] = prev.etag;
        if (prev.last_modified) headers['If-Modified-Since'] = prev.last_modified;
      }
      // AbortController for this fetch
      const controller = new AbortController();
      this.activeControllers.add(controller);
      console.log(`[CRAWL][DEBUG] About to fetch and write Markdown for: ${url}`);
      let res;
      try {
        res = await fetch(url, { redirect: 'follow', headers, signal: controller.signal });
      } finally {
        this.activeControllers.delete(controller);
      }
      if (res.status === 304) {
        // Not modified: update last_crawled, skip parsing
        console.log(`[CRAWL] Not modified: ${url}`);
        this.crawlState.upsertPage({
          url,
          etag: prev ? prev.etag : null,
          last_modified: prev ? prev.last_modified : null,
          content_hash: prev ? prev.content_hash : null,
          last_crawled: new Date().toISOString(),
          status: 1
        });
        return;
      }
      if (!res.ok) {
        console.log(`[CRAWL] Fetch failed: ${url} (${res.status})`);
        return;
      }
      const html = await res.text();
      // Mark as visited/found only after successful fetch
      this.visited.add(url);
      this.found.push(url);
      // Always convert HTML to Markdown and write to file for every fetched page
      try {
        const md = this.turndownService.turndown(html);
        const filePath = this.outputDir + '/' + safeFilename(url);
        fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, md);
        console.log(`[CRAWL] Markdown written: ${filePath}`);
      } catch (e) {
        console.error(`[CRAWL] Markdown conversion/writing failed for ${url}:`, e);
      }
      // (No early return here; Markdown is always written if fetch succeeds)
      if (depth < this.maxDepth) {
        console.log(`[CRAWL] Parsing links for: ${url}`);
        const $ = load(html);
        let links = Array.from(new Set(
          $('a[href]')
            .map((_, el) => $(el).attr('href'))
            .get()
            .filter(href => href && !href.startsWith('javascript:'))
            .map(href => {
              try {
                return normalizeUrl(new URL(href, url).href);
              } catch {
                return null;
              }
            })
            .filter(href => href && href.startsWith(this.domain) && !this.visited.has(href))
        ));
        // Only crawl up to remaining allowed pages
        const remaining = this.maxPages - this.found.length;
        if (links.length > remaining) links = links.slice(0, remaining);
        console.log(`[CRAWL] Discovered ${links.length} links on: ${url} (crawling up to ${remaining})`);
        if (this.found.length >= this.maxPages || links.length === 0) {
          console.log(`[CRAWL] Early return at ${url} (limit hit or no links)`);
          return;
        }
        try {
          await Promise.all(
            links.map(link =>
              this.found.length < this.maxPages
                ? this.limit(() => this.crawl(link, depth + 1))
                : Promise.resolve()
            )
          );
        } catch (err) {
          if (err instanceof CrawlLimitReached) {
            console.log(`[CRAWL] Caught CrawlLimitReached in children at ${url}`);
            throw err;
          } else {
            throw err;
          }
        }
      }
    } catch (e) {
      if (e instanceof CrawlLimitReached) {
        console.log(`[CRAWL] Caught CrawlLimitReached at ${url}`);
        throw e;
      }
      // Could add retry/backoff here
      console.log(`[CRAWL] Error in fetch for ${url}:`, e);
    }
    // Only delay after a real fetch (not early returns)
    console.log(`[CRAWL] Done: ${url} (depth ${depth}), delaying`);
    await new Promise(r => setTimeout(r, this.politeDelay));
    return;
  }

  async process() {
    this.visited = new Set();
    this.found = [];
    await this.fetchRobotsTxt();
    try {
      await this.crawl(this.startUrl, 0);
    } catch (err) {
      if (err instanceof CrawlLimitReached) {
        console.log('[PROCESS] CrawlLimitReached: finishing crawl');
      } else {
        throw err;
      }
    }
    return this.found;
  }
}

// For quick manual test
if (process.env.NODE_ENV !== 'test' && process.argv[1] && process.argv[1].endsWith('site_processor.js')) {
  const url = process.argv[2] || 'https://oceanoflights.org';
  const limit = process.argv[3] || 5;
  (async () => {
    const sp = new SiteProcessor(url, { limit });
    const found = await sp.process();
    console.log('Found URLs:', found);
  })();
}

export { matchGlob };
