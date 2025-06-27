// context-enrichment-coordination.test.js
// Test batch context enrichment with database coordination
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {runContextEnrichment} from '../../src/core/context_enrichment.js';
import {getDB} from '../../src/db.js';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Mock the AI processing
vi.mock('../../src/core/context_processor_simple.js', () => ({
  processDocumentsSimple: vi.fn().mockImplementation(async (docs, aiConfig, progressCallback) => {
    // Simulate processing
    const results = {};
    let processed = 0;

    for (const doc of docs) {
      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 50));

      results[doc.docId] = doc.blocks.map(block => {
        const text = typeof block === 'string' ? block : block.text;
        return text + ' [[batch enrichment]]';
      });

      processed++;
      if (progressCallback) {
        progressCallback(processed, docs.length);
      }
    }

    return results;
  })
}));
describe('Context Enrichment Batch Processing with Coordination', () => {
  let db;
  let testDir;

  beforeEach(() => {
    // Create test directory
    testDir = path.join(__dirname, '../tmp', `test-batch-${Date.now()}`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }

    // Create test database
    db = getDB(path.join(testDir, '.site2rag'));
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true, force: true});
    }
  });

  describe('Batch Processing', () => {
    it('should process all raw pages in batches', async () => {
      // Create test pages
      const pageCount = 10;
      for (let i = 1; i <= pageCount; i++) {
        const filePath = path.join(testDir, `page${i}.md`);
        const content = `# Page ${i}\n\nThis is content for page ${i}.\n\nIt needs enrichment.`;

        fs.writeFileSync(filePath, content);

        db.upsertPage({
          url: `https://example.com/page${i}`,
          file_path: filePath,
          content_status: 'raw',
          title: `Page ${i}`,
          etag: null,
          last_modified: new Date().toISOString(),
          content_hash: 'test',
          last_crawled: new Date().toISOString(),
          status: 200
        });
      }

      // Run batch enrichment
      const aiConfig = {provider: 'mock', model: 'test'};
      let progressUpdates = 0;

      await runContextEnrichment(db, aiConfig, (current, total) => {
        progressUpdates++;
        expect(current).toBeLessThanOrEqual(total);
      });

      // Verify all pages processed
      const processedPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('contexted');
      expect(processedPages).toHaveLength(pageCount);

      // Verify progress was reported
      expect(progressUpdates).toBeGreaterThan(0);

      // Verify files were updated
      for (let i = 1; i <= pageCount; i++) {
        const content = fs.readFileSync(path.join(testDir, `page${i}.md`), 'utf8');
        expect(content).toContain('[[batch enrichment]]');
      }
    });

    it('should skip already processed pages', async () => {
      // Create mixed pages
      const pages = [
        {status: 'raw', count: 3},
        {status: 'contexted', count: 2},
        {status: 'processing', count: 1}
      ];

      pages.forEach(({status, count}) => {
        for (let i = 1; i <= count; i++) {
          const filePath = path.join(testDir, `${status}-page${i}.md`);
          fs.writeFileSync(filePath, `Content for ${status} page ${i}`);

          db.upsertPage({
            url: `https://example.com/${status}-page${i}`,
            file_path: filePath,
            content_status: status,
            title: `${status} Page ${i}`,
            etag: null,
            last_modified: new Date().toISOString(),
            content_hash: 'test',
            last_crawled: new Date().toISOString(),
            status: 200
          });
        }
      });

      // Run enrichment
      await runContextEnrichment(db, {provider: 'mock', model: 'test'});

      // Only raw pages should be processed
      const contextedPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('contexted');
      expect(contextedPages).toHaveLength(2 + 3); // Originally contexted + newly processed

      // Processing page should remain processing (stuck recovery not triggered)
      const processingPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('processing');
      expect(processingPages).toHaveLength(1);
    });

    it('should handle stuck pages before processing', async () => {
      // Create a stuck page
      const stuckFilePath = path.join(testDir, 'stuck.md');
      fs.writeFileSync(stuckFilePath, 'Stuck content');

      db.upsertPage({
        url: 'https://example.com/stuck',
        file_path: stuckFilePath,
        content_status: 'processing',
        title: 'Stuck Page',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200,
        last_context_attempt: new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 minutes ago
      });

      // Create a normal raw page
      const normalFilePath = path.join(testDir, 'normal.md');
      fs.writeFileSync(normalFilePath, 'Normal content');

      db.upsertPage({
        url: 'https://example.com/normal',
        file_path: normalFilePath,
        content_status: 'raw',
        title: 'Normal Page',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });

      // Run enrichment
      await runContextEnrichment(db, {provider: 'mock', model: 'test'});

      // Both pages should be processed
      const processedPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('contexted');
      expect(processedPages).toHaveLength(2);

      // Check both files were enriched
      const stuckContent = fs.readFileSync(stuckFilePath, 'utf8');
      expect(stuckContent).toContain('[[batch enrichment]]');

      const normalContent = fs.readFileSync(normalFilePath, 'utf8');
      expect(normalContent).toContain('[[batch enrichment]]');
    });
  });

  describe('Error Handling', () => {
    it('should mark pages as failed on processing error', async () => {
      // Create test page
      const filePath = path.join(testDir, 'error-page.md');
      fs.writeFileSync(filePath, 'Content that will fail');

      db.upsertPage({
        url: 'https://example.com/error',
        file_path: filePath,
        content_status: 'raw',
        title: 'Error Page',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });

      // Mock error for this specific page
      const {processDocumentsSimple} = await import('../../src/core/context_processor_simple.js');
      processDocumentsSimple.mockImplementationOnce(async () => {
        throw new Error('Mock enrichment error');
      });

      // Run enrichment
      await runContextEnrichment(db, {provider: 'mock', model: 'test'});

      // Page should be marked as failed
      const errorPage = db.getPage('https://example.com/error');
      expect(errorPage.content_status).toBe('failed');
      expect(errorPage.context_error).toContain('Mock enrichment error');
    });

    it('should continue processing other pages after error', async () => {
      // Create multiple pages
      for (let i = 1; i <= 3; i++) {
        const filePath = path.join(testDir, `page${i}.md`);
        fs.writeFileSync(filePath, `Page ${i} content`);

        db.upsertPage({
          url: `https://example.com/page${i}`,
          file_path: filePath,
          content_status: 'raw',
          title: `Page ${i}`,
          etag: null,
          last_modified: new Date().toISOString(),
          content_hash: 'test',
          last_crawled: new Date().toISOString(),
          status: 200
        });
      }

      // Mock error for second document only
      const {processDocumentsSimple} = await import('../../src/core/context_processor_simple.js');
      let callCount = 0;
      processDocumentsSimple.mockImplementation(async docs => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Mock error for second batch');
        }

        // Normal processing
        const results = {};
        docs.forEach(doc => {
          results[doc.docId] = doc.blocks.map(block => {
            const text = typeof block === 'string' ? block : block.text;
            return text + ' [[batch enrichment]]';
          });
        });
        return results;
      });

      // Run enrichment
      await runContextEnrichment(db, {provider: 'mock', model: 'test'});

      // At least some pages should be processed
      const processedPages = db.db.prepare('SELECT * FROM pages WHERE content_status = ?').all('contexted');
      expect(processedPages.length).toBeGreaterThan(0);
    });
  });

  describe('Frontmatter Preservation', () => {
    it('should preserve frontmatter during batch processing', async () => {
      // Create page with frontmatter
      const withFrontmatter = path.join(testDir, 'with-fm.md');
      fs.writeFileSync(withFrontmatter, '---\ntitle: Test Page\nauthor: Test Author\n---\n\nContent to enrich');

      // Create page without frontmatter
      const withoutFrontmatter = path.join(testDir, 'without-fm.md');
      fs.writeFileSync(withoutFrontmatter, 'Just plain content');

      // Add to database
      db.upsertPage({
        url: 'https://example.com/with-fm',
        file_path: withFrontmatter,
        content_status: 'raw',
        title: 'With FM',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });

      db.upsertPage({
        url: 'https://example.com/without-fm',
        file_path: withoutFrontmatter,
        content_status: 'raw',
        title: 'Without FM',
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });

      // Process
      await runContextEnrichment(db, {provider: 'mock', model: 'test'});

      // Check frontmatter preserved
      const withFmContent = fs.readFileSync(withFrontmatter, 'utf8');
      expect(withFmContent).toMatch(/^---\ntitle: Test Page\nauthor: Test Author\n---/);
      expect(withFmContent).toContain('[[batch enrichment]]');

      // Check no frontmatter added
      const withoutFmContent = fs.readFileSync(withoutFrontmatter, 'utf8');
      expect(withoutFmContent).not.toMatch(/^---/);
      expect(withoutFmContent).toContain('[[batch enrichment]]');
    });
  });
});
