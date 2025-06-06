import Database from 'better-sqlite3';

export class CrawlDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT,
        last_crawled TEXT,
        status INTEGER
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

  upsertPage(page) {
    const stmt = this.db.prepare(`
      INSERT INTO pages (url, etag, last_modified, content_hash, last_crawled, status)
      VALUES (@url, @etag, @last_modified, @content_hash, @last_crawled, @status)
      ON CONFLICT(url) DO UPDATE SET
        etag=excluded.etag,
        last_modified=excluded.last_modified,
        content_hash=excluded.content_hash,
        last_crawled=excluded.last_crawled,
        status=excluded.status;
    `);
    stmt.run(page);
  }

  getPage(url) {
    return this.db.prepare('SELECT * FROM pages WHERE url = ?').get(url);
  }

  insertSession(session) {
    const stmt = this.db.prepare(`
      INSERT INTO crawl_sessions (started_at, finished_at, pages_crawled, notes)
      VALUES (@started_at, @finished_at, @pages_crawled, @notes)
    `);
    stmt.run(session);
  }

  close() {
    this.db.close();
  }
}
