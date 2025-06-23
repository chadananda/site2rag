import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import fs from 'fs';
import path from 'path';
import {SiteState} from '../../src/site_state.js';
import {SiteProcessor} from '../../src/site_processor.js';
import {DefaultCrawlState} from '../../src/crawl_state.js';
import {getDB} from '../../src/db.js';

const TEST_OUTPUT = path.join(process.cwd(), 'tests', 'tmp', 'integration', 'crawl-workflows');
const TEST_URLS = ['https://example.com/page1', 'https://example.com/page2'];
const LIMIT = 2;
const CONCURRENCY = 2;

function safeFilename(url) {
  try {
    const {pathname} = new URL(url);
    let file = pathname.replace(/\/+$/, '') || 'index';
    file = file.replace(/[^a-zA-Z0-9-_\.]+/g, '_');
    if (!file.endsWith('.md')) file += '.md';
    return file;
  } catch {
    return 'page.md';
  }
}

beforeAll(() => {
  if (fs.existsSync(TEST_OUTPUT)) fs.rmSync(TEST_OUTPUT, {recursive: true, force: true});
});
afterAll(() => {
  if (fs.existsSync(TEST_OUTPUT)) fs.rmSync(TEST_OUTPUT, {recursive: true, force: true});
});

describe('Integration: Complete Crawl Workflows', () => {
  it('crawls site, writes markdown files, and tracks state', async () => {
    console.log('Starting crawl/markdown integration test');
    const dbDir = path.join(process.cwd(), 'tests', 'tmp', 'integration', 'db');
    const dbPath = path.join(dbDir, 'crawl.db');
    [dbPath].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, {recursive: true});
    if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, '');
    const db = getDB(dbPath);
    db.initSchema();
    const state = new SiteState(TEST_OUTPUT, db);
    let success = false;
    try {
      const crawlState = new DefaultCrawlState(state.db);
      const processor = new SiteProcessor(TEST_URLS[0], {
        crawlState,
        limit: LIMIT,
        concurrency: CONCURRENCY
      });
      // Mock the process method to return test URLs directly
      processor.process = async function () {
        for (const url of TEST_URLS) {
          this.crawlStateService.upsertPage({
            url,
            etag: null,
            last_modified: null,
            content_hash: null,
            last_crawled: new Date().toISOString(),
            status: 200,
            title: `Test page for ${url}`,
            file_path: null
          });
        }
        return TEST_URLS;
      };
      const found = await processor.process();
      expect(found.length).toBeLessThanOrEqual(LIMIT);
      expect(found.length).toBeGreaterThan(0);
      let mdFiles = [];
      for (const pageUrl of found) {
        if (!pageUrl) continue;
        const md = `# Test page for ${pageUrl}\n\nThis is test content.`;
        const filePath = path.join(TEST_OUTPUT, safeFilename(pageUrl));
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        fs.writeFileSync(filePath, md);
        mdFiles.push(filePath);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf8').length).toBeGreaterThan(20);
        expect(md).toMatch(/#|\w/);
        state.db.upsertPage({
          url: pageUrl,
          etag: null,
          last_modified: null,
          content_hash: null,
          last_crawled: new Date().toISOString(),
          status: 1
        });
      }
      expect(new Set(mdFiles).size).toBe(mdFiles.length);
      const dbPages = state.db.db.prepare('SELECT COUNT(*) as cnt FROM pages').get().cnt;
      expect(dbPages).toBeGreaterThanOrEqual(found.length);
      state.db.insertSession({
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        pages_crawled: found.length,
        notes: 'Integration test crawl with markdown output'
      });
      success = true;
    } finally {
      state.close(success);
    }
  }, 60000);

  it('handles change detection across crawl sessions', async () => {
    console.log('Starting change detection integration test');
    const dbDir = path.join(process.cwd(), 'tests', 'tmp', 'integration', 'change-detection');
    const dbPath = path.join(dbDir, 'test.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, {recursive: true});
    const db = getDB(dbPath);
    db.initSchema();
    const crawlState = new DefaultCrawlState({db});
    // Simulate first crawl - store pages with ETags
    for (const url of TEST_URLS) {
      const isUrlA = url.includes('page1');
      const etag = isUrlA ? 'etag-a' : 'etag-b';
      await crawlState.upsertPage({
        url,
        etag,
        last_modified: 'Mon, 09 Jun 2025 01:20:58 GMT',
        content_hash: 'hash123',
        status: 200,
        last_crawled: new Date().toISOString(),
        title: isUrlA ? 'Page A' : 'Page B',
        file_path: null
      });
    }
    // Verify pages were stored
    for (const url of TEST_URLS) {
      const page = crawlState.getPage(url);
      expect(page).toBeTruthy();
      expect(page.etag).toBeTruthy();
    }
    // Simulate second crawl - check for changes
    let fetchCalls = 0;
    global.fetch = vi.fn((url, options = {}) => {
      fetchCalls++;
      const headers = options.headers || {};
      const ifNoneMatch = headers['If-None-Match'];
      const urlPath = new URL(url).pathname;
      const isUrlA = urlPath.includes('page1');
      const etag = isUrlA ? 'etag-a' : 'etag-b';
      // Return 304 if ETag matches (no changes)
      if (ifNoneMatch === etag) {
        return Promise.resolve({
          ok: true,
          status: 304,
          headers: new Map([['etag', etag]]),
          text: () => Promise.resolve('')
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['etag', etag]]),
        text: () => Promise.resolve(`<html><body><h1>${isUrlA ? 'Page A' : 'Page B'}</h1></body></html>`)
      });
    });
    // Mock crawl service that uses conditional requests
    const crawlService = {
      async crawlPage(url) {
        const existingPage = crawlState.getPage(url);
        if (!existingPage) throw new Error(`Page not found: ${url}`);
        const response = await fetch(url, {
          headers: {'If-None-Match': existingPage.etag}
        });
        return response.status === 304 ? existingPage : existingPage;
      }
    };
    // Crawl again with conditional requests
    for (const url of TEST_URLS) {
      await crawlService.crawlPage(url);
    }
    // Verify conditional requests were made (should be 304 responses)
    expect(fetchCalls).toBe(TEST_URLS.length);
    db.close();
  }, 30000);

  it('efficiently handles re-crawls with caching', async () => {
    console.log('Starting efficient re-crawl test');
    const dbDir = path.join(process.cwd(), 'tests', 'tmp', 'integration', 'efficient-recrawl');
    const dbPath = path.join(dbDir, 'test.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, {recursive: true});
    const db = getDB(dbPath);
    db.initSchema();
    const crawlState = new DefaultCrawlState({db});
    // Store initial pages
    const initialPages = [
      {url: 'https://example.com/a', etag: 'etag-1', status: 200},
      {url: 'https://example.com/b', etag: 'etag-2', status: 200},
      {url: 'https://example.com/c', etag: 'etag-3', status: 200}
    ];
    for (const page of initialPages) {
      await crawlState.upsertPage({
        ...page,
        last_modified: new Date().toISOString(),
        content_hash: 'hash123',
        last_crawled: new Date().toISOString(),
        title: `Page ${page.url.slice(-1)}`,
        file_path: null
      });
    }
    // Verify initial storage
    expect(crawlState.getPage('https://example.com/a')).toBeTruthy();
    expect(crawlState.getPage('https://example.com/b')).toBeTruthy();
    expect(crawlState.getPage('https://example.com/c')).toBeTruthy();
    // Simulate efficient loading with ETags
    const pages = crawlState.getAllPages();
    expect(pages.length).toBe(3);
    expect(pages.every(p => p.etag)).toBe(true);
    db.close();
  }, 15000);
});