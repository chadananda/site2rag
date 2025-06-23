import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import {join} from 'path';
import {CrawlDB} from '../../../src/db.js';
import {DefaultCrawlState} from '../../../src/core/crawl_state.js';

// Consolidated database tests
describe('Database Core', () => {
  let testDbPath;
  let crawlDB;
  let crawlState;

  beforeEach(() => {
    testDbPath = join(process.cwd(), 'tests', 'tmp', 'test-db.sqlite');
    
    // Ensure test directory exists
    const testDir = join(process.cwd(), 'tests', 'tmp');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }
    
    // Remove existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    
    crawlDB = new CrawlDB(testDbPath);
    crawlState = new DefaultCrawlState(crawlDB);
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

  describe('CrawlDB', () => {
    it('should create database and initialize schema', () => {
      expect(fs.existsSync(testDbPath)).toBe(true);
      
      // Test that we can perform basic operations
      const result = crawlDB.db.prepare('SELECT name FROM sqlite_master WHERE type="table"').all();
      const tableNames = result.map(row => row.name);
      
      expect(tableNames).toContain('pages');
    });

    it('should insert and retrieve pages', () => {
      const pageData = {
        url: 'https://example.com/test',
        title: 'Test Page',
        content: 'Test content',
        markdown: '# Test Page\n\nTest content',
        links: ['https://example.com/link1', 'https://example.com/link2'],
        last_crawled: new Date().toISOString(),
        content_status: 'raw'
      };

      crawlDB.upsertPage(pageData.url, pageData);
      
      const retrieved = crawlDB.getPage(pageData.url);
      expect(retrieved.url).toBe(pageData.url);
      expect(retrieved.title).toBe(pageData.title);
      expect(retrieved.content_status).toBe('raw');
    });

    it('should update existing pages', () => {
      const url = 'https://example.com/update-test';
      
      // Insert initial page
      crawlDB.upsertPage(url, {
        title: 'Original Title',
        content: 'Original content',
        content_status: 'raw'
      });
      
      // Update the page
      crawlDB.upsertPage(url, {
        title: 'Updated Title',
        content: 'Updated content',
        content_status: 'processed'
      });
      
      const retrieved = crawlDB.getPage(url);
      expect(retrieved.title).toBe('Updated Title');
      expect(retrieved.content_status).toBe('processed');
    });

    it('should handle JSON serialization for arrays', () => {
      const url = 'https://example.com/json-test';
      const links = ['https://example.com/link1', 'https://example.com/link2'];
      
      crawlDB.upsertPage(url, {
        title: 'JSON Test',
        links: links
      });
      
      const retrieved = crawlDB.getPage(url);
      expect(retrieved.links).toEqual(links);
    });

    it('should query pages by status', () => {
      // Insert pages with different statuses
      crawlDB.upsertPage('https://example.com/raw1', {title: 'Raw 1', content_status: 'raw'});
      crawlDB.upsertPage('https://example.com/raw2', {title: 'Raw 2', content_status: 'raw'});
      crawlDB.upsertPage('https://example.com/processed', {title: 'Processed', content_status: 'processed'});
      
      const rawPages = crawlDB.getPagesByStatus('raw');
      expect(rawPages).toHaveLength(2);
      expect(rawPages.every(page => page.content_status === 'raw')).toBe(true);
    });

    it('should count pages by status', () => {
      crawlDB.upsertPage('https://example.com/count1', {content_status: 'raw'});
      crawlDB.upsertPage('https://example.com/count2', {content_status: 'raw'});
      crawlDB.upsertPage('https://example.com/count3', {content_status: 'processed'});
      
      const rawCount = crawlDB.countPagesByStatus('raw');
      const processedCount = crawlDB.countPagesByStatus('processed');
      
      expect(rawCount).toBe(2);
      expect(processedCount).toBe(1);
    });

    it('should handle database recovery scenarios', () => {
      // Insert some data
      crawlDB.upsertPage('https://example.com/recovery', {
        title: 'Recovery Test',
        content_status: 'raw'
      });
      
      // Close and reopen database
      crawlDB.close();
      crawlDB = new CrawlDB(testDbPath);
      
      // Data should still be there
      const retrieved = crawlDB.getPage('https://example.com/recovery');
      expect(retrieved.title).toBe('Recovery Test');
    });
  });

  describe('CrawlState', () => {
    it('should track page state through crawl state service', async () => {
      const url = 'https://example.com/state-test';
      const pageData = {
        etag: '"test-etag"',
        lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        links: ['https://example.com/link1'],
        lastCrawled: new Date().toISOString()
      };

      await crawlState.upsertPage(url, pageData);
      
      const retrieved = crawlState.getPage(url);
      expect(retrieved.etag).toBe(pageData.etag);
      expect(retrieved.lastModified).toBe(pageData.lastModified);
    });

    it('should handle conditional requests', async () => {
      const url = 'https://example.com/conditional';
      
      // Store page with etag
      await crawlState.upsertPage(url, {
        etag: '"test-etag"',
        lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT'
      });
      
      const pageData = crawlState.getPage(url);
      expect(pageData.etag).toBe('"test-etag"');
      expect(pageData.lastModified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('should finalize crawl state properly', async () => {
      // Add some pages
      await crawlState.upsertPage('https://example.com/page1', {title: 'Page 1'});
      await crawlState.upsertPage('https://example.com/page2', {title: 'Page 2'});
      
      const initialCount = crawlState.getPageCount();
      expect(initialCount).toBe(2);
      
      // Finalize should complete without error
      await crawlState.finalize();
      
      // Should still be able to query after finalization
      const finalCount = crawlState.getPageCount();
      expect(finalCount).toBe(2);
    });

    it('should handle empty database gracefully', () => {
      const count = crawlState.getPageCount();
      expect(count).toBe(0);
      
      const nonExistentPage = crawlState.getPage('https://example.com/nonexistent');
      expect(nonExistentPage).toBe(null);
    });
  });

  describe('Database performance and reliability', () => {
    it('should handle concurrent operations', async () => {
      const operations = [];
      
      // Create multiple concurrent operations
      for (let i = 0; i < 10; i++) {
        operations.push(
          crawlState.upsertPage(`https://example.com/concurrent${i}`, {
            title: `Concurrent Page ${i}`,
            content_status: 'raw'
          })
        );
      }
      
      // Wait for all operations to complete
      await Promise.all(operations);
      
      // Verify all pages were inserted
      const count = crawlState.getPageCount();
      expect(count).toBe(10);
    });

    it('should handle large amounts of data', () => {
      const largeContent = 'x'.repeat(100000); // 100KB of content
      
      crawlDB.upsertPage('https://example.com/large', {
        title: 'Large Content Test',
        content: largeContent,
        content_status: 'raw'
      });
      
      const retrieved = crawlDB.getPage('https://example.com/large');
      expect(retrieved.content).toBe(largeContent);
    });

    it('should handle special characters in URLs and content', () => {
      const specialUrl = 'https://example.com/特殊字符/test?query=value&other=测试';
      const specialContent = 'Content with special chars: 特殊字符 émojis 🚀 quotes "test" apostrophes\'s';
      
      crawlDB.upsertPage(specialUrl, {
        title: 'Special Characters Test',
        content: specialContent,
        content_status: 'raw'
      });
      
      const retrieved = crawlDB.getPage(specialUrl);
      expect(retrieved.content).toBe(specialContent);
    });
  });
});