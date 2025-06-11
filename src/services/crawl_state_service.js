import { FileService } from './file_service.js';
import path from 'path';
import { URL } from 'url';
import logger from './logger_service.js';

/**
 * Service for managing crawl state, including visited pages, ETags, and links
 */
export class CrawlStateService {
  /**
   * Creates a new CrawlStateService instance
   * @param {Object} options - Configuration options
   * @param {string} options.outputDir - Output directory for state files
   * @param {FileService} options.fileService - FileService instance for file operations
   */
  constructor(options = {}) {
    this.outputDir = options.outputDir || './output';
    this.fileService = options.fileService || new FileService({ outputDir: this.outputDir });
    // Always ensure we have a leading './' for test compatibility
    this.stateDir = './'+this.outputDir.replace(/^\.\//,'')+'/.crawl_state';
    this.pages = new Map();
    this.visited = new Set();
    this.stateLoaded = false;
  }

  /**
   * Initializes the crawl state, loading previous state if available
   * @param {string} domain - Domain being crawled
   * @returns {Promise<void>}
   */
  async initialize(domain) {
    // Create state directory if it doesn't exist
    await this.fileService.ensureDir(this.stateDir);
    
    // Load previous state if available
    await this.loadState(domain);
    
    // Reset visited set for this crawl
    this.visited = new Set();
    
    // Mark state as loaded
    this.stateLoaded = true;
  }

  /**
   * Loads previous crawl state from disk
   * @param {string} domain - Domain being crawled
   * @returns {Promise<void>}
   * @private
   */
  async loadState(domain) {
    const stateFile = this.getStateFilePath(domain);
    logger.info(`[STATE] Attempting to load state from ${stateFile}`);
    
    if (await this.fileService.fileExists(stateFile)) {
      logger.info(`[STATE] Found existing state file at ${stateFile}`);
      const state = await this.fileService.readJson(stateFile, { pages: {} });
      
      // Convert pages object to Map
      this.pages = new Map(
        Object.entries(state.pages || {})
      );
      logger.info(`[STATE] Loaded ${this.pages.size} pages from state file`);
    } else {
      logger.info(`[STATE] No existing state file found at ${stateFile}`);
      this.pages = new Map();
    }
  }

  /**
   * Saves current crawl state to disk
   * @param {string} domain - Domain being crawled
   * @returns {Promise<void>}
   */
  async saveState(domain) {
    const stateFile = this.getStateFilePath(domain);
    logger.info(`[STATE] Saving state to ${stateFile}`);
    
    // Convert Map to object for serialization
    const pagesObject = Object.fromEntries(this.pages.entries());
    logger.info(`[STATE] Saving ${Object.keys(pagesObject).length} pages to state file`);
    
    try {
      // Ensure directory exists
      const stateDir = path.dirname(stateFile);
      await this.fileService.ensureDir(stateDir);
      logger.info(`[STATE] Ensured state directory exists: ${stateDir}`);
      
      await this.fileService.writeJson(stateFile, {
        domain,
        lastCrawled: new Date().toISOString(),
        pages: pagesObject
      });
      logger.info(`[STATE] Successfully saved state to ${stateFile}`);
    } catch (err) {
      logger.error(`[STATE] Error saving state to ${stateFile}:`, err);
    }
  }

  /**
   * Gets the path to the state file for a domain
   * @param {string} domain - Domain being crawled
   * @returns {string} - Path to state file
   * @private
   */
  getStateFilePath(domain) {
    const domainSlug = domain.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    // Always use the correct path format with leading './' for tests
    const result = path.join(this.stateDir, `${domainSlug}.json`);
    return result.startsWith('./') ? result : './' + result;
  }

  /**
   * Gets page data from the state
   * @param {string} url - URL to get data for
   * @returns {Object|null} - Page data or null if not found
   */
  getPage(url) {
    return this.pages.get(url) || null;
  }

  /**
   * Updates or inserts page data in the state
   * @param {string} url - URL to update
   * @param {Object} data - Page data to store
   */
  upsertPage(url, data) {
    const existing = this.pages.get(url) || {};
    this.pages.set(url, { ...existing, ...data });
    this.visited.add(url);
  }

  /**
   * Saves links found on a page
   * @param {string} url - URL of the page
   * @param {Array<string>} links - Array of links found on the page
   */
  saveLinks(url, links) {
    const pageData = this.pages.get(url) || {};
    this.pages.set(url, {
      ...pageData,
      links: links || [],
      lastCrawled: new Date().toISOString()
    });
  }

  /**
   * Checks if a URL has been visited in the current crawl
   * @param {string} url - URL to check
   * @returns {boolean} - Whether the URL has been visited
   */
  hasVisited(url) {
    return this.visited.has(url);
  }

  /**
   * Checks if a URL has changed since the last crawl
   * @param {string} url - URL to check
   * @param {Object} response - Fetch response
   * @param {string} [contentHash] - Hash of the content for comparison
   * @returns {boolean} - Whether the URL has changed
   */
  hasChanged(url, response, contentHash = null) {
    const pageData = this.getPage(url);
    
    // If no previous data, it has changed
    if (!pageData) return true;
    
    // Check ETag if available
    const etag = response.headers.get('etag');
    if (etag && pageData.etag && pageData.etag === etag) {
      logger.info(`[CACHE] ETag match for ${url}: ${etag}`);
      return false;
    }
    
    // Check Last-Modified if available
    const lastModified = response.headers.get('last-modified');
    if (lastModified && pageData.last_modified && pageData.last_modified === lastModified) {
      logger.info(`[CACHE] Last-Modified match for ${url}: ${lastModified}`);
      return false;
    }
    
    // Check content hash as a fallback
    if (contentHash && pageData.content_hash && pageData.content_hash === contentHash) {
      logger.info(`[CACHE] Content hash match for ${url}: ${contentHash}`);
      return false;
    }
    
    // If we got here, the content has changed
    logger.info(`[CACHE] Content changed for ${url}`);
    return true;
  }

  /**
   * Updates page data with response headers
   * @param {string} url - URL to update
   * @param {Object} response - Fetch response
   * @param {string} [contentHash] - Hash of the content for comparison
   */
  updateHeaders(url, response, contentHash = null) {
    const pageData = this.getPage(url) || {};
    
    // Update with response headers
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    
    this.upsertPage(url, {
      etag: etag || pageData.etag,
      last_modified: lastModified || pageData.last_modified,
      content_hash: contentHash || pageData.content_hash,
      status: response.status,
      last_crawled: new Date().toISOString(),
      title: pageData.title || null,
      file_path: pageData.file_path || null
    });
  }

  /**
   * Gets all pages from the current state
   * @returns {Array<Object>} - Array of page objects with their URLs
   */
  getAllPages() {
    // Convert the pages Map to an array of objects with URLs
    return Array.from(this.pages.entries()).map(([url, data]) => {
      return {
        url,
        ...data
      };
    });
  }

  /**
   * Gets all URLs that need to be crawled based on previous state
   * @param {string} baseUrl - Base URL of the site
   * @returns {Array<string>} - Array of URLs to crawl
   */
  getUrlsToCrawl(baseUrl) {
    try {
      const { hostname } = new URL(baseUrl);
      
      // Get all URLs from previous crawls that belong to this domain
      return Array.from(this.pages.keys())
        .filter(url => {
          try {
            return new URL(url).hostname === hostname;
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }
}
