import Database from 'better-sqlite3';
// db_block_selectors.js
// Adds selector learning to the crawl DB.

export class SelectorDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.initSchema();
  }
  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block_selectors (
        selector TEXT PRIMARY KEY,
        keep_count INTEGER DEFAULT 0,
        delete_count INTEGER DEFAULT 0,
        last_seen TEXT
      );
    `);
  }
  recordSelector(selector, action) {
    const now = new Date().toISOString();
    // Upsert and increment the correct counter
    if (action === 'keep') {
      this.db
        .prepare(
          `
        INSERT INTO block_selectors (selector, keep_count, delete_count, last_seen)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(selector) DO UPDATE SET
          keep_count = keep_count + 1,
          last_seen = excluded.last_seen
      `
        )
        .run(selector, now);
    } else if (action === 'delete') {
      this.db
        .prepare(
          `
        INSERT INTO block_selectors (selector, keep_count, delete_count, last_seen)
        VALUES (?, 0, 1, ?)
        ON CONFLICT(selector) DO UPDATE SET
          delete_count = delete_count + 1,
          last_seen = excluded.last_seen
      `
        )
        .run(selector, now);
    }
  }
  getSelectors(minCount = 3) {
    // Returns selectors with at least minCount for either keep or delete
    return this.db
      .prepare(
        `SELECT selector, keep_count, delete_count, last_seen FROM block_selectors WHERE keep_count >= ? OR delete_count >= ?`
      )
      .all(minCount, minCount);
  }
  getActionForSelector(selector) {
    // Returns {action: 'keep'|'delete'|'ambiguous', keep_count, delete_count}, or null if not found
    const row = this.db
      .prepare(`SELECT keep_count, delete_count FROM block_selectors WHERE selector = ?`)
      .get(selector);
    if (!row) return null;
    const total = (row.keep_count || 0) + (row.delete_count || 0);
    if (total < 10) return {action: 'ambiguous', ...row};
    if (row.keep_count / total >= 0.9) return {action: 'keep', ...row};
    if (row.delete_count / total >= 0.9) return {action: 'delete', ...row};
    return {action: 'ambiguous', ...row};
  }
  close() {
    this.db.close();
  }
}
