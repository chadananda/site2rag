import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CrawlDB } from '../../src/db.js';

const TEST_DIR = path.join(process.cwd(), 'tests', 'tmpdb');
const DB_PATH = path.join(TEST_DIR, 'test.db');

beforeEach(() => {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR);
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});
afterEach(() => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

describe('CrawlDB', () => {
  it('creates schema and allows upsert/query for pages', () => {
    const db = new CrawlDB(DB_PATH);
    db.upsertPage({
      url: 'https://oceanoflights.org',
      etag: 'abc',
      last_modified: 'yesterday',
      content_hash: 'hash',
      last_crawled: 'now',
      status: 1,
      title: 'Test Title',
      file_path: '/tmp/test.md'
    });
    const row = db.getPage('https://oceanoflights.org');
    expect(row).toBeDefined();
    expect(row.url).toBe('https://oceanoflights.org');
    db.close();
  });

  it('inserts crawl sessions', () => {
    const db = new CrawlDB(DB_PATH);
    db.insertSession({
      started_at: '2025-06-06T18:30',
      finished_at: '2025-06-06T18:31',
      pages_crawled: 5,
      notes: 'test session'
    });
    // Should not throw
    db.close();
  });
});
