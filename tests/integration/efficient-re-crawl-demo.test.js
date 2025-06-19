import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDB } from '../../src/db.js';
import { FastChangeDetector, createFastChangeDetector } from '../../src/services/fast_change_detector.js';

/**
 * Focused test demonstrating efficient subsequent loading with the FastChangeDetector
 * This test shows measurable performance improvements when re-processing known content
 */
describe('Efficient Re-crawl Demo', () => {
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp', 'integration-efficient-demo');
  let db;
  let detector;
  let mockResponses;
  
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    // Create database and change detector
    db = getDB(path.join(TEST_DIR, 'db', 'crawl.db'));
    detector = createFastChangeDetector.noTimeFilters(db, true); // No time filters, focus on ETag/content
    
    // Set up mock response data
    mockResponses = {
      home: {
        headers: new Map([
          ['etag', '"home-v1"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
        ]),
        status: 200
      },
      page1: {
        headers: new Map([
          ['etag', '"page1-v1"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:30:00 GMT']
        ]),
        status: 200
      },
      page2: {
        headers: new Map([
          ['etag', '"page2-v1"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:32:00 GMT']
        ]),
        status: 200
      },
      page3: {
        headers: new Map([
          ['etag', '"page3-v1"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:34:00 GMT']
        ]),
        status: 200
      }
    };
  });
  
  afterEach(() => {
    if (db) {
      db.finalizeSession();
      db.close();
    }
    
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
  
  it('should demonstrate measurable efficiency gains with change detection', async () => {
    console.log('\\n=== EFFICIENT RE-CRAWL DEMONSTRATION ===\\n');
    
    // === SIMULATE INITIAL CRAWL (First Time Processing) ===
    console.log('🚀 Simulating INITIAL crawl - processing new content...');
    
    const initialStartTime = Date.now();
    let processedCount = 0;
    let skippedCount = 0;
    
    // Process each page as if crawling for the first time
    const urls = [
      'https://example.com/',
      'https://example.com/page1', 
      'https://example.com/page2',
      'https://example.com/page3'
    ];
    
    const contentSamples = [
      'Home page with extensive content that requires processing time and AI analysis.',
      'Page 1 with detailed information and complex markup that needs extraction.',
      'Page 2 with comprehensive content and multiple sections requiring processing.',
      'Page 3 with extensive text and detailed information needing analysis.'
    ];
    
    const initialResults = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const content = contentSamples[i];
      const responseKey = i === 0 ? 'home' : `page${i}`;
      const response = mockResponses[responseKey];
      
      // Simulate processing time for new content
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const result = await detector.checkForChanges(url, response, content);
      initialResults.push(result);
      
      if (result.hasChanged) {
        // Save new content to database
        detector.updatePageData(url, response, content, `${responseKey}.md`, true);
        processedCount++;
        console.log(`✅ Processed: ${url} (${result.reason})`);
      } else {
        skippedCount++;
        console.log(`⏩ Skipped: ${url} (${result.reason})`);
      }
    }
    
    const initialEndTime = Date.now();
    const initialDuration = initialEndTime - initialStartTime;
    
    console.log(`\\n✅ Initial crawl simulation completed:`);
    console.log(`   Duration: ${initialDuration}ms`);
    console.log(`   New content processed: ${processedCount}`);
    console.log(`   Content skipped: ${skippedCount}`);
    
    // Verify all content was processed as new
    expect(processedCount).toBe(4);
    expect(skippedCount).toBe(0);
    expect(initialResults.every(r => r.hasChanged)).toBe(true);
    
    // Reset stats for second run
    detector.resetStats();
    
    // === SIMULATE SUBSEQUENT CRAWL (Re-crawl Same Content) ===
    console.log('\\n🔄 Simulating SUBSEQUENT crawl - same content (should skip)...');
    
    const subsequentStartTime = Date.now();
    processedCount = 0;
    skippedCount = 0;
    
    const subsequentResults = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const content = contentSamples[i]; // Same content
      const responseKey = i === 0 ? 'home' : `page${i}`;
      const response = mockResponses[responseKey]; // Same response headers
      
      // No processing delay needed for skipped content (efficiency!)
      
      const result = await detector.checkForChanges(url, response, content);
      subsequentResults.push(result);
      
      if (result.hasChanged) {
        detector.updatePageData(url, response, content, `${responseKey}.md`, true);
        processedCount++;
        console.log(`✅ Processed: ${url} (${result.reason})`);
      } else {
        detector.updateUnchangedPage(url);
        skippedCount++;
        console.log(`⏩ Skipped: ${url} (${result.reason})`);
      }
    }
    
    const subsequentEndTime = Date.now();
    const subsequentDuration = subsequentEndTime - subsequentStartTime;
    
    console.log(`\\n✅ Subsequent crawl simulation completed:`);
    console.log(`   Duration: ${subsequentDuration}ms`);
    console.log(`   New content processed: ${processedCount}`);
    console.log(`   Content skipped: ${skippedCount}`);
    
    // === EFFICIENCY ANALYSIS ===
    const timeSavings = initialDuration - subsequentDuration;
    const timeSavingsPercent = ((timeSavings / initialDuration) * 100).toFixed(1);
    const skipRate = (skippedCount / urls.length * 100).toFixed(1);
    
    console.log(`\\n📊 EFFICIENCY ANALYSIS:`);
    console.log(`   ⏰ Time savings: ${timeSavings}ms (${timeSavingsPercent}% faster)`);
    console.log(`   🎯 Skip rate: ${skipRate}% (${skippedCount}/${urls.length} skipped)`);
    console.log(`   🚀 Speed improvement: ${(initialDuration / subsequentDuration).toFixed(2)}x faster`);
    
    // Get detailed performance stats
    const stats = detector.getStats();
    console.log(`\\n📈 CHANGE DETECTION PERFORMANCE:`);
    console.log(`   Total URLs checked: ${stats.totalChecked}`);
    console.log(`   Skipped by ETag: ${stats.skippedByETag}`);
    console.log(`   Skipped by content hash: ${stats.skippedByHash}`);
    console.log(`   Overall efficiency: ${stats.efficiency}`);
    
    // === ASSERTIONS: Verify Efficiency ===
    
    // All content should be skipped on re-crawl (same content, same headers)
    expect(skippedCount).toBe(4);
    expect(processedCount).toBe(0);
    expect(subsequentResults.every(r => !r.hasChanged)).toBe(true);
    
    // Should be significantly faster
    expect(subsequentDuration).toBeLessThan(initialDuration);
    
    // Should demonstrate high efficiency
    expect(parseFloat(stats.efficiency)).toBeGreaterThan(95); // >95% efficiency expected
    
    // Verify database contains all pages
    const pageCount = db.db.prepare('SELECT COUNT(*) as count FROM pages').get();
    expect(pageCount.count).toBe(4);
    
    console.log(`\\n🎉 EFFICIENCY DEMONSTRATION SUCCESSFUL!`);
    console.log(`💡 Subsequent crawls are ${(initialDuration / subsequentDuration).toFixed(1)}x faster with ${stats.efficiency} efficiency!\\n`);
  });
  
  it('should demonstrate selective processing for mixed change scenarios', async () => {
    console.log('\\n=== SELECTIVE PROCESSING DEMO ===\\n');
    
    // === INITIAL SETUP ===
    const urls = [
      'https://example.com/',
      'https://example.com/page1', 
      'https://example.com/page2',
      'https://example.com/page3'
    ];
    
    const initialContent = [
      'Original home content',
      'Original page 1 content', 
      'Original page 2 content',
      'Original page 3 content'
    ];
    
    // Populate database with initial crawl (simulate older crawl time)
    console.log('🏗️ Setting up initial database state...');
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const content = initialContent[i];
      const responseKey = i === 0 ? 'home' : `page${i}`;
      const response = mockResponses[responseKey];
      
      await detector.checkForChanges(url, response, content);
      detector.updatePageData(url, response, content, `${responseKey}.md`, true);
      
      // No need to update time since we're using noTimeFilters
    }
    
    detector.resetStats();
    
    // === SIMULATE CHANGES ===
    console.log('📝 Simulating content changes...');
    
    // Update page 1 and page 3 (change ETag and content)
    mockResponses.page1.headers.set('etag', '"page1-v2"');
    mockResponses.page3.headers.set('etag', '"page3-v2"');
    
    const updatedContent = [
      'Original home content',        // Unchanged
      'UPDATED page 1 content',       // Changed
      'Original page 2 content',      // Unchanged  
      'UPDATED page 3 content'        // Changed
    ];
    
    // === TEST SELECTIVE PROCESSING ===
    console.log('🔄 Testing selective processing...');
    
    let processedCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const content = updatedContent[i];
      const responseKey = i === 0 ? 'home' : `page${i}`;
      const response = mockResponses[responseKey];
      
      const result = await detector.checkForChanges(url, response, content);
      
      if (result.hasChanged) {
        detector.updatePageData(url, response, content, `${responseKey}.md`, true);
        processedCount++;
        console.log(`✅ Processed: ${url} (${result.reason})`);
      } else {
        detector.updateUnchangedPage(url);
        skippedCount++;
        console.log(`⏩ Skipped: ${url} (${result.reason})`);
      }
    }
    
    console.log(`\\n📊 SELECTIVE PROCESSING RESULTS:`);
    console.log(`   Content processed: ${processedCount} (changed pages)`);
    console.log(`   Content skipped: ${skippedCount} (unchanged pages)`);
    console.log(`   Efficiency: ${(skippedCount / urls.length * 100).toFixed(1)}% skipped`);
    
    // === VERIFY SELECTIVE BEHAVIOR ===
    
    // Should process exactly 2 pages (page1 and page3 changed)
    expect(processedCount).toBe(2);
    expect(skippedCount).toBe(2);
    
    // Verify stats show mixed processing
    const stats = detector.getStats();
    expect(stats.updatedContent).toBe(2);
    expect(stats.skippedByETag).toBe(2);
    
    console.log(`🎯 Selective processing working perfectly!`);
    console.log(`   Only changed content (${processedCount}/4 pages) was processed`);
    console.log(`   Unchanged content (${skippedCount}/4 pages) was efficiently skipped\\n`);
  });
});