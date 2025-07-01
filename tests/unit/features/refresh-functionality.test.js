/**
 * tests/unit/features/refresh-functionality.test.js - Test coverage for refresh and change detection
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {CrawlService} from '../../../src/services/crawl_service.js';
import {CrawlDB} from '../../../src/db.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock dependencies
vi.mock('node-fetch');
vi.mock('../../../src/services/logger_service.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn()
  }
}));

describe('Refresh Functionality', () => {
  let crawlService;
  let db;
  let testDir;
  let mockFetch;

  beforeEach(async () => {
    // Setup test directory
    testDir = path.join(__dirname, '../../tmp', `test-refresh-${Date.now()}`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }

    // Create test database
    db = new CrawlDB(path.join(testDir, 'test.db'));
    
    // Initialize crawl service
    crawlService = new CrawlService({
      db,
      outputDir: testDir,
      downloadDocuments: true
    });

    // Setup fetch mock
    mockFetch = vi.mocked((await import('node-fetch')).default);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true, force: true});
    }
  });

  describe('Content Hash Detection', () => {
    it('should skip pages with unchanged content hash', async () => {
      const url = 'https://example.com/page1';
      const contentHash = 'abc123def456';
      
      // Insert existing page with content hash
      db.upsertPage(url, {
        content_hash: contentHash,
        last_crawled: new Date().toISOString(),
        status: 200,
        content_status: 'processed'
      });

      // Mock fetch to return same content
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'text/html']
        ]),
        text: () => Promise.resolve('<html><body>Same content</body></html>')
      });

      // Spy on _calculateContentHash to ensure it returns same hash
      vi.spyOn(crawlService, '_calculateContentHash').mockReturnValue(contentHash);

      const result = await crawlService.processUrl(url);

      expect(result.reason).toBe('content_hash_match');
      expect(result.updated).toBe(false);
    });

    it('should update pages with changed content hash', async () => {
      const url = 'https://example.com/page2';
      const oldHash = 'old123';
      const newHash = 'new456';
      
      // Insert existing page with old hash
      db.upsertPage(url, {
        content_hash: oldHash,
        last_crawled: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
        status: 200
      });

      // Mock fetch to return new content
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'text/html']
        ]),
        text: () => Promise.resolve('<html><body>New content here!</body></html>')
      });

      // Mock hash calculation
      vi.spyOn(crawlService, '_calculateContentHash')
        .mockReturnValueOnce(newHash);

      await crawlService.processUrl(url);

      // Verify page was updated with new hash
      const updatedPage = db.getPage(url);
      expect(updatedPage.content_hash).toBe(newHash);
    });

    it('should handle pages without previous content hash', async () => {
      const url = 'https://example.com/new-page';
      
      // Mock fetch
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'text/html']
        ]),
        text: () => Promise.resolve('<html><body>New page content</body></html>')
      });

      await crawlService.processUrl(url);

      // Verify page was created with content hash
      const page = db.getPage(url);
      expect(page).toBeTruthy();
      expect(page.content_hash).toBeTruthy();
    });
  });

  describe('ETag and Last-Modified Headers', () => {
    it('should send If-None-Match header when ETag exists', async () => {
      const url = 'https://example.com/etag-page';
      const etag = '"abc123"';
      
      // Insert page with ETag
      db.upsertPage(url, {
        etag: etag,
        last_crawled: new Date().toISOString()
      });

      // Mock 304 response
      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        headers: new Map()
      });

      await crawlService.processUrl(url);

      // Verify If-None-Match header was sent
      expect(mockFetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-None-Match': etag
          })
        })
      );
    });

    it('should send If-Modified-Since header when last_modified exists', async () => {
      const url = 'https://example.com/modified-page';
      const lastModified = 'Mon, 09 Jun 2025 01:20:58 GMT';
      
      // Insert page with last_modified
      db.upsertPage(url, {
        last_modified: lastModified,
        last_crawled: new Date().toISOString()
      });

      // Mock 304 response
      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        headers: new Map()
      });

      await crawlService.processUrl(url);

      // Verify If-Modified-Since header was sent
      expect(mockFetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-Modified-Since': lastModified
          })
        })
      );
    });

    it('should handle 304 Not Modified responses', async () => {
      const url = 'https://example.com/unchanged';
      
      // Insert existing page
      db.upsertPage(url, {
        etag: '"old-etag"',
        content_hash: 'existing-hash',
        last_crawled: new Date(Date.now() - 3600000).toISOString() // 1 hour ago
      });

      // Mock 304 response
      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        headers: new Map()
      });

      const result = await crawlService.processUrl(url);

      expect(result.status).toBe(304);
      expect(result.updated).toBe(false);
      
      // Verify content hash wasn't changed
      const page = db.getPage(url);
      expect(page.content_hash).toBe('existing-hash');
    });
  });

  describe('FAST_CHANGE Detection', () => {
    it('should mark frequently changing pages as FAST_CHANGE', async () => {
      const url = 'https://example.com/dynamic-page';
      
      // Simulate multiple crawls with different content
      for (let i = 0; i < 3; i++) {
        // Insert/update page
        db.upsertPage(url, {
          content_hash: `hash-${i}`,
          last_crawled: new Date(Date.now() - (i * 3600000)).toISOString()
        });

        // Mock fetch with different content each time
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'text/html']]),
          text: () => Promise.resolve(`<html><body>Content version ${i + 1}</body></html>`)
        });

        vi.spyOn(crawlService, '_calculateContentHash')
          .mockReturnValue(`hash-${i + 1}`);

        await crawlService.processUrl(url);
      }

      // Check if page is marked as frequently changing
      const page = db.getPage(url);
      // Note: The actual FAST_CHANGE logic might need to be implemented
      // This test assumes it exists or needs to be added
      expect(page.content_status).toContain('CHANGE');
    });

    it('should always re-crawl FAST_CHANGE pages', async () => {
      const url = 'https://example.com/always-fresh';
      
      // Insert page marked as FAST_CHANGE
      db.upsertPage(url, {
        content_status: 'FAST_CHANGE',
        content_hash: 'current-hash',
        last_crawled: new Date().toISOString()
      });

      // Mock fetch
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve('<html><body>Fresh content</body></html>')
      });

      await crawlService.processUrl(url);

      // Verify page was re-crawled even if recently crawled
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('Asset Skipping', () => {
    it('should skip unchanged asset files', async () => {
      const assetUrl = 'https://example.com/style.css';
      const contentHash = 'css-hash-123';
      
      // Insert existing asset
      db.upsertPage(assetUrl, {
        content_hash: contentHash,
        last_crawled: new Date().toISOString(),
        status: 200
      });

      // Mock fetch to return same content
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'text/css']
        ]),
        text: () => Promise.resolve('body { color: red; }')
      });

      vi.spyOn(crawlService, '_calculateContentHash').mockReturnValue(contentHash);

      const result = await crawlService.processUrl(assetUrl);

      expect(result.updated).toBe(false);
      expect(result.reason).toContain('hash');
    });

    it('should download changed asset files', async () => {
      const assetUrl = 'https://example.com/script.js';
      
      // Insert existing asset with old hash
      db.upsertPage(assetUrl, {
        content_hash: 'old-js-hash',
        last_crawled: new Date(Date.now() - 86400000).toISOString()
      });

      // Mock fetch with new content
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'application/javascript']
        ]),
        text: () => Promise.resolve('console.log("Updated!");')
      });

      vi.spyOn(crawlService, '_calculateContentHash').mockReturnValue('new-js-hash');

      await crawlService.processUrl(assetUrl);

      const page = db.getPage(assetUrl);
      expect(page.content_hash).toBe('new-js-hash');
    });
  });

  describe('Refresh Command Integration', () => {
    it('should respect force refresh flag', async () => {
      const url = 'https://example.com/force-refresh';
      
      // Insert existing page with recent crawl
      db.upsertPage(url, {
        content_hash: 'existing-hash',
        last_crawled: new Date().toISOString(),
        etag: '"fresh-etag"'
      });

      // Mock fetch
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve('<html><body>Content</body></html>')
      });

      // Force refresh should ignore cache headers
      crawlService.forceRefresh = true;
      await crawlService.processUrl(url);

      // Should not send conditional headers when force refresh
      expect(mockFetch).toHaveBeenCalledWith(
        url,
        expect.not.objectContaining({
          headers: expect.objectContaining({
            'If-None-Match': expect.any(String)
          })
        })
      );
    });

    it('should track refresh statistics', async () => {
      const stats = {
        totalChecked: 0,
        skipped: 0,
        updated: 0,
        errors: 0
      };

      // Process multiple URLs with different outcomes
      const urls = [
        {url: 'https://example.com/unchanged', shouldSkip: true},
        {url: 'https://example.com/changed', shouldSkip: false},
        {url: 'https://example.com/error', shouldError: true}
      ];

      for (const {url, shouldSkip, shouldError} of urls) {
        if (shouldError) {
          mockFetch.mockRejectedValue(new Error('Network error'));
        } else if (shouldSkip) {
          // Insert with current hash
          db.upsertPage(url, {
            content_hash: 'current',
            last_crawled: new Date().toISOString()
          });
          mockFetch.mockResolvedValue({
            ok: true,
            status: 304,
            headers: new Map()
          });
        } else {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            text: () => Promise.resolve('<html><body>New</body></html>')
          });
        }

        try {
          const result = await crawlService.processUrl(url);
          stats.totalChecked++;
          if (result.updated === false) stats.skipped++;
          else stats.updated++;
        } catch (e) {
          stats.errors++;
          stats.totalChecked++;
        }
      }

      expect(stats.totalChecked).toBe(3);
      expect(stats.skipped).toBe(1);
      expect(stats.updated).toBe(1);
      expect(stats.errors).toBe(1);
    });
  });
});