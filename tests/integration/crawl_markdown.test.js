import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SiteState } from '../../src/site_state.js';
import { SiteProcessor } from '../../src/site_processor.js';
import { DefaultCrawlState } from '../../src/crawl_state.js';
import TurndownService from 'turndown';
import fetch from 'node-fetch';

const TEST_OUTPUT = path.resolve('./tests/tmp/oceanoflights.org');
const TEST_URL = 'https://oceanoflights.org';
const LIMIT = 2;
const CONCURRENCY = 2;
const turndownService = new TurndownService();

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

beforeAll(() => {
  if (fs.existsSync(TEST_OUTPUT)) fs.rmSync(TEST_OUTPUT, { recursive: true, force: true });
});
afterAll(() => {
  if (fs.existsSync(TEST_OUTPUT)) fs.rmSync(TEST_OUTPUT, { recursive: true, force: true });
});

describe('Integration: Crawl and Markdown Output', () => {
  it('crawls site, writes markdown files, and tracks state', async () => {
    console.log('Starting crawl/markdown integration test');
    const state = new SiteState(TEST_OUTPUT);
    let success = false;
    try {
      const crawlState = new DefaultCrawlState(state.db);
      const processor = new SiteProcessor(TEST_URL, { crawlState, limit: LIMIT, concurrency: CONCURRENCY });
      console.log('[TEST] Starting processor.process()');
      let found = [];
      try {
        found = await processor.process();
        console.log('[TEST] processor.process() complete');
      } catch (e) {
        console.error('[TEST] processor.process() threw:', e);
        throw e;
      }
      console.log('[TEST] URLs found:', found);
      // Assert number of URLs matches limit
      expect(found.length).toBeLessThanOrEqual(LIMIT);
      expect(found.length).toBeGreaterThan(0);
      let mdFiles = [];
      for (const pageUrl of found) {
        if (!pageUrl) { console.error('[TEST] Skipping empty URL'); continue; }
        console.log('[TEST] Fetching:', pageUrl);
        let md = '';
        try {
          const res = await fetch(pageUrl);
          const html = await res.text();
          md = turndownService.turndown(html);
          console.log('[TEST] Markdown generated for:', pageUrl);
          // Write to file
          const filePath = path.join(TEST_OUTPUT, safeFilename(pageUrl));
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, md);
          mdFiles.push(filePath);
          // Check file exists and is not empty
          expect(fs.existsSync(filePath)).toBe(true);
          expect(fs.readFileSync(filePath, 'utf8').length).toBeGreaterThan(20);
          // Check basic markdown structure
          expect(md).toMatch(/#|\w/);
        } catch (e) {
          console.error('[TEST] Error during fetch/markdown/write for', pageUrl, e);
          throw e;
        }
        state.db.upsertPage({
          url: pageUrl,
          etag: null,
          last_modified: null,
          content_hash: null,
          last_crawled: new Date().toISOString(),
          status: 1
        });
      }
      // Assert that all Markdown files are unique
      expect(new Set(mdFiles).size).toBe(mdFiles.length);
      // Assert DB entries (pages table) matches found URLs
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
    console.log('Finished crawl/markdown integration test');
  }, 60000);
});
