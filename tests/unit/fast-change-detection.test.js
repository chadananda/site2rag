import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDB } from '../../src/db.js';
import { FastChangeDetector, createFastChangeDetector } from '../../src/services/fast_change_detector.js';

/**
 * Test suite for FastChangeDetector
 * Verifies speed optimizations and efficient re-crawl behavior
 */
describe('FastChangeDetector', () => {
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp', 'fast-change');
  let db;
  let detector;
  
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    // Create database and change detector
    db = getDB(path.join(TEST_DIR, 'db', 'crawl.db'));
    detector = new FastChangeDetector({
      db,
      minAgeHours: 24, // 1 day for testing
      fastRecheckHours: 6, // 6 hours for testing
      enableTimeFilters: true
    });
  });
  
  afterEach(() => {
    if (db) {
      db.finalizeSession();
      db.close();
    }
    
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
  
  describe('Time-based filtering', () => {
    it('should skip recently crawled content based on age filter', async () => {
      const url = 'https://example.com/recent';
      
      // Create a page that was crawled 12 hours ago (less than minAgeHours)
      const recentTime = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      db.upsertPage({
        url,
        etag: '"abc123"',
        last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        content_hash: 'hash123',
        last_crawled: recentTime,
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      // Mock response
      const mockResponse = {
        headers: new Map([
          ['etag', '"def456"'],
          ['last-modified', 'Thu, 22 Oct 2015 07:28:00 GMT']
        ])
      };
      
      const result = await detector.checkForChanges(url, mockResponse, 'new content');
      
      expect(result.hasChanged).toBe(false);
      expect(result.reason).toBe('age_filter');
      expect(result.ageHours).toBeLessThan(24);
      expect(detector.getStats().skippedByAge).toBe(1);
    });
    
    it('should check old content that exceeds minimum age', async () => {
      const url = 'https://example.com/old';
      
      // Create a page that was crawled 48 hours ago (more than minAgeHours)
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      db.upsertPage({
        url,
        etag: '"abc123"',
        last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        content_hash: 'hash123',
        last_crawled: oldTime,
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      // Mock response with same ETag (unchanged)
      const mockResponse = {
        headers: new Map([
          ['etag', '"abc123"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
        ])
      };
      
      const result = await detector.checkForChanges(url, mockResponse, 'same content');
      
      expect(result.hasChanged).toBe(false);
      expect(result.reason).toBe('etag_match');
      expect(detector.getStats().skippedByAge).toBe(0);
      expect(detector.getStats().skippedByETag).toBe(1);
    });
  });
  
  describe('ETag optimization', () => {
    it('should skip content with matching ETags', async () => {
      const url = 'https://example.com/etag';
      
      // Create existing page with ETag
      db.upsertPage({
        url,
        etag: '"unchanged123"',
        last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        content_hash: 'hash123',
        last_crawled: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      // Mock response with same ETag
      const mockResponse = {
        headers: new Map([
          ['etag', '"unchanged123"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
        ])
      };
      
      const result = await detector.checkForChanges(url, mockResponse, 'any content');
      
      expect(result.hasChanged).toBe(false);
      expect(result.reason).toBe('etag_match');
      expect(result.etag).toBe('"unchanged123"');
      expect(detector.getStats().skippedByETag).toBe(1);
    });
    
    it('should detect changes when ETag differs', async () => {
      const url = 'https://example.com/etag-changed';
      
      // Create existing page with old ETag
      db.upsertPage({
        url,
        etag: '"old123"',
        last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        content_hash: 'hash123',
        last_crawled: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      // Mock response with new ETag
      const mockResponse = {
        headers: new Map([
          ['etag', '"new456"'],
          ['last-modified', 'Thu, 22 Oct 2015 07:28:00 GMT']
        ])
      };
      
      const result = await detector.checkForChanges(url, mockResponse, 'updated content');
      
      expect(result.hasChanged).toBe(true);
      expect(result.reason).toBe('content_updated');
      expect(result.isNew).toBe(false);
      expect(detector.getStats().updatedContent).toBe(1);
    });
  });
  
  describe('Content hash optimization', () => {
    it('should skip content with matching hash even when headers differ', async () => {
      const url = 'https://example.com/hash';
      const content = 'This is the same content';
      
      // Create existing page without ETags but with content hash
      db.upsertPage({
        url,
        etag: '',
        last_modified: '',
        content_hash: detector._calculateContentHash(content),
        last_crawled: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      // Mock response without cache headers
      const mockResponse = {
        headers: new Map()
      };
      
      const result = await detector.checkForChanges(url, mockResponse, content);
      
      expect(result.hasChanged).toBe(false);
      expect(result.reason).toBe('content_hash_match');
      expect(detector.getStats().skippedByHash).toBe(1);
    });
    
    it('should detect changes when content hash differs', async () => {
      const url = 'https://example.com/hash-changed';
      const oldContent = 'This is the old content';
      const newContent = 'This is the new content';
      
      // Create existing page with old content hash
      db.upsertPage({
        url,
        etag: '',
        last_modified: '',
        content_hash: detector._calculateContentHash(oldContent),
        last_crawled: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      // Mock response without cache headers
      const mockResponse = {
        headers: new Map()
      };
      
      const result = await detector.checkForChanges(url, mockResponse, newContent);
      
      expect(result.hasChanged).toBe(true);
      expect(result.reason).toBe('content_updated');
      expect(detector.getStats().updatedContent).toBe(1);
    });
  });
  
  describe('Conditional headers generation', () => {
    it('should generate If-None-Match header for pages with ETags', () => {
      const url = 'https://example.com/headers';
      
      // Create page with ETag
      db.upsertPage({
        url,
        etag: '"test123"',
        last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        content_hash: 'hash123',
        last_crawled: new Date().toISOString(),
        status: 200,
        title: 'Test Page',
        file_path: 'test.md'
      });
      
      const headers = detector.generateConditionalHeaders(url);
      
      expect(headers).toHaveProperty('If-None-Match', '"test123"');
      expect(headers).toHaveProperty('If-Modified-Since', 'Wed, 21 Oct 2015 07:28:00 GMT');
    });
    
    it('should return empty headers for unknown URLs', () => {
      const headers = detector.generateConditionalHeaders('https://example.com/unknown');
      
      expect(Object.keys(headers)).toHaveLength(0);
    });
  });
  
  describe('Page data management', () => {
    it('should update page data with content_status=raw for new content', () => {
      const url = 'https://example.com/new';
      const content = 'New page content';
      
      const mockResponse = {
        headers: new Map([
          ['etag', '"new123"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
        ]),
        status: 200
      };
      
      detector.updatePageData(url, mockResponse, content, 'new.md', true);
      
      const savedPage = db.getPage(url);
      expect(savedPage).toBeTruthy();
      expect(savedPage.etag).toBe('"new123"');
      expect(savedPage.content_hash).toBe(detector._calculateContentHash(content));
      expect(savedPage.content_status).toBe('raw'); // Should be marked for AI processing
    });
    
    it('should update unchanged page timestamp without changing content_status', () => {
      const url = 'https://example.com/unchanged';
      
      // Create existing page with processed status
      db.upsertPage({
        url,
        etag: '"unchanged123"',
        last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        content_hash: 'hash123',
        last_crawled: '2023-01-01T00:00:00.000Z',
        status: 200,
        title: 'Test Page',
        file_path: 'test.md',
        content_status: 'contexted' // Already processed
      });
      
      detector.updateUnchangedPage(url);
      
      const updatedPage = db.getPage(url);
      expect(updatedPage.content_status).toBe('contexted'); // Should remain unchanged
      expect(new Date(updatedPage.last_crawled).getTime()).toBeGreaterThan(new Date('2023-01-01T00:00:00.000Z').getTime());
    });
  });
  
  describe('Performance statistics', () => {
    it('should track comprehensive performance metrics', async () => {
      const baseTime = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
      
      // Set up test scenarios - using minAgeHours = 24 from beforeEach
      const scenarios = [
        { url: 'https://example.com/recent', age: 12, etag: '"same"', expectedSkip: 'age' },  // 12h < 24h = age skip
        { url: 'https://example.com/etag', age: 48, etag: '"same"', expectedSkip: 'etag' },   // 48h > 24h, same etag = etag skip
        { url: 'https://example.com/lastmod', age: 48, etag: '', lastMod: 'same', expectedSkip: 'lastmod' }, // no etag, same lastmod = lastmod skip
        { url: 'https://example.com/hash', age: 48, etag: '', lastMod: '', hash: 'same', expectedSkip: 'hash' }, // no headers, same hash = hash skip
        { url: 'https://example.com/new', age: 0, etag: '', lastMod: '', hash: '', expectedSkip: 'none' },     // new page = no skip
        { url: 'https://example.com/updated', age: 48, etag: '"different"', expectedSkip: 'none' }             // different etag = no skip
      ];
      
      // Create existing pages
      for (const scenario of scenarios) {
        if (scenario.age > 0) {
          db.upsertPage({
            url: scenario.url,
            etag: scenario.etag === '"same"' ? '"existing"' : '',
            last_modified: scenario.lastMod === 'same' ? 'Wed, 21 Oct 2015 07:28:00 GMT' : '',
            content_hash: scenario.hash === 'same' ? 'existinghash' : '',
            last_crawled: new Date(baseTime + scenario.age * 60 * 60 * 1000).toISOString(),
            status: 200,
            title: 'Test Page',
            file_path: 'test.md'
          });
        }
      }
      
      // Test each scenario
      for (const scenario of scenarios) {
        const mockResponse = {
          headers: new Map([
            ['etag', scenario.etag === '"same"' ? '"existing"' : scenario.etag],
            ['last-modified', scenario.lastMod === 'same' ? 'Wed, 21 Oct 2015 07:28:00 GMT' : 'Thu, 22 Oct 2015 07:28:00 GMT']
          ])
        };
        
        const content = scenario.hash === 'same' ? 'content that produces existinghash' : `unique content for ${scenario.url}`;
        // For same hash scenario, we need to ensure the content actually produces the expected hash
        if (scenario.hash === 'same') {
          // Update the existing page with the correct hash for the content we'll test
          const correctHash = detector._calculateContentHash(content);
          db.db.prepare('UPDATE pages SET content_hash = ? WHERE url = ?').run(correctHash, scenario.url);
        }
        
        await detector.checkForChanges(scenario.url, mockResponse, content);
      }
      
      const stats = detector.getStats();
      
      expect(stats.totalChecked).toBe(6);
      expect(stats.skippedByAge).toBe(1);
      expect(stats.skippedByETag).toBe(1);
      expect(stats.skippedByLastModified).toBe(1);
      expect(stats.skippedByHash).toBe(1);
      expect(stats.newContent).toBe(1);
      expect(stats.updatedContent).toBe(1);
      expect(stats.totalSkipped).toBe(4);
      expect(parseFloat(stats.efficiency)).toBeGreaterThan(60); // Should be ~66.7%
    });
  });
  
  describe('Factory configurations', () => {
    it('should create conservative configuration', () => {
      const conservative = createFastChangeDetector.conservative(db);
      
      expect(conservative.minAgeHours).toBe(168); // 1 week
      expect(conservative.fastRecheckHours).toBe(72); // 3 days
      expect(conservative.enableTimeFilters).toBe(true);
    });
    
    it('should create aggressive configuration', () => {
      const aggressive = createFastChangeDetector.aggressive(db);
      
      expect(aggressive.minAgeHours).toBe(24); // 1 day
      expect(aggressive.fastRecheckHours).toBe(6); // 6 hours
      expect(aggressive.enableTimeFilters).toBe(true);
    });
    
    it('should create balanced configuration', () => {
      const balanced = createFastChangeDetector.balanced(db);
      
      expect(balanced.minAgeHours).toBe(72); // 3 days
      expect(balanced.fastRecheckHours).toBe(24); // 1 day
      expect(balanced.enableTimeFilters).toBe(true);
    });
    
    it('should create no-time-filters configuration', () => {
      const noTimeFilters = createFastChangeDetector.noTimeFilters(db);
      
      expect(noTimeFilters.enableTimeFilters).toBe(false);
    });
  });
});