// db-coordination.test.js
// Test database coordination for parallel AI processing
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {getDB} from '../../../src/db.js';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
describe('Database Coordination for AI Processing', () => {
  let db;
  let testDir;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = path.join(__dirname, '../../tmp', `test-db-coord-${Date.now()}`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }

    // Create test database
    db = getDB(path.join(testDir, '.site2rag'));

    // Insert test pages
    const testPages = [
      {url: 'https://example.com/page1', file_path: '/tmp/page1.md', content_status: 'raw'},
      {url: 'https://example.com/page2', file_path: '/tmp/page2.md', content_status: 'raw'},
      {url: 'https://example.com/page3', file_path: '/tmp/page3.md', content_status: 'raw'},
      {url: 'https://example.com/page4', file_path: '/tmp/page4.md', content_status: 'raw'},
      {url: 'https://example.com/page5', file_path: '/tmp/page5.md', content_status: 'raw'}
    ];

    testPages.forEach(page => {
      db.upsertPage({
        ...page,
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });
    });
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true, force: true});
    }
  });

  describe('Atomic Page Claiming', () => {
    it('should claim pages atomically for a processor', () => {
      const claimedPages = db.claimPagesForProcessing(3, 'processor1');

      expect(claimedPages).toHaveLength(3);
      expect(claimedPages[0]).toHaveProperty('url');
      expect(claimedPages[0]).toHaveProperty('file_path');

      // Verify pages are marked as processing
      claimedPages.forEach(page => {
        const dbPage = db.getPage(page.url);
        expect(dbPage.content_status).toBe('processing');
        expect(dbPage.context_error).toBe('processor:processor1');
      });
    });

    it('should not allow double-claiming of pages', () => {
      // First processor claims 3 pages
      const processor1Pages = db.claimPagesForProcessing(3, 'processor1');
      expect(processor1Pages).toHaveLength(3);

      // Second processor should get different pages
      const processor2Pages = db.claimPagesForProcessing(3, 'processor2');
      expect(processor2Pages).toHaveLength(2); // Only 2 pages left

      // Verify no overlap
      const processor1Urls = processor1Pages.map(p => p.url);
      const processor2Urls = processor2Pages.map(p => p.url);
      const overlap = processor1Urls.filter(url => processor2Urls.includes(url));
      expect(overlap).toHaveLength(0);
    });

    it('should return empty array when no pages available', () => {
      // Claim all pages
      db.claimPagesForProcessing(10, 'processor1');

      // Try to claim more
      const additionalPages = db.claimPagesForProcessing(5, 'processor2');
      expect(additionalPages).toHaveLength(0);
    });
  });

  describe('Page Status Updates', () => {
    it('should mark page as contexted successfully', () => {
      const pages = db.claimPagesForProcessing(1, 'processor1');
      const page = pages[0];

      db.markPageContexted(page.url);

      const updatedPage = db.getPage(page.url);
      expect(updatedPage.content_status).toBe('contexted');
      expect(updatedPage.context_error).toBeNull();
    });

    it('should mark page as failed with error message', () => {
      const pages = db.claimPagesForProcessing(1, 'processor1');
      const page = pages[0];
      const errorMessage = 'API rate limit exceeded';

      db.markPageFailed(page.url, errorMessage);

      const updatedPage = db.getPage(page.url);
      expect(updatedPage.content_status).toBe('failed');
      expect(updatedPage.context_error).toBe(errorMessage);
    });
  });

  describe('Stuck Page Recovery', () => {
    it('should reset stuck processing pages', () => {
      // Claim pages and simulate them being stuck
      const pages = db.claimPagesForProcessing(2, 'processor1');

      // Make one page appear stuck by setting old timestamp
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
      db.db.prepare('UPDATE pages SET last_context_attempt = ? WHERE url = ?').run(oldTime, pages[0].url);

      // Reset stuck pages (older than 5 minutes)
      const resetCount = db.resetStuckProcessing(5);

      expect(resetCount).toBe(1);

      // Verify the stuck page is reset
      const resetPage = db.getPage(pages[0].url);
      expect(resetPage.content_status).toBe('raw');
      expect(resetPage.context_error).toBe('reset_from_stuck_processing');

      // Verify the non-stuck page is unchanged
      const normalPage = db.getPage(pages[1].url);
      expect(normalPage.content_status).toBe('processing');
    });

    it('should not reset recently claimed pages', () => {
      // Claim pages
      const claimedPages = db.claimPagesForProcessing(3, 'processor1');
      expect(claimedPages).toHaveLength(3);

      // Try to reset with 5 minute threshold
      const resetCount = db.resetStuckProcessing(5);

      expect(resetCount).toBe(0);

      // Verify claimed pages still processing
      const processingPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('processing');
      expect(processingPages).toHaveLength(3);

      // Verify unclaimed pages still raw
      const rawPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('raw');
      expect(rawPages).toHaveLength(2);
    });
  });

  describe('Concurrent Processing Simulation', () => {
    it('should handle multiple processors claiming pages concurrently', () => {
      const processors = ['proc1', 'proc2', 'proc3'];
      const allClaimed = [];

      // Simulate concurrent claiming
      processors.forEach(procId => {
        const claimed = db.claimPagesForProcessing(2, procId);
        allClaimed.push(...claimed);
      });

      // Should claim 5 pages total (we only have 5)
      expect(allClaimed).toHaveLength(5);

      // Verify each page claimed only once
      const urls = allClaimed.map(p => p.url);
      const uniqueUrls = [...new Set(urls)];
      expect(uniqueUrls).toHaveLength(5);
    });

    it('should handle mixed success and failure scenarios', () => {
      // Claim all pages
      const pages = db.claimPagesForProcessing(5, 'processor1');

      // Simulate mixed results
      db.markPageContexted(pages[0].url);
      db.markPageFailed(pages[1].url, 'Network error');
      db.markPageContexted(pages[2].url);
      // Leave pages[3] and pages[4] in processing state

      // Check status distribution
      const statuses = db.db
        .prepare('SELECT content_status, COUNT(*) as count FROM pages GROUP BY content_status')
        .all();
      const statusMap = Object.fromEntries(statuses.map(s => [s.content_status, s.count]));

      expect(statusMap.contexted).toBe(2);
      expect(statusMap.failed).toBe(1);
      expect(statusMap.processing).toBe(2);
    });
  });

  describe('Batch Processing', () => {
    it('should support claiming pages in batches', () => {
      const batchProcessor = 'batch-processor';
      const allPages = [];

      // Claim pages in batches until none left
      while (true) {
        const batch = db.claimPagesForProcessing(2, batchProcessor);
        if (batch.length === 0) break;
        allPages.push(...batch);
      }

      expect(allPages).toHaveLength(5);

      // All pages should be processing
      const processingCount = db.db
        .prepare('SELECT COUNT(*) as count FROM pages WHERE content_status = ?')
        .get('processing');
      expect(processingCount.count).toBe(5);
    });
  });

  describe('Error Recovery', () => {
    it('should allow retrying failed pages', () => {
      // Process and fail a page
      const pages = db.claimPagesForProcessing(1, 'processor1');
      db.markPageFailed(pages[0].url, 'First attempt failed');

      // Reset the page status for retry
      db.db.prepare('UPDATE pages SET content_status = ? WHERE url = ?').run('raw', pages[0].url);

      // Retry with different processor
      const retryPages = db.claimPagesForProcessing(1, 'processor2');
      expect(retryPages).toHaveLength(1);
      expect(retryPages[0].url).toBe(pages[0].url);

      // Mark as success this time
      db.markPageContexted(retryPages[0].url);

      const finalPage = db.getPage(pages[0].url);
      expect(finalPage.content_status).toBe('contexted');
    });
  });
});
