import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDB } from '../../src/db.js';
import { SiteProcessor } from '../../src/site_processor.js';
import { DefaultCrawlState } from '../../src/crawl_state.js';

/**
 * Integration test demonstrating efficient subsequent loading
 * Measures and verifies that re-crawls are significantly faster than initial crawls
 * by skipping unchanged content and using conditional HTTP requests
 */
describe('Efficient Subsequent Loading', () => {
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp', 'integration-efficient-loading');
  const OUTPUT_DIR = path.join(TEST_DIR, 'output');
  const DB_PATH = path.join(OUTPUT_DIR, '.site2rag', 'crawl.db');
  
  let originalFetch;
  let mockResponses;
  let fetchCallCount;
  let fetchTimes;
  let processingTimes;
  
  beforeEach(() => {
    originalFetch = global.fetch;
    fetchCallCount = 0;
    fetchTimes = [];
    processingTimes = [];
    
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    // Create a realistic set of mock responses for testing
    mockResponses = {
      'https://example.com': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"home-v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
        },
        body: '<html><head><title>Home</title></head><body><h1>Welcome</h1><p>This is a large page with lots of content that takes time to process.</p><a href="/page1">Page 1</a><a href="/page2">Page 2</a><a href="/page3">Page 3</a></body></html>'
      },
      'https://example.com/page1': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"page1-v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:30:00 GMT'
        },
        body: '<html><head><title>Page 1</title></head><body><h1>Page 1</h1><p>Extensive content on page 1 with detailed information that requires processing time.</p></body></html>'
      },
      'https://example.com/page2': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"page2-v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:32:00 GMT'
        },
        body: '<html><head><title>Page 2</title></head><body><h1>Page 2</h1><p>Complex content on page 2 with multiple sections and detailed text.</p></body></html>'
      },
      'https://example.com/page3': {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"page3-v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:34:00 GMT'
        },
        body: '<html><head><title>Page 3</title></head><body><h1>Page 3</h1><p>Comprehensive content on page 3 with extensive information processing requirements.</p></body></html>'
      },
      'https://example.com/robots.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\\nAllow: /'
      }
    };
    
    // Mock fetch with timing and conditional request handling
    global.fetch = vi.fn().mockImplementation(async (url, options = {}) => {
      const startTime = Date.now();
      fetchCallCount++;
      
      console.log(`[FETCH ${fetchCallCount}] ${options.method || 'GET'} ${url}`);
      
      // Handle conditional requests (304 responses)
      const headers = options.headers || {};
      const mockResponse = mockResponses[url];
      
      if (mockResponse) {
        // Check for If-None-Match (ETag-based conditional request)
        if (headers['If-None-Match'] === mockResponse.headers.etag) {
          console.log(`[FETCH] 304 Not Modified for ${url} (ETag: ${mockResponse.headers.etag})`);
          const endTime = Date.now();
          fetchTimes.push({ url, time: endTime - startTime, type: '304_etag' });
          return new Response(null, { 
            status: 304, 
            headers: mockResponse.headers 
          });
        }
        
        // Check for If-Modified-Since (Last-Modified-based conditional request)
        if (headers['If-Modified-Since'] === mockResponse.headers['last-modified']) {
          console.log(`[FETCH] 304 Not Modified for ${url} (Last-Modified: ${mockResponse.headers['last-modified']})`);
          const endTime = Date.now();
          fetchTimes.push({ url, time: endTime - startTime, type: '304_lastmod' });
          return new Response(null, { 
            status: 304, 
            headers: mockResponse.headers 
          });
        }
        
        // Simulate network delay for full downloads
        await new Promise(resolve => setTimeout(resolve, 50));
        
        console.log(`[FETCH] 200 OK for ${url} (${mockResponse.body.length} bytes)`);
        const endTime = Date.now();
        fetchTimes.push({ url, time: endTime - startTime, type: '200_full' });
        return new Response(mockResponse.body, {
          status: mockResponse.status,
          headers: mockResponse.headers
        });
      }
      
      console.log(`[FETCH] 404 Not Found for ${url}`);
      const endTime = Date.now();
      fetchTimes.push({ url, time: endTime - startTime, type: '404' });
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
  
  it('should demonstrate significant efficiency gains on subsequent crawls', async () => {
    console.log('\\n=== EFFICIENCY TEST: Initial vs Subsequent Crawl ===\\n');
    
    // === FIRST CRAWL (Initial) ===
    console.log('🚀 Starting INITIAL crawl...');
    const initialStartTime = Date.now();
    
    let db = getDB(DB_PATH);
    let crawlState = new DefaultCrawlState(db);
    
    const processor1 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 4,
      debug: false, // Reduce noise
      test: false   // No test logging for cleaner output
    });
    
    const initialResults = await processor1.process();
    const initialEndTime = Date.now();
    const initialDuration = initialEndTime - initialStartTime;
    const initialFetchCount = fetchCallCount;
    const initialFetchTimes = [...fetchTimes];
    
    db.finalizeSession();
    db.close();
    
    console.log(`✅ Initial crawl completed:`);
    console.log(`   Duration: ${initialDuration}ms`);
    console.log(`   Pages: ${initialResults.length}`);
    console.log(`   HTTP requests: ${initialFetchCount}`);
    console.log(`   Full downloads: ${initialFetchTimes.filter(f => f.type === '200_full').length}`);
    
    // Verify initial crawl worked correctly
    expect(initialResults).toHaveLength(4);
    expect(initialFetchCount).toBeGreaterThan(0);
    expect(initialFetchTimes.filter(f => f.type === '200_full')).toHaveLength(4); // All full downloads
    
    // Reset counters for second crawl
    fetchCallCount = 0;
    fetchTimes = [];
    
    // === SECOND CRAWL (Subsequent/Re-crawl) ===
    console.log('\\n🔄 Starting SUBSEQUENT crawl (same content)...');
    const subsequentStartTime = Date.now();
    
    db = getDB(DB_PATH);
    crawlState = new DefaultCrawlState(db);
    
    const processor2 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 4,
      debug: false, // Reduce noise  
      test: true    // Enable test logging to see skip decisions
    });
    
    const subsequentResults = await processor2.process();
    const subsequentEndTime = Date.now();
    const subsequentDuration = subsequentEndTime - subsequentStartTime;
    const subsequentFetchCount = fetchCallCount;
    const subsequentFetchTimes = [...fetchTimes];
    
    db.finalizeSession();
    db.close();
    
    console.log(`\\n✅ Subsequent crawl completed:`);
    console.log(`   Duration: ${subsequentDuration}ms`);
    console.log(`   Pages: ${subsequentResults.length}`);
    console.log(`   HTTP requests: ${subsequentFetchCount}`);
    console.log(`   304 responses: ${subsequentFetchTimes.filter(f => f.type.startsWith('304')).length}`);
    console.log(`   Full downloads: ${subsequentFetchTimes.filter(f => f.type === '200_full').length}`);
    
    // === EFFICIENCY ANALYSIS ===
    const timeSavings = initialDuration - subsequentDuration;
    const timeSavingsPercent = ((timeSavings / initialDuration) * 100).toFixed(1);
    const requestReduction = initialFetchCount - subsequentFetchCount;
    const requestReductionPercent = ((requestReduction / initialFetchCount) * 100).toFixed(1);
    
    console.log(`\\n📊 EFFICIENCY GAINS:`);
    console.log(`   ⏰ Time savings: ${timeSavings}ms (${timeSavingsPercent}% faster)`);
    console.log(`   📡 Request reduction: ${requestReduction} fewer requests (${requestReductionPercent}% reduction)`);
    console.log(`   🎯 Cache hit rate: ${subsequentFetchTimes.filter(f => f.type.startsWith('304')).length}/${subsequentFetchCount} conditional requests`);
    
    // === ASSERTIONS: Verify Efficiency ===
    
    // Should process the same number of pages
    expect(subsequentResults).toHaveLength(4);
    expect(subsequentResults).toEqual(expect.arrayContaining(initialResults));
    
    // Should use conditional requests (If-None-Match/If-Modified-Since headers)
    const conditionalRequests = global.fetch.mock.calls.filter(call => {
      const headers = call[1]?.headers || {};
      return headers['If-None-Match'] || headers['If-Modified-Since'];
    });
    expect(conditionalRequests.length).toBeGreaterThan(0);
    console.log(`   🔍 Conditional requests made: ${conditionalRequests.length}`);
    
    // Should receive 304 responses for unchanged content
    const notModifiedResponses = subsequentFetchTimes.filter(f => f.type.startsWith('304'));
    expect(notModifiedResponses.length).toBeGreaterThan(0);
    console.log(`   ✋ 304 Not Modified responses: ${notModifiedResponses.length}`);
    
    // Should be significantly faster (at least 30% improvement expected)
    expect(subsequentDuration).toBeLessThan(initialDuration);
    const speedupFactor = initialDuration / subsequentDuration;
    expect(speedupFactor).toBeGreaterThan(1.3); // At least 30% faster
    console.log(`   🚀 Speed improvement factor: ${speedupFactor.toFixed(2)}x`);
    
    // Should make fewer HTTP requests (due to skipping unchanged content)
    expect(subsequentFetchCount).toBeLessThanOrEqual(initialFetchCount);
    
    // Verify database contains the pages with proper metadata
    const finalDb = getDB(DB_PATH);
    const pageCount = finalDb.db.prepare('SELECT COUNT(*) as count FROM pages').get();
    expect(pageCount.count).toBe(4);
    
    // Verify pages have ETag and Last-Modified data for future optimizations
    const pagesWithETag = finalDb.db.prepare('SELECT COUNT(*) as count FROM pages WHERE etag IS NOT NULL AND etag != \"\"').get();
    expect(pagesWithETag.count).toBeGreaterThan(0);
    
    finalDb.finalizeSession();
    finalDb.close();
    
    console.log(`\\n🎉 EFFICIENCY TEST PASSED - Subsequent crawls are demonstrably faster!\\n`);
  });
  
  it('should handle mixed scenarios with some changed and some unchanged content', async () => {
    console.log('\\n=== MIXED CHANGE SCENARIO TEST ===\\n');
    
    // === FIRST CRAWL ===
    console.log('🚀 Initial crawl with original content...');
    let db = getDB(DB_PATH);
    let crawlState = new DefaultCrawlState(db);
    
    const processor1 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 4,
      debug: false
    });
    
    await processor1.process();
    db.finalizeSession();
    db.close();
    
    // Reset counters
    fetchCallCount = 0;
    fetchTimes = [];
    
    // === UPDATE SOME CONTENT ===
    console.log('📝 Simulating content changes (page2 and page3 updated)...');
    
    // Update page2 - new content and ETag
    mockResponses['https://example.com/page2'] = {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'etag': '"page2-v2"', // Changed ETag
        'last-modified': 'Thu, 22 Oct 2015 08:00:00 GMT'
      },
      body: '<html><head><title>Page 2 Updated</title></head><body><h1>Page 2 - Updated!</h1><p>This content has been significantly updated with new information.</p></body></html>'
    };
    
    // Update page3 - new content and Last-Modified
    mockResponses['https://example.com/page3'] = {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'etag': '"page3-v1"', // Same ETag
        'last-modified': 'Thu, 22 Oct 2015 08:30:00 GMT' // Updated Last-Modified
      },
      body: '<html><head><title>Page 3 Updated</title></head><body><h1>Page 3 - Updated!</h1><p>This page also has updated content.</p></body></html>'
    };
    
    // Home and page1 remain unchanged
    
    // === SECOND CRAWL (Mixed scenario) ===
    console.log('🔄 Subsequent crawl with mixed changes...');
    const mixedStartTime = Date.now();
    
    db = getDB(DB_PATH);
    crawlState = new DefaultCrawlState(db);
    
    const processor2 = new SiteProcessor('https://example.com', {
      crawlState,
      outputDir: OUTPUT_DIR,
      limit: 4,
      debug: false,
      test: true // Enable detailed logging
    });
    
    await processor2.process();
    const mixedEndTime = Date.now();
    const mixedDuration = mixedEndTime - mixedStartTime;
    
    db.finalizeSession();
    db.close();
    
    // === ANALYZE MIXED RESULTS ===
    const conditionalRequests = global.fetch.mock.calls.filter(call => {
      const headers = call[1]?.headers || {};
      return headers['If-None-Match'] || headers['If-Modified-Since'];
    });
    
    const notModifiedResponses = fetchTimes.filter(f => f.type.startsWith('304'));
    const fullDownloads = fetchTimes.filter(f => f.type === '200_full');
    
    console.log(`\\n📊 MIXED SCENARIO RESULTS:`);
    console.log(`   Duration: ${mixedDuration}ms`);
    console.log(`   Conditional requests: ${conditionalRequests.length}`);
    console.log(`   304 Not Modified: ${notModifiedResponses.length}`);
    console.log(`   Full downloads: ${fullDownloads.length}`);
    
    // Verify mixed behavior
    expect(conditionalRequests.length).toBeGreaterThan(0); // Should use conditional requests
    expect(notModifiedResponses.length).toBeGreaterThan(0); // Some content unchanged
    expect(fullDownloads.length).toBeGreaterThan(0); // Some content changed
    expect(notModifiedResponses.length + fullDownloads.length).toBeLessThanOrEqual(4); // Total should be reasonable
    
    console.log(`🎯 Mixed scenario handled correctly - optimal requests made!\\n`);
  });
});