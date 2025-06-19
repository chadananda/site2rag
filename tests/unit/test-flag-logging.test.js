import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDB } from '../../src/db.js';
import { FastChangeDetector, createFastChangeDetector } from '../../src/services/fast_change_detector.js';
import logger from '../../src/services/logger_service.js';

/**
 * Test suite for --test flag logging functionality
 * Verifies that detailed skip/download decision logging works correctly
 */
describe('Test Flag Logging', () => {
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp', 'unit-test-flag-logging');
  let db;
  let detector;
  let logSpy;
  let loggedMessages;
  
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    // Create database and change detector with test mode enabled
    db = getDB(path.join(TEST_DIR, 'db', 'crawl.db'));
    detector = createFastChangeDetector.aggressive(db, true); // Enable test mode
    
    // Spy on logger to capture test messages
    loggedMessages = [];
    logSpy = vi.spyOn(logger, 'info').mockImplementation((message) => {
      loggedMessages.push(message);
    });
  });
  
  afterEach(() => {
    if (logSpy) {
      logSpy.mockRestore();
    }
    
    if (db) {
      db.finalizeSession();
      db.close();
    }
    
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
  
  it('should log detailed skip decisions for age filter', async () => {
    const url = 'https://example.com/recent';
    
    // Create a page that was crawled 12 hours ago (less than 24h minAge for aggressive config)
    const recentTime = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    db.upsertPage({
      url,
      etag: '\"abc123\"',
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
        ['etag', '\"def456\"'],
        ['last-modified', 'Thu, 22 Oct 2015 07:28:00 GMT']
      ])
    };
    
    const result = await detector.checkForChanges(url, mockResponse, 'new content');
    
    // Verify skip decision
    expect(result.hasChanged).toBe(false);
    expect(result.reason).toBe('age_filter');
    
    // Verify test mode logging
    const testMessages = loggedMessages.filter(msg => msg.includes('[TEST]'));
    expect(testMessages.length).toBeGreaterThan(3); // Should have at least 4 messages
    
    // Check for key test messages
    expect(testMessages.some(msg => msg.includes(`[TEST] Checking ${url} for changes`))).toBe(true);
    expect(testMessages.some(msg => msg.includes('[TEST] - Found existing page'))).toBe(true);
    expect(testMessages.some(msg => msg.includes('[TEST] - Existing ETag: "abc123"'))).toBe(true);
    expect(testMessages.some(msg => msg.includes('[TEST] ❌ SKIPPED:') && msg.includes('Age filter'))).toBe(true);
  });
  
  it('should log detailed skip decisions for ETag match', async () => {
    const url = 'https://example.com/etag-match';
    
    // Create a page that was crawled 48 hours ago (older than 24h minAge for aggressive config)
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.upsertPage({
      url,
      etag: '\"unchanged123\"',
      last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
      content_hash: 'hash123',
      last_crawled: oldTime,
      status: 200,
      title: 'Test Page',
      file_path: 'test.md'
    });
    
    // Mock response with same ETag
    const mockResponse = {
      headers: new Map([
        ['etag', '\"unchanged123\"'],
        ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
      ])
    };
    
    const result = await detector.checkForChanges(url, mockResponse, 'same content');
    
    // Verify skip decision
    expect(result.hasChanged).toBe(false);
    expect(result.reason).toBe('etag_match');
    
    // Verify test mode logging
    const testMessages = loggedMessages.filter(msg => msg.includes('[TEST]'));
    expect(testMessages.length).toBeGreaterThan(3);
    
    // Check for ETag match skip message
    const skipMessage = testMessages.find(msg => msg.includes('❌ SKIPPED') && msg.includes('ETag match'));
    expect(skipMessage).toBeTruthy();
    expect(skipMessage).toContain('ETag match: "unchanged123"');
  });
  
  it('should log detailed download decisions for new content', async () => {
    const url = 'https://example.com/new-content';
    
    // Mock response for new content (no existing page)
    const mockResponse = {
      headers: new Map([
        ['etag', '\"new123\"'],
        ['last-modified', 'Thu, 22 Oct 2015 07:28:00 GMT']
      ])
    };
    
    const result = await detector.checkForChanges(url, mockResponse, 'brand new content');
    
    // Verify download decision
    expect(result.hasChanged).toBe(true);
    expect(result.reason).toBe('new_content');
    expect(result.isNew).toBe(true);
    
    // Verify test mode logging
    const testMessages = loggedMessages.filter(msg => msg.includes('[TEST]'));
    expect(testMessages.length).toBeGreaterThan(2);
    
    // Check for new content download message
    const downloadMessage = testMessages.find(msg => msg.includes('✅ DOWNLOAD') && msg.includes('New content'));
    expect(downloadMessage).toBeTruthy();
    expect(downloadMessage).toContain('will process through AI');
  });
  
  it('should log detailed download decisions for updated content', async () => {
    const url = 'https://example.com/updated-content';
    
    // Create existing page with old ETag
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.upsertPage({
      url,
      etag: '\"old123\"',
      last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
      content_hash: 'oldhash',
      last_crawled: oldTime,
      status: 200,
      title: 'Test Page',
      file_path: 'test.md'
    });
    
    // Mock response with new ETag
    const mockResponse = {
      headers: new Map([
        ['etag', '\"new456\"'],
        ['last-modified', 'Thu, 22 Oct 2015 07:28:00 GMT']
      ])
    };
    
    const result = await detector.checkForChanges(url, mockResponse, 'updated content');
    
    // Verify download decision
    expect(result.hasChanged).toBe(true);
    expect(result.reason).toBe('content_updated');
    expect(result.isNew).toBe(false);
    
    // Verify test mode logging
    const testMessages = loggedMessages.filter(msg => msg.includes('[TEST]'));
    expect(testMessages.length).toBeGreaterThan(3);
    
    // Check for ETag change message
    const etagChangeMessage = testMessages.find(msg => msg.includes('ETag changed'));
    expect(etagChangeMessage).toBeTruthy();
    expect(etagChangeMessage).toContain('"old123" → "new456"');
    
    // Check for updated content download message
    const downloadMessage = testMessages.find(msg => msg.includes('✅ DOWNLOAD') && msg.includes('Content updated'));
    expect(downloadMessage).toBeTruthy();
    expect(downloadMessage).toContain('will process through AI');
  });
  
  it('should log detailed skip decisions for content hash match', async () => {
    const url = 'https://example.com/hash-match';
    const content = 'This is the exact same content';
    
    // Create existing page with content hash but no HTTP cache headers
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.upsertPage({
      url,
      etag: '',
      last_modified: '',
      content_hash: detector._calculateContentHash(content),
      last_crawled: oldTime,
      status: 200,
      title: 'Test Page',
      file_path: 'test.md'
    });
    
    // Mock response without cache headers
    const mockResponse = {
      headers: new Map()
    };
    
    const result = await detector.checkForChanges(url, mockResponse, content);
    
    // Verify skip decision
    expect(result.hasChanged).toBe(false);
    expect(result.reason).toBe('content_hash_match');
    
    // Verify test mode logging
    const testMessages = loggedMessages.filter(msg => msg.includes('[TEST]'));
    expect(testMessages.length).toBeGreaterThan(3);
    
    // Check for content hash match skip message
    const skipMessage = testMessages.find(msg => msg.includes('❌ SKIPPED') && msg.includes('Content hash match'));
    expect(skipMessage).toBeTruthy();
  });
  
  it('should provide comprehensive logging summary for reproducible testing', async () => {
    // Create a fresh database to avoid interference from other tests
    if (db) {
      db.finalizeSession();
      db.close();
    }
    
    // Create new database and detector for this test
    const comprehensiveDbDir = path.join(TEST_DIR, 'comprehensive-test', 'db');
    if (!fs.existsSync(comprehensiveDbDir)) fs.mkdirSync(comprehensiveDbDir, { recursive: true });
    db = getDB(path.join(comprehensiveDbDir, 'crawl.db'));
    detector = createFastChangeDetector.aggressive(db, true); // Enable test mode
    
    // Test multiple scenarios to demonstrate comprehensive logging
    const scenarios = [
      {
        url: 'https://example.com/scenario-recent',
        age: 12, // 12 hours ago - should skip by age
        etag: '\"same\"',
        expected: 'age_filter',
        createPage: true
      },
      {
        url: 'https://example.com/scenario-etag',
        age: 48, // 48 hours ago - passes age filter
        etag: '\"same\"',
        expected: 'etag_match',
        createPage: true
      },
      {
        url: 'https://example.com/scenario-new',
        age: 0, // New content
        etag: '\"new\"',
        expected: 'new_content',
        createPage: false // Don't create page for new content test
      }
    ];
    
    const baseTime = Date.now();
    
    // Set up test data
    for (const scenario of scenarios) {
      if (scenario.createPage) {
        db.upsertPage({
          url: scenario.url,
          etag: scenario.etag === '\"same\"' ? '\"existing\"' : '',
          last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          content_hash: 'existinghash',
          last_crawled: new Date(baseTime - scenario.age * 60 * 60 * 1000).toISOString(),
          status: 200,
          title: 'Test Page',
          file_path: 'test.md'
        });
      }
    }
    
    // Reset logged messages for this test
    loggedMessages.length = 0;
    
    // Test each scenario
    const results = [];
    for (const scenario of scenarios) {
      const mockResponse = {
        headers: new Map([
          ['etag', scenario.etag === '\"same\"' ? '\"existing\"' : scenario.etag]
        ])
      };
      
      const result = await detector.checkForChanges(scenario.url, mockResponse, 'test content');
      results.push({
        url: scenario.url,
        expected: scenario.expected,
        actual: result.reason,
        hasChanged: result.hasChanged
      });
      
      // Debug logging
      console.log(`Scenario: ${scenario.url}, Expected: ${scenario.expected}, Actual: ${result.reason}`);
    }
    
    // Verify all scenarios worked as expected
    results.forEach(result => {
      expect(result.actual).toBe(result.expected);
    });
    
    // Verify comprehensive test logging was generated
    const testMessages = loggedMessages.filter(msg => msg.includes('[TEST]'));
    expect(testMessages.length).toBeGreaterThan(10); // Should have many detailed messages
    
    // Check that we have both skip and download messages
    const skipMessages = testMessages.filter(msg => msg.includes('❌ SKIPPED'));
    const downloadMessages = testMessages.filter(msg => msg.includes('✅ DOWNLOAD'));
    
    expect(skipMessages.length).toBe(2); // Age filter + ETag match
    expect(downloadMessages.length).toBe(1); // New content
    
    logger.info('=== TEST REPRODUCIBILITY SUMMARY ===');
    logger.info(`Total scenarios tested: ${results.length}`);
    logger.info(`Total test messages generated: ${testMessages.length}`);
    logger.info(`Skip decisions: ${skipMessages.length}`);
    logger.info(`Download decisions: ${downloadMessages.length}`);
    logger.info('All scenarios behaved as expected - functionality is reproducible!');
  });
});