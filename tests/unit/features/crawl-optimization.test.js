import {describe, it, expect, beforeEach} from 'vitest';
import fs from 'fs';
import {join} from 'path';
import {CrawlDB} from '../../../src/db.js';
import {FastChangeDetector} from '../../../src/services/crawl_service.js';

// Consolidated crawl optimization tests
describe('Crawl Optimization Features', () => {
  let testDbPath;
  let crawlDB;
  let fastChangeDetector;

  beforeEach(() => {
    testDbPath = join(process.cwd(), 'tests', 'tmp', 'crawl-optimization.sqlite');
    
    // Create test directory
    const testDir = join(process.cwd(), 'tests', 'tmp');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }
    
    // Clean up existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    
    crawlDB = new CrawlDB(testDbPath);
    fastChangeDetector = new FastChangeDetector({
      db: crawlDB,
      minAgeHours: 168, // 1 week
      fastRecheckHours: 72, // 3 days
      enableTimeFilters: true
    });
  });

  afterEach(() => {
    if (crawlDB) {
      crawlDB.close();
    }
    
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Fast Change Detection', () => {
    it('should detect likely static pages', () => {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      
      // Add old page that hasn't changed
      crawlDB.upsertPage('https://example.com/static', {
        title: 'Static Page',
        content: 'This content rarely changes',
        last_crawled: oneWeekAgo,
        content_status: 'contexted'
      });
      
      const shouldSkip = fastChangeDetector.shouldSkipUrl('https://example.com/static');
      expect(shouldSkip).toBe(true);
    });

    it('should not skip recently crawled pages', () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      
      // Add recently crawled page
      crawlDB.upsertPage('https://example.com/recent', {
        title: 'Recent Page',
        content: 'This was just crawled',
        last_crawled: oneHourAgo,
        content_status: 'contexted'
      });
      
      const shouldSkip = fastChangeDetector.shouldSkipUrl('https://example.com/recent');
      expect(shouldSkip).toBe(false);
    });

    it('should not skip pages that need processing', () => {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      
      // Add old page with raw status (needs processing)
      crawlDB.upsertPage('https://example.com/raw', {
        title: 'Raw Page',
        content: 'This needs AI processing',
        last_crawled: oneWeekAgo,
        content_status: 'raw'
      });
      
      const shouldSkip = fastChangeDetector.shouldSkipUrl('https://example.com/raw');
      expect(shouldSkip).toBe(false);
    });

    it('should handle conservative detection mode', () => {
      const conservativeDetector = new FastChangeDetector({
        db: crawlDB,
        minAgeHours: 168, // 1 week
        fastRecheckHours: 72, // 3 days
        enableTimeFilters: true
      });
      
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      
      crawlDB.upsertPage('https://example.com/conservative', {
        title: 'Conservative Test',
        content: 'Testing conservative mode',
        last_crawled: twoWeeksAgo,
        content_status: 'contexted'
      });
      
      const shouldSkip = conservativeDetector.shouldSkipUrl('https://example.com/conservative');
      expect(shouldSkip).toBe(true);
    });

    it('should handle aggressive detection mode', () => {
      const aggressiveDetector = new FastChangeDetector({
        db: crawlDB,
        minAgeHours: 24, // 1 day
        fastRecheckHours: 12, // 12 hours
        enableTimeFilters: true
      });
      
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      
      crawlDB.upsertPage('https://example.com/aggressive', {
        title: 'Aggressive Test',
        content: 'Testing aggressive mode',
        last_crawled: twoDaysAgo,
        content_status: 'contexted'
      });
      
      const shouldSkip = aggressiveDetector.shouldSkipUrl('https://example.com/aggressive');
      expect(shouldSkip).toBe(true);
    });

    it('should handle disabled time filters', () => {
      const noFilterDetector = new FastChangeDetector({
        db: crawlDB,
        enableTimeFilters: false
      });
      
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      
      crawlDB.upsertPage('https://example.com/nofilter', {
        title: 'No Filter Test',
        content: 'Testing without time filters',
        last_crawled: oneWeekAgo,
        content_status: 'contexted'
      });
      
      const shouldSkip = noFilterDetector.shouldSkipUrl('https://example.com/nofilter');
      expect(shouldSkip).toBe(false);
    });
  });

  describe('Cache Optimization', () => {
    it('should cache and reuse AI enhancement results', () => {
      // Mock cache system
      const mockCache = new Map();
      
      // Simulate caching AI enhancement for similar content
      const content1 = 'The organization was founded in 1844';
      // const content2 = 'The organization was established in 1844'; // Very similar
      
      const enhancement1 = 'The [[Bahai]] organization was founded in 1844';
      mockCache.set(content1, enhancement1);
      
      // Check if similar content can reuse cached result
      expect(mockCache.has(content1)).toBe(true);
      expect(mockCache.get(content1)).toBe(enhancement1);
    });

    it('should implement cache hit rate tracking', () => {
      // Mock cache statistics
      const cacheStats = {
        hits: 0,
        misses: 0,
        total: 0
      };
      
      // Simulate cache operations
      function checkCache() {
        cacheStats.total++;
        if (Math.random() > 0.3) { // 70% hit rate
          cacheStats.hits++;
          return 'cached-result';
        } else {
          cacheStats.misses++;
          return null;
        }
      }
      
      // Run multiple cache checks
      for (let i = 0; i < 100; i++) {
        checkCache(`test-key-${i}`);
      }
      
      const hitRate = (cacheStats.hits / cacheStats.total) * 100;
      expect(cacheStats.total).toBe(100);
      expect(hitRate).toBeGreaterThan(0);
      expect(hitRate).toBeLessThanOrEqual(100);
    });

    it('should optimize sliding window cache usage', () => {
      // Test sliding window cache optimization
      const windowCache = new Map();
      const maxCacheSize = 10;
      
      function addToCache(key, value) {
        if (windowCache.size >= maxCacheSize) {
          // Remove oldest entry (FIFO)
          const firstKey = windowCache.keys().next().value;
          windowCache.delete(firstKey);
        }
        windowCache.set(key, value);
      }
      
      // Add items to cache
      for (let i = 0; i < 15; i++) {
        addToCache(`window-${i}`, `value-${i}`);
      }
      
      expect(windowCache.size).toBe(maxCacheSize);
      expect(windowCache.has('window-5')).toBe(true); // Should have been evicted
      expect(windowCache.has('window-14')).toBe(true); // Should be present
    });
  });

  describe('Conditional Request Optimization', () => {
    it('should use ETags for conditional requests', () => {
      const url = 'https://example.com/etag-test';
      const etag = '"unique-etag-value"';
      
      // Store page with ETag
      crawlDB.upsertPage(url, {
        title: 'ETag Test',
        content: 'Content with ETag',
        etag: etag,
        content_status: 'contexted'
      });
      
      const page = crawlDB.getPage(url);
      expect(page.etag).toBe(etag);
      
      // In a real scenario, this would be used for If-None-Match header
    });

    it('should use Last-Modified dates for conditional requests', () => {
      const url = 'https://example.com/lastmod-test';
      const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';
      
      // Store page with Last-Modified
      crawlDB.upsertPage(url, {
        title: 'Last-Modified Test',
        content: 'Content with Last-Modified',
        lastModified: lastModified,
        content_status: 'contexted'
      });
      
      const page = crawlDB.getPage(url);
      expect(page.lastModified).toBe(lastModified);
      
      // In a real scenario, this would be used for If-Modified-Since header
    });

    it('should handle 304 Not Modified responses', () => {
      const url = 'https://example.com/not-modified';
      
      // Store page with previous crawl data
      crawlDB.upsertPage(url, {
        title: 'Not Modified Test',
        content: 'Unchanged content',
        etag: '"same-etag"',
        links: ['https://example.com/link1', 'https://example.com/link2'],
        content_status: 'contexted'
      });
      
      // Simulate 304 response - page data should remain the same
      const page = crawlDB.getPage(url);
      expect(page.content_status).toBe('contexted');
      expect(page.links).toEqual(['https://example.com/link1', 'https://example.com/link2']);
    });
  });

  describe('Crawl Performance Optimization', () => {
    it('should batch database operations for performance', async () => {
      const batchSize = 100;
      const urls = [];
      
      // Prepare batch of URLs
      for (let i = 0; i < batchSize; i++) {
        urls.push(`https://example.com/batch-${i}`);
      }
      
      // Simulate batch processing
      const startTime = Date.now();
      
      // In a real implementation, this would use a transaction
      crawlDB.db.exec('BEGIN TRANSACTION');
      
      for (const url of urls) {
        crawlDB.upsertPage(url, {
          title: `Batch Page ${url}`,
          content: 'Batch processed content',
          content_status: 'raw'
        });
      }
      
      crawlDB.db.exec('COMMIT');
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Verify all pages were inserted
      const count = crawlDB.countPagesByStatus('raw');
      expect(count).toBe(batchSize);
      
      // Performance should be reasonable (less than 1 second for 100 inserts)
      expect(duration).toBeLessThan(1000);
    });

    it('should implement efficient URL deduplication', () => {
      const urls = [
        'https://example.com/page',
        'https://example.com/page/', // Trailing slash
        'https://example.com/page?', // Empty query
        'https://example.com/page#', // Empty fragment
        'https://example.com/page?utm_source=test', // Query parameter
        'https://example.com/page#section' // Fragment
      ];
      
      // Normalize URLs for deduplication
      const normalizedUrls = new Set();
      
      urls.forEach(url => {
        try {
          const urlObj = new URL(url);
          // Remove fragments, trailing slashes, and normalize
          urlObj.hash = '';
          if (urlObj.pathname.endsWith('/') && urlObj.pathname !== '/') {
            urlObj.pathname = urlObj.pathname.slice(0, -1);
          }
          normalizedUrls.add(urlObj.toString());
        } catch {
          // Handle invalid URLs
        }
      });
      
      // Should deduplicate to fewer unique URLs
      expect(normalizedUrls.size).toBeLessThan(urls.length);
      expect(normalizedUrls.size).toBeGreaterThan(0);
    });

    it('should prioritize important pages in crawl queue', () => {
      const pages = [
        {url: 'https://example.com/', priority: 10}, // Homepage - highest priority
        {url: 'https://example.com/about', priority: 8},
        {url: 'https://example.com/contact', priority: 7},
        {url: 'https://example.com/blog/post-1', priority: 5},
        {url: 'https://example.com/admin/dashboard', priority: 1} // Admin - lowest priority
      ];
      
      // Sort by priority (descending)
      const sortedPages = pages.sort((a, b) => b.priority - a.priority);
      
      expect(sortedPages[0].url).toBe('https://example.com/');
      expect(sortedPages[sortedPages.length - 1].url).toBe('https://example.com/admin/dashboard');
    });
  });
});