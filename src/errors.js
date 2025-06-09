/**
 * Custom error for when the crawl limit has been reached
 */
export class CrawlLimitReached extends Error {
  constructor(message = 'Crawl limit reached') {
    super(message);
    this.name = 'CrawlLimitReached';
  }
}

/**
 * Custom error for when the crawl is aborted
 */
export class CrawlAborted extends Error {
  constructor(message = 'Crawl aborted') {
    super(message);
    this.name = 'CrawlAborted';
  }
}

/**
 * Custom error for when a URL is invalid
 */
export class InvalidUrlError extends Error {
  constructor(url, message = `Invalid URL: ${url}`) {
    super(message);
    this.name = 'InvalidUrlError';
    this.url = url;
  }
}
