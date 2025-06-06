// CrawlState interface (JSDoc style)
/**
 * @interface CrawlState
 * getPage(url: string): PageRecord | undefined
 * upsertPage(page: PageRecord): void
 */

// DefaultCrawlState wraps CrawlDB to provide the interface
export class DefaultCrawlState {
  constructor(db) {
    this.db = db;
  }
  getPage(url) {
    return this.db.getPage(url);
  }
  upsertPage(page) {
    return this.db.upsertPage(page);
  }
}

// PageRecord type (for reference)
/**
 * @typedef {Object} PageRecord
 * @property {string} url
 * @property {string} [etag]
 * @property {string} [last_modified]
 * @property {string} [content_hash]
 * @property {string} [last_crawled]
 * @property {number} [status]
 */
