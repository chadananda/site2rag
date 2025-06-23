// tests/testUtils.js
import {getDB} from '../src/db.js';
// All DB access must use getDB() from src/db.js. Never instantiate CrawlDB directly.
import fs from 'fs';

/**
 * Returns a CrawlDB instance at the given path (default in-memory for tests).
 * Ensures schema is initialized. Safe to call multiple times.
 * @param {string} [dbPath=':memory:']
 * @returns {CrawlDB}
 */
export function getDB(dbPath = ':memory:') {
  // Remove file if exists for clean state (test only)
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  const db = new CrawlDB(dbPath);
  // CrawlDB constructor already calls initSchema()
  return db;
}
