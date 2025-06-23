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
      // Ensure required fields are never null
      const safeData = {
        ...url,
        etag: url.etag || '',
        last_modified: url.last_modified || '',
        content_hash: url.content_hash || '',
        last_crawled: url.last_crawled || new Date().toISOString(),
        status: url.status !== undefined ? url.status : 0
      };
      return this.db.upsertPage(safeData);
    }

    // Otherwise, combine url and data into a single page object with safe defaults
    const safeData = {
      url,
      ...data,
      etag: (data && data.etag) || '',
      last_modified: (data && data.last_modified) || '',
      content_hash: (data && data.content_hash) || '',
      last_crawled: (data && data.last_crawled) || new Date().toISOString(),
      status: data && data.status !== undefined ? data.status : 0
    };
    return this.db.upsertPage(safeData);
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
