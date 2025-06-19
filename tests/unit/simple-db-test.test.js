import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDB } from '../../src/db.js';

/**
 * Simple test for database functionality
 */
describe('Simple Database Test', () => {
  const TEST_DIR = path.join(process.cwd(), 'tests', 'tmp', 'simple-db');
  const DB_PATH = path.join(TEST_DIR, 'db', 'crawl.db'); // Updated to match new pattern
  
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });
  
  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
  
  it('should create database and save/retrieve pages', () => {
    // Create database with proper subdirectory structure
    const db = getDB(path.join(TEST_DIR, 'db', 'crawl.db'));
    
    // Verify database exists
    expect(db).toBeTruthy();
    expect(db.db).toBeTruthy();
    
    // Test saving a page
    const pageData = {
      url: 'https://example.com',
      etag: '"abc123"',
      last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
      content_hash: 'hash123',
      last_crawled: new Date().toISOString(),
      status: 200,
      title: 'Test Page',
      file_path: 'test.md'
    };
    
    db.upsertPage(pageData);
    
    // Test retrieving the page
    const retrievedPage = db.getPage('https://example.com');
    expect(retrievedPage).toBeTruthy();
    expect(retrievedPage.url).toBe('https://example.com');
    expect(retrievedPage.etag).toBe('"abc123"');
    expect(retrievedPage.content_hash).toBe('hash123');
    expect(retrievedPage.status).toBe(200);
    
    // Test database count
    const count = db.db.prepare('SELECT COUNT(*) as count FROM pages').get();
    expect(count.count).toBe(1);
    
    // Finalize session
    db.finalizeSession();
    
    // Check what files actually exist
    const files = fs.readdirSync(TEST_DIR);
    console.log('Files in test directory:', files);
    console.log('DB_PATH:', DB_PATH);
    console.log('Session DB (crawl_new.db) exists:', fs.existsSync(path.join(TEST_DIR, 'crawl_new.db')));
    console.log('Main DB (crawl.db) exists:', fs.existsSync(path.join(TEST_DIR, 'crawl.db')));
    
    // Debug: Check what database the instance is actually connected to
    console.log('Database instance name:', db.db.name);
    
    // Verify database file exists after finalization
    expect(fs.existsSync(DB_PATH)).toBe(true);
    
    db.close();
  });
  
  it('should handle database recovery after finalization', () => {
    // First session - create and save data
    let db = getDB(path.join(TEST_DIR, 'db', 'crawl.db'));
    
    const pageData = {
      url: 'https://example.com/page1',
      etag: '',
      last_modified: '',
      content_hash: 'hash1',
      last_crawled: new Date().toISOString(),
      status: 200,
      title: null,
      file_path: null
    };
    
    db.upsertPage(pageData);
    db.finalizeSession();
    db.close();
    
    // Second session - should load existing data
    db = getDB(path.join(TEST_DIR, 'db', 'crawl.db'));
    
    const retrievedPage = db.getPage('https://example.com/page1');
    expect(retrievedPage).toBeTruthy();
    expect(retrievedPage.url).toBe('https://example.com/page1');
    expect(retrievedPage.content_hash).toBe('hash1');
    
    // Verify count
    const count = db.db.prepare('SELECT COUNT(*) as count FROM pages').get();
    expect(count.count).toBe(1);
    
    db.finalizeSession();
    db.close();
  });
});