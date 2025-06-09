// CrawlState interface (JSDoc style)
/**
 * @interface CrawlState
 * getPage(url: string): PageRecord | undefined
 * upsertPage(url: string, data: object): void
 */

// DefaultCrawlState wraps CrawlDB to provide the interface
export class DefaultCrawlState {
  constructor(db) {
    this.db = db;
  }
  getPage(url) {
    return this.db.getPage(url);
  }
  upsertPage(url, data) {
    // If the first argument is an object with a url property, assume it's a page object
    if (typeof url === 'object' && url !== null && 'url' in url) {
      return this.db.upsertPage(url);
    }
    
    // Otherwise, combine url and data into a single page object
    return this.db.upsertPage({ url, ...data });
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
