import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDB } from '../../src/db.js';
import { SiteProcessor } from '../../src/site_processor.js';
import { DefaultCrawlState } from '../../src/crawl_state.js';

/**
 * Test suite for crawl database persistence and efficient re-crawling
 * Ensures pages are saved to database and re-crawls don't fetch unchanged content
 */
describe('Crawl Database Persistence', () => {
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp', 'db-persistence');
  const OUTPUT_DIR = path.join(TEST_DIR, 'output');
  const DB_PATH = path.join(OUTPUT_DIR, '.site2rag', 'crawl.db');
  
  let originalFetch;
  let mockResponses;
  let fetchCallCount;
  
  beforeEach(() => {
    originalFetch = global.fetch;
    fetchCallCount = 0;
    
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    // Mock responses for testing
    mockResponses = {
      'https://example.com': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"abc123"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
        },
        body: '<html><head><title>Home</title></head><body><h1>Home Page</h1><a href="/page1">Page 1</a></body></html>'
      },
      'https://example.com/page1': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"def456"',
          'last-modified': 'Wed, 21 Oct 2015 07:30:00 GMT'
        },
        body: '<html><head><title>Page 1</title></head><body><h1>Page 1 Content</h1></body></html>'
      },
      'https://example.com/robots.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nAllow: /'
      }
    };
    
    // Mock fetch with request tracking
    global.fetch = vi.fn().mockImplementation(async (url, options = {}) => {
      fetchCallCount++;
      console.log(`[MOCK FETCH ${fetchCallCount}] ${options.method || 'GET'} ${url}`);
      
      // Handle conditional requests (304 responses)
      const headers = options.headers || {};
      const mockResponse = mockResponses[url];
      
      if (mockResponse && headers['If-None-Match'] === mockResponse.headers.etag) {
        console.log(`[MOCK FETCH] 304 Not Modified for ${url} (ETag match)`);
        return new Response(null, { 
          status: 304, 
          headers: mockResponse.headers 
        });
      }
      
      if (mockResponse && headers['If-Modified-Since'] === mockResponse.headers['last-modified']) {
        console.log(`[MOCK FETCH] 304 Not Modified for ${url} (Last-Modified match)`);
        return new Response(null, { 
          status: 304, 
          headers: mockResponse.headers 
        });
      }
      
      // Return mock response or 404
      if (mockResponse) {
        console.log(`[MOCK FETCH] 200 OK for ${url}`);
        return new Response(mockResponse.body, {
          status: mockResponse.status,
          headers: mockResponse.headers
        });
      }
      
      console.log(`[MOCK FETCH] 404 Not Found for ${url}`);
      return new Response('Not Found', { status: 404 });
    });
  });
  
  afterEach(() => {
    global.fetch = originalFetch;
    
    // Clean up test directory after each test
    if (fs.existsSync(TEST_DIR)) {
      try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      } catch (err) {
        console.warn('Error cleaning up test directory:', err.message);
      }
    }
  });
  
  it('should save pages to database during first crawl', async () => {
    // Create database and crawl state (same pattern as CLI)
    const db = getDB(DB_PATH);
    const crawlState = new DefaultCrawlState(db);
    
    // Create site processor with crawlState passed in options
    const processor = new SiteProcessor('https://example.com', {
      crawlState: crawlState,
      outputDir: OUTPUT_DIR,
      limit: 2,
      debug: true
    });
    
    // Run first crawl
    const results = await processor.process();
    
    // Verify crawl results
    expect(results).toHaveLength(2);
    expect(results).toContain('https://example.com');
    expect(results).toContain('https://example.com/page1');
    
    // Verify database has pages saved
    const pageCount = db.db.prepare('SELECT COUNT(*) as count FROM pages').get();
    expect(pageCount.count).toBe(2);
    
    // Verify page data is correct
    const homePage = db.getPage('https://example.com');
    expect(homePage).toBeTruthy();
    expect(homePage.etag).toBe('"abc123"');
    expect(homePage.last_modified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(homePage.content_hash).toBeTruthy();
    expect(homePage.status).toBe(200);
    
    const page1 = db.getPage('https://example.com/page1');
    expect(page1).toBeTruthy();
    expect(page1.etag).toBe('"def456"');
    expect(page1.last_modified).toBe('Wed, 21 Oct 2015 07:30:00 GMT');
    expect(page1.content_hash).toBeTruthy();
    expect(page1.status).toBe(200);
    
    // Finalize session to persist changes
    db.finalizeSession();
    
    // Verify database file exists after finalization
    expect(fs.existsSync(DB_PATH)).toBe(true);
    
    db.close();
  });
  
  it('should detect existing pages and use conditional requests on re-crawl', async () => {
    // First crawl - save initial data
    let db = getDB(DB_PATH);
    let crawlState = new DefaultCrawlState(db);
    
    const processor1 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 2,
      debug: true
    });
    
    await processor1.process();
    db.finalizeSession();
    db.close();
    
    // Reset fetch call counter
    const firstCrawlFetchCount = fetchCallCount;
    fetchCallCount = 0;
    
    // Second crawl - should detect existing pages
    db = getDB(DB_PATH);
    crawlState = new DefaultCrawlState(db);
    
    const processor2 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 2,
      debug: true
    });
    
    await processor2.process();
    
    // Verify conditional requests were made (fewer fetches)
    expect(fetchCallCount).toBeGreaterThan(0);
    
    // Verify we made conditional requests (look for If-None-Match headers)
    const fetchCalls = global.fetch.mock.calls;
    const conditionalRequests = fetchCalls.filter(call => {
      const headers = call[1]?.headers || {};
      return headers['If-None-Match'] || headers['If-Modified-Since'];
    });
    
    expect(conditionalRequests.length).toBeGreaterThan(0);
    
    // Verify database still has the same pages
    const pageCount = db.db.prepare('SELECT COUNT(*) as count FROM pages').get();
    expect(pageCount.count).toBe(2);
    
    db.finalizeSession();
    db.close();
  });
  
  it('should handle 304 Not Modified responses efficiently', async () => {
    // First crawl
    let db = getDB(DB_PATH);
    let crawlState = new DefaultCrawlState(db);
    
    const processor1 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 2,
      debug: true
    });
    
    await processor1.process();
    db.finalizeSession();
    db.close();
    
    // Reset fetch counter
    fetchCallCount = 0;
    
    // Second crawl - should get 304 responses
    db = getDB(DB_PATH);
    crawlState = new DefaultCrawlState(db);
    
    const processor2 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 2,
      debug: true
    });
    
    await processor2.process();
    
    // Verify 304 responses were handled
    const fetchCalls = global.fetch.mock.calls;
    const conditionalCalls = fetchCalls.filter(call => {
      const headers = call[1]?.headers || {};
      return headers['If-None-Match'] || headers['If-Modified-Since'];
    });
    
    expect(conditionalCalls.length).toBeGreaterThan(0);
    
    // Verify pages are still in database with updated last_crawled
    const homePage = db.getPage('https://example.com');
    expect(homePage).toBeTruthy();
    expect(homePage.etag).toBe('"abc123"'); // ETag unchanged
    expect(homePage.content_hash).toBeTruthy(); // Hash preserved
    
    db.finalizeSession();
    db.close();
  });
  
  it('should update content hash when page content changes', async () => {
    // First crawl
    let db = getDB(DB_PATH);
    let crawlState = new DefaultCrawlState(db);
    
    const processor1 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 1,
      debug: true
    });
    
    await processor1.process();
    
    const originalPage = db.getPage('https://example.com');
    const originalHash = originalPage.content_hash;
    
    db.finalizeSession();
    db.close();
    
    // Change the content for second crawl
    mockResponses['https://example.com'].body = '<html><head><title>Home</title></head><body><h1>Updated Home Page</h1></body></html>';
    mockResponses['https://example.com'].headers.etag = '"xyz789"'; // New ETag
    
    // Second crawl with changed content
    db = getDB(DB_PATH);
    crawlState = new DefaultCrawlState(db);
    
    const processor2 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 1,
      debug: true
    });
    
    await processor2.process();
    
    // Verify page was updated with new hash
    const updatedPage = db.getPage('https://example.com');
    expect(updatedPage.content_hash).toBeTruthy();
    expect(updatedPage.content_hash).not.toBe(originalHash);
    expect(updatedPage.etag).toBe('"xyz789"');
    
    db.finalizeSession();
    db.close();
  });
});