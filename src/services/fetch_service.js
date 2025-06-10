import fetch from 'node-fetch';
import robotsParser from 'robots-parser';
import { URL } from 'url';
import logger from './logger_service.js';

/**
 * Service for handling HTTP requests, conditional fetching, and robots.txt compliance
 */
export class FetchService {
  /**
   * Creates a new FetchService instance
   * @param {Object} options - Configuration options
   * @param {number} options.politeDelay - Delay between requests in milliseconds (default: 1000)
   * @param {string} options.userAgent - User agent string for requests (default: 'site2rag-crawler')
   */
  constructor(options = {}) {
    this.politeDelay = options.politeDelay || 500; // Reduced from 1000ms to 500ms
    this.lastFetchStartedAt = null;
    this.robots = null;
    this.userAgent = options.userAgent || 'site2rag-crawler';
    this.activeControllers = new Set(); // Track AbortControllers
  }

  /**
   * Applies a polite delay between requests to avoid overloading servers
   * @returns {Promise<void>}
   */
  async applyPoliteDelay() {
    const now = Date.now();
    if (this.lastFetchStartedAt) {
      const elapsed = now - this.lastFetchStartedAt;
      if (elapsed < this.politeDelay) {
        await new Promise(res => setTimeout(res, this.politeDelay - elapsed));
      }
    }
    this.lastFetchStartedAt = Date.now();
  }

  /**
   * Fetches robots.txt for a domain and initializes the robots parser
   * @param {string} domain - Domain to fetch robots.txt from
   * @returns {Promise<boolean>} - Whether robots.txt was successfully fetched
   */
  async fetchRobotsTxt(domain) {
    try {
      const robotsUrl = new URL('/robots.txt', domain).href;
      const res = await fetch(robotsUrl, { 
        headers: { 'User-Agent': this.userAgent },
        timeout: 5000
      });
      
      if (res.ok) {
        const content = await res.text();
        this.robots = robotsParser(robotsUrl, content);
        return true;
      }
      return false;
    } catch (e) {
      logger.info(`[FETCH] Error fetching robots.txt: ${e.message}`);
      return false;
    }
  }

  /**
   * Checks if a URL can be crawled according to robots.txt
   * @param {string} url - URL to check
   * @returns {boolean} - Whether the URL can be crawled
   */
  canCrawl(url) {
    if (!this.robots) return true;
    return this.robots.isAllowed(url, this.userAgent);
  }

  /**
   * Creates an AbortController for fetch requests
   * @returns {AbortController} - New AbortController instance
   * @protected - Exposed for testing
   */
  createController() {
    return new AbortController();
  }

  /**
   * Fetches a URL with conditional request headers if previous crawl data exists
   * @param {string} url - URL to fetch
   * @param {Object} options - Fetch options
   * @param {Object} options.headers - Additional headers to include
   * @param {number} options.timeout - Request timeout in milliseconds
   * @returns {Promise<Response>} - Fetch response
   */
  async fetchUrl(url, options = {}) {
    logger.info(`FetchService.fetchUrl: Fetching ${url}`);
    await this.applyPoliteDelay();
    
    const controller = this.createController();
    this.activeControllers.add(controller);
    
    try {
      const headers = {
        'User-Agent': this.userAgent,
        ...options.headers
      };
      
      // Only log headers in debug mode
      if (this.debug) {
        logger.log('DEBUG', `Fetch headers:`, headers);
      }
      
      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
          timeout: options.timeout || 30000
        });
        
        logger.info(`Fetch response for ${url}: status=${response.status}, ok=${response.ok}`);
        return response;
      } catch (error) {
        logger.error(`Fetch error for ${url}:`, error.message);
        throw error;
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Aborts all active fetch requests
   */
  abortAll() {
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }
}
