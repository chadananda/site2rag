// concurrent-processing.test.js
// Test concurrent parallel and batch processing scenarios
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createParallelAIProcessor} from '../../src/core/parallel_ai_processor.js';
import {runContextEnrichment} from '../../src/core/context_enrichment.js';
import {getDB} from '../../src/db.js';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Mock AI processing with delay to simulate real processing
vi.mock('../../src/core/context_processor_simple.js', () => ({
  processDocumentsSimple: vi.fn().mockImplementation(async (docs, aiConfig, progressCallback) => {
    const results = {};
    
    for (const doc of docs) {
      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Track which processor handled this
      const processorType = aiConfig.processorType || 'unknown';
      
      results[doc.docId] = doc.blocks.map(block => {
        const text = typeof block === 'string' ? block : block.text;
        return text + ` [[processed by ${processorType}]]`;
      });
    }
    
    if (progressCallback) {
      progressCallback(docs.length, docs.length);
    }
    
    return results;
  })
}));
describe('Concurrent Parallel and Batch Processing', () => {
  let db;
  let testDir;
  let parallelProcessor;
  
  beforeEach(() => {
    testDir = path.join(__dirname, '../tmp', `test-concurrent-${Date.now()}`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }
    
    db = getDB(path.join(testDir, '.site2rag'));
  });
  
  afterEach(() => {
    if (parallelProcessor) {
      parallelProcessor.stop();
    }
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true, force: true});
    }
  });
  
  describe('Parallel vs Batch Coordination', () => {
    it('should not process the same page twice when both processors run', async () => {
      // Create test pages
      const pageCount = 20;
      for (let i = 1; i <= pageCount; i++) {
        const filePath = path.join(testDir, `page${i}.md`);
        fs.writeFileSync(filePath, `Page ${i} content that needs processing`);
        
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
      
      // Start parallel processor
      const parallelConfig = {provider: 'mock', model: 'test', processorType: 'parallel'};
      parallelProcessor = createParallelAIProcessor(db, parallelConfig, 50);
      parallelProcessor.start();
      
      // Give parallel processor a head start
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Run batch processor concurrently
      const batchConfig = {provider: 'mock', model: 'test', processorType: 'batch'};
      const batchPromise = runContextEnrichment(db, batchConfig);
      
      // Wait for both to complete
      await Promise.all([
        batchPromise,
        new Promise(resolve => setTimeout(resolve, 1000)) // Wait for parallel to finish
      ]);
      
      // Verify all pages processed exactly once
      const allPages = db.db.prepare('SELECT * FROM pages').all();
      expect(allPages).toHaveLength(pageCount);
      
      allPages.forEach(page => {
        expect(page.content_status).toBe('contexted');
        
        // Check file content - should have exactly one processor mark
        const content = fs.readFileSync(page.file_path, 'utf8');
        const parallelMatches = (content.match(/\[\[processed by parallel\]\]/g) || []).length;
        const batchMatches = (content.match(/\[\[processed by batch\]\]/g) || []).length;
        
        // Should be processed by exactly one processor
        expect(parallelMatches + batchMatches).toBeGreaterThan(0);
        expect(parallelMatches > 0 && batchMatches > 0).toBe(false); // Not both
      });
    });
    
    it('should handle rapid sequential runs without duplication', async () => {
      // Create pages
      const pageCount = 10;
      for (let i = 1; i <= pageCount; i++) {
        const filePath = path.join(testDir, `page${i}.md`);
        fs.writeFileSync(filePath, `Content ${i}`);
        
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
      
      // Run batch processing multiple times rapidly
      const promises = [];
      for (let i = 0; i < 3; i++) {
        const config = {provider: 'mock', model: 'test', processorType: `batch${i}`};
        promises.push(runContextEnrichment(db, config));
      }
      
      await Promise.all(promises);
      
      // Check each page processed exactly once
      const allPages = db.db.prepare('SELECT * FROM pages').all();
      allPages.forEach(page => {
        const content = fs.readFileSync(page.file_path, 'utf8');
        const processingMarks = content.match(/\[\[processed by batch\d\]\]/g) || [];
        expect(processingMarks.length).toBe(1); // Exactly one processing
      });
    });
  });
  
  describe('Mixed Page States', () => {
    it('should handle mixed page states correctly', async () => {
      // Create pages in different states
      const states = [
        {status: 'raw', count: 5},
        {status: 'processing', count: 3, old: false},
        {status: 'processing', count: 2, old: true}, // Stuck
        {status: 'contexted', count: 4},
        {status: 'failed', count: 2}
      ];
      
      let pageIndex = 0;
      states.forEach(({status, count, old}) => {
        for (let i = 0; i < count; i++) {
          pageIndex++;
          const filePath = path.join(testDir, `${status}-${pageIndex}.md`);
          fs.writeFileSync(filePath, `Content for ${status} page ${pageIndex}`);
          
          const pageData = {
            url: `https://example.com/${status}-${pageIndex}`,
            file_path: filePath,
            content_status: status,
            title: `${status} Page ${pageIndex}`,
            etag: null,
            last_modified: new Date().toISOString(),
            content_hash: 'test',
            last_crawled: new Date().toISOString(),
            status: 200
          };
          
          // Make some processing pages "stuck"
          if (status === 'processing' && old) {
            pageData.last_context_attempt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          } else if (status === 'processing') {
            pageData.last_context_attempt = new Date().toISOString();
          }
          
          db.upsertPage(pageData);
        }
      });
      
      // Start parallel processor
      parallelProcessor = createParallelAIProcessor(db, {provider: 'mock', model: 'test', processorType: 'parallel'}, 100);
      parallelProcessor.start();
      
      // Run batch processor
      await runContextEnrichment(db, {provider: 'mock', model: 'test', processorType: 'batch'});
      
      // Wait for parallel to finish
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check results
      const finalStates = db.db.prepare('SELECT content_status, COUNT(*) as count FROM pages GROUP BY content_status').all();
      const stateMap = Object.fromEntries(finalStates.map(s => [s.content_status, s.count]));
      
      // Raw pages + stuck processing pages should be processed
      expect(stateMap.contexted).toBeGreaterThanOrEqual(4 + 5 + 2); // Original contexted + raw + stuck
      
      // Recent processing pages should remain processing (not stuck)
      expect(stateMap.processing).toBe(3);
      
      // Failed pages remain failed (not automatically retried)
      expect(stateMap.failed).toBe(2);
    });
  });
  
  describe('Performance and Race Conditions', () => {
    it('should handle high concurrency without race conditions', async () => {
      // Create many pages
      const pageCount = 50;
      for (let i = 1; i <= pageCount; i++) {
        const filePath = path.join(testDir, `page${i}.md`);
        fs.writeFileSync(filePath, `Page ${i}`);
        
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
      
      // Start multiple parallel processors
      const processors = [];
      for (let i = 0; i < 3; i++) {
        const processor = createParallelAIProcessor(
          db, 
          {provider: 'mock', model: 'test', processorType: `parallel${i}`}, 
          50
        );
        processor.start();
        processors.push(processor);
      }
      
      // Also run batch processor
      const batchPromise = runContextEnrichment(db, {provider: 'mock', model: 'test', processorType: 'batch'});
      
      // Wait for completion
      await Promise.all([
        batchPromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
      
      // Stop all processors
      processors.forEach(p => p.stop());
      
      // Verify no duplicates
      const allPages = db.db.prepare('SELECT * FROM pages').all();
      expect(allPages).toHaveLength(pageCount);
      
      let totalProcessed = 0;
      allPages.forEach(page => {
        if (page.content_status === 'contexted') {
          totalProcessed++;
          const content = fs.readFileSync(page.file_path, 'utf8');
          const processingMarks = content.match(/\[\[processed by \w+\]\]/g) || [];
          expect(processingMarks.length).toBe(1); // No double processing
        }
      });
      
      // All pages should be processed
      expect(totalProcessed).toBe(pageCount);
    });
  });
});