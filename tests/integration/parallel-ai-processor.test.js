// parallel-ai-processor.test.js
// Integration tests for parallel AI processing with database coordination
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createParallelAIProcessor} from '../../src/core/parallel_ai_processor.js';
import {getDB} from '../../src/db.js';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Mock the AI processing to avoid actual API calls
vi.mock('../../src/core/context_processor_simple.js', () => ({
  processDocumentsSimple: vi.fn().mockImplementation(async (docs, aiConfig, progressCallback) => {
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 100));

    // Return mock enhanced content
    const results = {};
    docs.forEach(doc => {
      results[doc.docId] = doc.blocks.map(block =>
        typeof block === 'string' ? block + ' [[mock disambiguation]]' : block.text + ' [[mock disambiguation]]'
      );
    });

    // Simulate progress callback
    if (progressCallback) {
      progressCallback(1, 1);
    }

    return results;
  })
}));
describe('Parallel AI Processor Integration', () => {
  let db;
  let testDir;
  let processor;

  beforeEach(() => {
    // Create test directory
    testDir = path.join(__dirname, '../tmp', `test-parallel-${Date.now()}`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }

    // Create test database
    db = getDB(path.join(testDir, '.site2rag'));

    // Create test markdown files
    const testPages = [
      {
        url: 'https://example.com/page1',
        file_path: path.join(testDir, 'page1.md'),
        content:
          '---\ntitle: Page 1\n---\n\nThis is page 1 content.\n\nIt has multiple paragraphs.\n\nEach paragraph should be enhanced.'
      },
      {
        url: 'https://example.com/page2',
        file_path: path.join(testDir, 'page2.md'),
        content: '---\ntitle: Page 2\n---\n\nThis is page 2 content.\n\nWith different text.'
      },
      {
        url: 'https://example.com/page3',
        file_path: path.join(testDir, 'page3.md'),
        content: 'Page 3 has no frontmatter.\n\nBut still has content to process.'
      }
    ];

    // Create files and database entries
    testPages.forEach(page => {
      fs.writeFileSync(page.file_path, page.content);
      db.upsertPage({
        url: page.url,
        file_path: page.file_path,
        content_status: 'raw',
        title: page.url.split('/').pop(),
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });
    });
  });

  afterEach(() => {
    // Stop processor if running
    if (processor) {
      processor.stop();
    }

    // Close database
    if (db) {
      db.close();
    }

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true, force: true});
    }
  });

  describe('Basic Processing', () => {
    it('should process raw pages automatically', async () => {
      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100); // Fast check interval

      processor.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check that pages were processed
      const stats = processor.getStats();
      expect(stats.processed).toBeGreaterThan(0);
      expect(stats.isRunning).toBe(true);

      // Verify database status
      const processedPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('contexted');
      expect(processedPages.length).toBeGreaterThan(0);
    });

    it('should write enhanced content back to files', async () => {
      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100);

      processor.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check that files were updated
      const page1Content = fs.readFileSync(path.join(testDir, 'page1.md'), 'utf8');
      expect(page1Content).toContain('[[mock disambiguation]]');
      expect(page1Content).toContain('---\ntitle: Page 1\n---'); // Frontmatter preserved
    });

    it('should preserve frontmatter when processing', async () => {
      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100);

      processor.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check page with frontmatter
      const page1Content = fs.readFileSync(path.join(testDir, 'page1.md'), 'utf8');
      expect(page1Content.startsWith('---')).toBe(true);
      expect(page1Content).toContain('title: Page 1');

      // Check page without frontmatter
      const page3Content = fs.readFileSync(path.join(testDir, 'page3.md'), 'utf8');
      expect(page3Content.startsWith('---')).toBe(false);
      expect(page3Content).toContain('Page 3 has no frontmatter');
    });
  });

  describe('Concurrent Processing', () => {
    it('should handle multiple processors without conflicts', async () => {
      const aiConfig = {provider: 'mock', model: 'test'};

      // Create two processors
      const processor1 = createParallelAIProcessor(db, aiConfig, 100);
      const processor2 = createParallelAIProcessor(db, aiConfig, 100);

      // Start both
      processor1.start();
      processor2.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Stop processors
      processor1.stop();
      processor2.stop();

      // Check stats
      const stats1 = processor1.getStats();
      const stats2 = processor2.getStats();

      // Both should have processed some pages
      expect(stats1.processed + stats2.processed).toBeGreaterThan(0);

      // All pages should be processed exactly once
      const allPages = db.db.prepare('SELECT * FROM pages').all();
      allPages.forEach(page => {
        expect(['contexted', 'processing', 'raw']).toContain(page.content_status);
      });

      // No page should have been processed twice (check file content)
      allPages.forEach(page => {
        if (page.content_status === 'contexted' && fs.existsSync(page.file_path)) {
          const content = fs.readFileSync(page.file_path, 'utf8');
          const disambiguationCount = (content.match(/\[\[mock disambiguation\]\]/g) || []).length;
          // Each paragraph should have exactly one disambiguation
          const paragraphCount = content.split('\n\n').filter(p => p.trim() && !p.startsWith('---')).length;
          expect(disambiguationCount).toBeLessThanOrEqual(paragraphCount);
        }
      });
    });
  });

  describe('Error Handling', () => {
    it('should mark pages as failed on processing error', async () => {
      // Mock processDocumentsSimple to throw error
      const {processDocumentsSimple} = await import('../../src/core/context_processor_simple.js');
      processDocumentsSimple.mockImplementationOnce(async () => {
        throw new Error('Mock processing error');
      });

      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100);

      processor.start();

      // Wait for processing attempt
      await new Promise(resolve => setTimeout(resolve, 300));

      // Should have at least one failed page
      const failedPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('failed');
      expect(failedPages.length).toBeGreaterThan(0);
      expect(failedPages[0].context_error).toContain('Mock processing error');
    });

    it('should skip pages without file paths', async () => {
      // Add a page without file path
      db.upsertPage({
        url: 'https://example.com/no-file',
        file_path: null,
        content_status: 'raw',
        title: 'No File',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });

      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100);

      processor.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      // Page without file should still be raw
      const noFilePage = db.getPage('https://example.com/no-file');
      expect(noFilePage.content_status).toBe('raw');
    });
  });

  describe('Stop/Start Behavior', () => {
    it('should stop processing when stopped', async () => {
      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100);

      processor.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));

      // Stop processor
      processor.stop();
      const statsAtStop = processor.getStats();

      // Wait more
      await new Promise(resolve => setTimeout(resolve, 300));

      // Stats should not have changed
      const statsAfterStop = processor.getStats();
      expect(statsAfterStop.processed).toBe(statsAtStop.processed);
      expect(statsAfterStop.isRunning).toBe(false);
    });

    it('should resume processing when restarted', async () => {
      const aiConfig = {provider: 'mock', model: 'test'};
      processor = createParallelAIProcessor(db, aiConfig, 100);

      // Process one page
      processor.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      processor.stop();

      const initialStats = processor.getStats();

      // Add more raw pages
      db.upsertPage({
        url: 'https://example.com/page4',
        file_path: path.join(testDir, 'page4.md'),
        content_status: 'raw',
        title: 'Page 4',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });
      fs.writeFileSync(path.join(testDir, 'page4.md'), 'Page 4 content');

      // Restart processor
      processor.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const finalStats = processor.getStats();
      expect(finalStats.processed).toBeGreaterThan(initialStats.processed);
    });
  });
});
