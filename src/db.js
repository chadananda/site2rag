import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';

/**
 * Database utility functions for Site2RAG
 * Handles database connections, integrity checks, and session management
 */



/**
 * Get paths for all database files based on a normalized base path
 * @param {string} dbDir - The database directory path
 * @returns {Object} - Object containing all related database paths
 */
export function getDbPaths(dbDir) {
  return {
    main: path.join(dbDir, 'crawl.db'),
    prev: path.join(dbDir, 'crawl_prev.db'),
    session: path.join(dbDir, 'crawl_new.db'),
    backup: path.join(dbDir, 'crawl.db.bak')
  };
}

/**
 * Check database integrity
 * @param {string} dbPath - Path to database file
 * @returns {boolean} - True if database is valid
 */
export function checkDbIntegrity(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  
  try {
    const db = new Database(dbPath);
    const res = db.pragma('integrity_check', { simple: true });
    db.close();
    return res === 'ok';
  } catch (e) {
    console.warn(`[DB] Error checking integrity of ${dbPath}:`, e);
    return false;
  }
}

/**
 * Initialize database schema
 * @param {Database} db - SQLite database instance
 */
export function initDbSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      etag TEXT,
      last_modified TEXT,
      content_hash TEXT,
      last_crawled TEXT,
      status INTEGER,
      title TEXT DEFAULT NULL,
      file_path TEXT DEFAULT NULL,
      content_status TEXT DEFAULT 'raw',            -- 'raw', 'contexted', etc.
      is_pdf INTEGER DEFAULT 0,                     -- 1 if PDF, 0 otherwise
      pdf_conversion_status TEXT DEFAULT NULL,      -- 'pending', 'converted', 'failed'
      pdf_md_path TEXT DEFAULT NULL                 -- path to converted markdown
    );
    CREATE TABLE IF NOT EXISTS assets (
      url TEXT PRIMARY KEY,
      type TEXT,
      local_path TEXT,
      last_crawled TEXT
    );
    CREATE TABLE IF NOT EXISTS crawl_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      finished_at TEXT,
      pages_crawled INTEGER,
      notes TEXT
    );
  `);
}

/**
 * Get database instance with proper session management
 * @param {string} dbPath - Path to the database file
 * @param {Object} opts - Options
 * @returns {CrawlDB} - Database instance
 */
export function getDB(dbPath, opts = {}) {
  // Ensure parent directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    console.log(`Creating database directory: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  // Use the normalized directory path to get fixed database paths
  // This prevents creating deeply nested directories with absolute paths
  const normalizedDir = path.normalize(dbDir);
  const paths = getDbPaths(normalizedDir);
  
  console.log(`Database paths:\n- Main: ${paths.main}\n- Session: ${paths.session}\n- Previous: ${paths.prev}`);
  
  // Check if main DB is valid and copy to session DB if it is
  const mainValid = checkDbIntegrity(paths.main);
  if (mainValid) {
    fs.copyFileSync(paths.main, paths.session);
  } else if (fs.existsSync(paths.session)) {
    try { fs.unlinkSync(paths.session); } catch {}
  }
  
  // Open session DB for writing, with recovery from previous if needed
  let dbInstance;
  let dbReady = false;
  
  while (!dbReady) {
    try {
      dbInstance = new Database(paths.session);
      const res = dbInstance.pragma('integrity_check', { simple: true });
      
      if (res !== 'ok') {
        console.error('[DB] Corruption detected in session DB - attempting recovery...');
        dbInstance.close();
        
        // Try to recover from previous DB
        if (recoverFromPrevDb(paths.prev, paths.session)) {
          continue;
        }
        
        // If recovery failed, create new DB
        try { fs.unlinkSync(paths.session); } catch {}
        console.warn('[DB] Created new session DB after corruption.');
        continue;
      }
      
      dbReady = true;
    } catch (err) {
      console.error('[DB] Error opening session DB:', err);
      
      // Try to recover from previous DB
      if (recoverFromPrevDb(paths.prev, paths.session)) {
        continue;
      }
      
      // If recovery failed, create new DB
      try { fs.unlinkSync(paths.session); } catch {}
      console.warn('[DB] Created new session DB after error.');
    }
  }
  
  // Initialize schema
  initDbSchema(dbInstance);
  
  // Create CrawlDB instance
  return new CrawlDB(paths, dbInstance);
}

/**
 * Recover from previous database
 * @param {string} prevPath - Path to previous database
 * @param {string} sessionPath - Path to session database
 * @returns {boolean} - True if recovery was successful
 */
export function recoverFromPrevDb(prevPath, sessionPath) {
  if (fs.existsSync(prevPath)) {
    try {
      const prevDb = new Database(prevPath);
      const prevRes = prevDb.pragma('integrity_check', { simple: true });
      prevDb.close();
      
      if (prevRes === 'ok') {
        fs.copyFileSync(prevPath, sessionPath);
        console.warn('[DB] Restored session DB from previous DB.');
        return true;
      } else {
        console.error('[DB] Previous DB is also corrupt. Deleting it.');
        try { fs.unlinkSync(prevPath); } catch {}
      }
    } catch (e) {
      console.error('[DB] Error reading previous DB:', e);
      try { fs.unlinkSync(prevPath); } catch {}
    }
  }
  
  return false;
}

/**
 * Database class for crawl operations
 */
export class CrawlDB {
  /**
   * Create a new CrawlDB instance
   * @param {Object} paths - Database paths
   * @param {Database} dbInstance - SQLite database instance
   */
  constructor(paths, dbInstance) {
    this.paths = paths;
    this.db = dbInstance;
    
    // Create backup of main DB if it exists
    if (fs.existsSync(this.paths.main)) {
      this.createBackup();
    }
  }
  
  /**
   * Create a backup of the main database
   * @returns {boolean} - True if backup was successful
   */
  createBackup() {
    try {
      fs.copyFileSync(this.paths.main, this.paths.backup);
      return true;
    } catch (e) {
      console.error('[CrawlDB] Failed to create backup:', e);
      return false;
    }
  }
  
  /**
   * Recover from backup
   * @returns {boolean} - True if recovery was successful
   */
  recoverFromBackup() {
    try {
      // Check backup integrity
      const backupDb = new Database(this.paths.backup);
      const res = backupDb.pragma('integrity_check', { simple: true });
      backupDb.close();
      
      if (res === 'ok') {
        fs.copyFileSync(this.paths.backup, this.paths.main);
        console.warn('[CrawlDB] Restored DB from backup.');
        return true;
      } else {
        console.error('[CrawlDB] Backup is also corrupt. Deleting both DB and backup.');
      }
    } catch (e) {
      console.error('[CrawlDB] Error reading backup:', e);
    }
    
    try { fs.unlinkSync(this.paths.backup); } catch {}
    try { fs.unlinkSync(this.paths.main); } catch {}
    console.warn('[CrawlDB] Created new DB after corruption.');
    return false;
  }
  
  /**
   * Insert or update a page in the database
   * @param {Object} page - Page data
   */
  upsertPage(page) {
    // Ensure optional fields are always present for SQL binding
    if (!('title' in page)) page.title = null;
    if (!('file_path' in page)) page.file_path = null;
    
    // Debug: Log upsert for test traceability
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      console.log('[DB][upsertPage] Upserting page:', JSON.stringify(page));
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO pages (url, etag, last_modified, content_hash, last_crawled, status, title, file_path)
      VALUES (@url, @etag, @last_modified, @content_hash, @last_crawled, @status, @title, @file_path)
      ON CONFLICT(url) DO UPDATE SET
        etag=excluded.etag,
        last_modified=excluded.last_modified,
        content_hash=excluded.content_hash,
        last_crawled=excluded.last_crawled,
        status=excluded.status,
        title=excluded.title,
        file_path=excluded.file_path;
    `);
    
    stmt.run(page);
    
    // Debug: Confirm page is now in DB
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      const check = this.getPage(page.url);
      console.log('[DB][upsertPage] DB now has:', JSON.stringify(check));
    }
  }
  
  /**
   * Get a page from the database
   * @param {string} url - Page URL
   * @returns {Object|undefined} - Page data or undefined if not found
   */
  getPage(url) {
    return this.db.prepare('SELECT * FROM pages WHERE url = ?').get(url);
  }
  
  /**
   * Insert a crawl session
   * @param {Object} session - Session data
   */
  insertSession(session) {
    const stmt = this.db.prepare(`
      INSERT INTO crawl_sessions (started_at, finished_at, pages_crawled, notes)
      VALUES (@started_at, @finished_at, @pages_crawled, @notes)
    `);
    
    stmt.run(session);
  }
  
  /**
   * Close the database connection
   */
  close() {
    this.db.close();
  }
  
  /**
   * Finalize the crawl session
   * 1. Rename crawl.db to crawl_prev.db (overwrite if needed)
   * 2. Rename crawl_new.db to crawl.db
   * @returns {boolean} - True if finalization was successful
   */
  finalizeSession() {
    // First close the database if it's open
    try {
      this.close();
    } catch (e) {
      console.warn('[CrawlDB] Error closing database:', e);
      // Continue anyway
    }
    
    console.log('[CrawlDB] Finalizing session...');
    console.log(`- Current DB: ${this.paths.main}`);
    console.log(`- Session DB: ${this.paths.session}`);
    console.log(`- Previous DB: ${this.paths.prev}`);
    
    // Check if the session DB exists and is valid
    let sessionValid = checkDbIntegrity(this.paths.session);
    
    if (!sessionValid) {
      console.error('[CrawlDB] Session DB is invalid, cannot finalize');
      return false;
    }
    
    // Ensure parent directory exists for all files
    const dbDir = path.dirname(this.paths.main);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // 1. Backup current DB to prev if it exists
    if (fs.existsSync(this.paths.main)) {
      try {
        // Ensure we can delete the previous backup if it exists
        if (fs.existsSync(this.paths.prev)) {
          try {
            fs.unlinkSync(this.paths.prev);
            console.log(`[CrawlDB] Removed old backup: ${this.paths.prev}`);
          } catch (e) {
            console.error(`[CrawlDB] Error removing old backup: ${e.message}`);
            // Continue anyway
          }
        }
        
        // Now rename current to prev (atomic operation)
        fs.renameSync(this.paths.main, this.paths.prev);
        console.log(`[CrawlDB] Backed up current DB to: ${this.paths.prev}`);
      } catch (e) {
        console.error(`[CrawlDB] Error backing up current DB: ${e.message}`);
        // Continue anyway - we still want to try to promote the session DB
      }
    }
    
    // 2. Rename session DB to current DB
    try {
      fs.renameSync(this.paths.session, this.paths.main);
      console.log(`[CrawlDB] Promoted session DB to: ${this.paths.main}`);
      return true;
    } catch (e) {
      console.error(`[CrawlDB] Error promoting session DB: ${e.message}`);
      return false;
    }
  }
}
