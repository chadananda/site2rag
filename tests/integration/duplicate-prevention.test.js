// duplicate-prevention.test.js
// Specifically test that paragraphs are processed exactly once
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createParallelAIProcessor} from '../../src/core/parallel_ai_processor.js';
import {runContextEnrichment} from '../../src/core/context_enrichment.js';
import {getDB} from '../../src/db.js';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Track all AI processing calls
let processingLog = [];

// Mock the AI processing to track calls
vi.mock('../../src/core/context_processor_simple.js', () => ({
  processDocumentsSimple: vi.fn().mockImplementation(async (docs, aiConfig, progressCallback) => {
    const results = {};

    for (const doc of docs) {
      // Log each processing attempt
      const blockTexts = doc.blocks.map(b => (typeof b === 'string' ? b : b.text));
      processingLog.push({
        docId: doc.docId,
        processorType: aiConfig.processorType || 'unknown',
        timestamp: Date.now(),
        blocks: blockTexts
      });

      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Add unique marker for this processor
      results[doc.docId] = blockTexts.map(
        text => `${text} [[processed by ${aiConfig.processorType} at ${Date.now()}]]`
      );
    }

    if (progressCallback) {
      progressCallback(docs.length, docs.length);
    }

    return results;
  })
}));

describe('Duplicate Processing Prevention', () => {
  let db;
  let testDir;

  beforeEach(() => {
    // Reset processing log
    processingLog = [];

    // Create test directory
    testDir = path.join(__dirname, '../tmp', `test-duplicate-${Date.now()}`);
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

  it('should process each paragraph exactly once with parallel processor', async () => {
    // Create test document with multiple paragraphs
    const testContent = `---
title: Test Document
---

This is the first paragraph that needs AI enhancement.

This is the second paragraph with different content.

This is the third paragraph to be processed.

This is the fourth and final paragraph.`;

    const filePath = path.join(testDir, 'test.md');
    fs.writeFileSync(filePath, testContent);

    // Add to database
    db.upsertPage({
      url: 'https://example.com/test',
      file_path: filePath,
      content_status: 'raw',
      title: 'Test Document',
      etag: null,
      last_modified: new Date().toISOString(),
      content_hash: 'test',
      last_crawled: new Date().toISOString(),
      status: 200
    });

    // Start parallel processor
    const processor = createParallelAIProcessor(
      db,
      {
        provider: 'mock',
        model: 'test',
        processorType: 'parallel'
      },
      100
    );

    processor.start();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 1000));

    processor.stop();

    // Check processing log
    expect(processingLog).toHaveLength(1);
    expect(processingLog[0].docId).toBe('https://example.com/test');
    expect(processingLog[0].processorType).toBe('parallel');
    expect(processingLog[0].blocks).toHaveLength(4); // 4 paragraphs

    // Check file content - each paragraph should have exactly one processing marker
    const processedContent = fs.readFileSync(filePath, 'utf8');
    const lines = processedContent.split('\n');

    // Count processing markers per paragraph
    let processingMarkers = 0;
    lines.forEach(line => {
      if (line.includes('[[processed by')) {
        processingMarkers++;
      }
    });

    expect(processingMarkers).toBe(4); // One marker per paragraph

    // Verify no duplicate processing markers
    expect(processedContent).not.toMatch(/\[\[processed by.*?\]\].*?\[\[processed by.*?\]\]/);
  });

  it('should prevent duplicate processing when both parallel and batch run', async () => {
    // Create multiple test documents
    const docCount = 5;
    for (let i = 1; i <= docCount; i++) {
      const content = `# Document ${i}

Paragraph 1 of document ${i} needs processing.

Paragraph 2 of document ${i} with more content.

Paragraph 3 of document ${i} final content.`;

      const filePath = path.join(testDir, `doc${i}.md`);
      fs.writeFileSync(filePath, content);

      db.upsertPage({
        url: `https://example.com/doc${i}`,
        file_path: filePath,
        content_status: 'raw',
        title: `Document ${i}`,
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });
    }

    // Start parallel processor
    const parallelProcessor = createParallelAIProcessor(
      db,
      {
        provider: 'mock',
        model: 'test',
        processorType: 'parallel'
      },
      50
    );

    parallelProcessor.start();

    // Give parallel a head start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Run batch processor concurrently
    await runContextEnrichment(db, {
      provider: 'mock',
      model: 'test',
      processorType: 'batch'
    });

    // Wait for parallel to finish
    await new Promise(resolve => setTimeout(resolve, 500));
    parallelProcessor.stop();

    // Analyze processing log
    const processedDocs = new Map();
    processingLog.forEach(entry => {
      if (!processedDocs.has(entry.docId)) {
        processedDocs.set(entry.docId, []);
      }
      processedDocs.get(entry.docId).push(entry);
    });

    // Each document should be processed exactly once
    processedDocs.forEach((entries, docId) => {
      expect(entries).toHaveLength(1);
      console.log(`Document ${docId} processed by: ${entries[0].processorType}`);
    });

    // All documents should be processed
    expect(processedDocs.size).toBe(docCount);

    // Check file contents
    for (let i = 1; i <= docCount; i++) {
      const content = fs.readFileSync(path.join(testDir, `doc${i}.md`), 'utf8');

      // Count processing markers
      const markers = (content.match(/\[\[processed by/g) || []).length;
      expect(markers).toBe(3); // 3 paragraphs per document

      // Should be processed by only one processor
      const parallelMarkers = (content.match(/\[\[processed by parallel/g) || []).length;
      const batchMarkers = (content.match(/\[\[processed by batch/g) || []).length;

      expect(parallelMarkers === 0 || batchMarkers === 0).toBe(true); // Not both
      expect(parallelMarkers + batchMarkers).toBe(3); // All paragraphs processed
    }
  });

  it('should show processing distribution between processors', async () => {
    // Create many documents to see distribution
    const docCount = 20;
    for (let i = 1; i <= docCount; i++) {
      const filePath = path.join(testDir, `doc${i}.md`);
      fs.writeFileSync(filePath, `Content ${i} to process`);

      db.upsertPage({
        url: `https://example.com/doc${i}`,
        file_path: filePath,
        content_status: 'raw',
        title: `Doc ${i}`,
        etag: null,
        last_modified: new Date().toISOString(),
        content_hash: 'test',
        last_crawled: new Date().toISOString(),
        status: 200
      });
    }

    // Start two parallel processors
    const processor1 = createParallelAIProcessor(
      db,
      {
        provider: 'mock',
        model: 'test',
        processorType: 'parallel1'
      },
      50
    );

    const processor2 = createParallelAIProcessor(
      db,
      {
        provider: 'mock',
        model: 'test',
        processorType: 'parallel2'
      },
      50
    );

    processor1.start();
    processor2.start();

    // Also run batch
    const batchPromise = runContextEnrichment(db, {
      provider: 'mock',
      model: 'test',
      processorType: 'batch'
    });

    await Promise.all([batchPromise, new Promise(resolve => setTimeout(resolve, 1000))]);

    processor1.stop();
    processor2.stop();

    // Analyze distribution
    const distribution = {
      parallel1: 0,
      parallel2: 0,
      batch: 0
    };

    processingLog.forEach(entry => {
      distribution[entry.processorType]++;
    });

    console.log('\nProcessing distribution:');
    console.log(`  Parallel 1: ${distribution.parallel1} documents`);
    console.log(`  Parallel 2: ${distribution.parallel2} documents`);
    console.log(`  Batch: ${distribution.batch} documents`);
    console.log(`  Total: ${processingLog.length} documents`);

    // Verify no duplicates
    expect(processingLog.length).toBe(docCount);

    // Each processor should have processed some documents
    expect(distribution.parallel1 + distribution.parallel2 + distribution.batch).toBe(docCount);
  });
});
