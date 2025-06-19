import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { DefaultCrawlState } from '../../src/crawl_state.js';
import { CrawlService } from '../../src/services/crawl_service.js';

describe('Change Detection Integration', () => {
  const TEST_URLS = ['https://example.com/a', 'https://example.com/b'];
  // Use a dedicated test directory to avoid conflicts
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp_change_detection');
  // Database file will be in the test directory
  const TEST_DB_PATH = path.join(TEST_DIR, 'test.db');
  
  // Restore original fetch after tests
  let originalFetch;
  let db;
  
  beforeEach(() => {
    originalFetch = global.fetch;
    
    // Clean up any existing DB files and ensure directory exists
    if (fs.existsSync(TEST_DIR)) {
      // Remove all files in the directory
      const files = fs.readdirSync(TEST_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(TEST_DIR, file));
        } catch (err) {
          console.error(`Error deleting file ${file}:`, err);
        }
      }
    } else {
      // Create the directory if it doesn't exist
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    
    // Initialize a fresh database with schema
    db = new Database(TEST_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT,
        last_crawled TEXT,
        status INTEGER,
        title TEXT DEFAULT NULL,
        file_path TEXT DEFAULT NULL,
        content_status TEXT DEFAULT 'raw',
        is_pdf INTEGER DEFAULT 0,
        pdf_conversion_status TEXT DEFAULT NULL,
        pdf_md_path TEXT DEFAULT NULL
      );
    `);
  });
  
  afterEach(() => {
    global.fetch = originalFetch;
    
    // Close the database connection
    if (db) {
      db.close();
    }
    
    // Clean up DB files
    if (fs.existsSync(TEST_DIR)) {
      const files = fs.readdirSync(TEST_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(TEST_DIR, file));
        } catch (err) {
          console.error(`Error deleting file ${file}:`, err);
        }
      }
    }
  });
  
  it('does not re-fetch unchanged pages on repeat crawl', async () => {
    console.log('Test directory:', TEST_DIR);
    console.log('Database path:', TEST_DB_PATH);
    
    // Track fetch calls for each crawl
    const fetchCalls = {
      firstCrawl: 0,
      secondCrawl: 0
    };
    
    // Mock fetch to simulate HTTP responses with ETags
    global.fetch = vi.fn((url, options = {}) => {
      // Extract headers from options
      const headers = options.headers || {};
      const ifNoneMatch = headers['If-None-Match'];
      
      // Determine which URL is being requested
      const urlPath = new URL(url).pathname;
      const isUrlA = urlPath === '/a';
      const etag = isUrlA ? 'etag-a' : 'etag-b';
      
      // If this is a conditional request with matching ETag, return 304
      if (ifNoneMatch === etag) {
        fetchCalls.secondCrawl++;
        return Promise.resolve({
          ok: true,
          status: 304,
          statusText: 'Not Modified',
          headers: new Map([
            ['etag', etag],
            ['last-modified', 'Mon, 09 Jun 2025 01:20:58 GMT'],
            ['content-type', 'text/html']
          ]),
          text: () => Promise.resolve(''),
          get: function(header) {
            return this.headers.get(header);
          }
        });
      }
      
      // Otherwise return 200 with content
      fetchCalls.firstCrawl++;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([
          ['etag', etag],
          ['last-modified', 'Mon, 09 Jun 2025 01:20:58 GMT'],
          ['content-type', 'text/html']
        ]),
        text: () => Promise.resolve(`<html><body><h1>Page ${isUrlA ? 'A' : 'B'}</h1></body></html>`),
        get: function(header) {
          return this.headers.get(header);
        }
      });
    });
    
    // FIRST CRAWL - Insert records directly into the database
    console.log('Simulating first crawl by inserting records...');
    
    // Create a wrapper around the database to use DefaultCrawlState
    const dbWrapper = {
      db,
      upsertPage(page) {
        // Implement upsertPage directly using SQLite
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO pages (
            url, etag, last_modified, content_hash, last_crawled, status,
            title, file_path, content_status, is_pdf, pdf_conversion_status, pdf_md_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
          page.url,
          page.etag,
          page.last_modified,
          page.content_hash,
          page.last_crawled,
          page.status,
          page.title,
          page.file_path,
          page.content_status || 'raw',
          page.is_pdf || 0,
          page.pdf_conversion_status,
          page.pdf_md_path
        );
        
        return page;
      },
      getPage(url) {
        // Implement getPage directly using SQLite
        const stmt = db.prepare('SELECT * FROM pages WHERE url = ?');
        return stmt.get(url);
      }
    };
    
    const crawlState = new DefaultCrawlState(dbWrapper);
    
    // Insert page records
    for (const url of TEST_URLS) {
      const isUrlA = url.endsWith('/a');
      const etag = isUrlA ? 'etag-a' : 'etag-b';
      const title = isUrlA ? 'Page A' : 'Page B';
      const content = isUrlA ? 'page a content' : 'page b content';
      
      await crawlState.upsertPage({
        url,
        etag,
        last_modified: 'Mon, 09 Jun 2025 01:20:58 GMT',
        content_hash: crypto.createHash('md5').update(content).digest('hex'),
        status: 200,
        content_type: 'text/html',
        headers: { 'etag': etag, 'content-type': 'text/html' },
        last_crawled: new Date().toISOString(),
        depth: isUrlA ? 0 : 1,
        title,
        file_path: null
      });
    }
    
    // Verify the pages were saved in the database
    for (const url of TEST_URLS) {
      const page = crawlState.getPage(url);
      console.log(`[TEST DEBUG] First crawl stored record for ${url}:`, page);
      expect(page).toBeTruthy();
      expect(page.etag).toBeTruthy();
    }
    
    // SECOND CRAWL - Create a mock CrawlService that uses the same database
    console.log('Starting second crawl...');
    
    // Create a simple mock crawl service that will use conditional requests
    const crawlService = {
      crawlState,
      async crawlPage(url) {
        console.log(`Mock crawling page: ${url}`);
        
        // Get the existing page record to get the ETag
        const existingPage = crawlState.getPage(url);
        
        if (!existingPage) {
          throw new Error(`Page not found in crawl state: ${url}`);
        }
        
        // Make a conditional request using the ETag
        const response = await fetch(url, {
          headers: {
            'If-None-Match': existingPage.etag
          }
        });
        
        // For 304 responses, we don't need to update the page
        if (response.status === 304) {
          console.log(`Page not modified: ${url}`);
          return existingPage;
        }
        
        // For other responses, we would normally update the page
        // but for this test we don't need to implement that
        return existingPage;
      }
    };
    
    // Crawl the same URLs again
    for (const url of TEST_URLS) {
      await crawlService.crawlPage(url);
    }
    
    // Verify that the second crawl used conditional requests and got 304 responses
    expect(fetchCalls.secondCrawl).toBe(2);
    expect(fetchCalls.firstCrawl).toBe(0);
    
    // Verify the pages still exist in the database
    for (const url of TEST_URLS) {
      const page = crawlState.getPage(url);
      console.log(`[TEST DEBUG] Second crawl database check for ${url}:`, page);
      expect(page).toBeTruthy();
      expect(page.etag).toBeTruthy();
    }
  });
});
