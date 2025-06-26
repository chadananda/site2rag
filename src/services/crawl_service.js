import path from 'path';
import fs from 'fs';
import {URL} from 'url';
import {CrawlLimitReached} from '../utils/errors.js';

import logger from './logger_service.js';
import ProgressService from '../utils/progress.js';
import {SitemapService} from './sitemap_service.js';
import {UrlFilterService} from './url_filter_service.js';

// === Fast Change Detection (merged from fast_change_detector.js) ===

/**
 * Fast Change Detection Service
 * Implements speed-optimized change detection with multiple filter tiers
 * Designed to make re-crawls extremely fast by eliminating unchanged content early
 */
class FastChangeDetector {
  /**
   * Creates a new FastChangeDetector instance
   * @param {Object} options - Configuration options
   * @param {Object} options.db - Database instance for page data
   * @param {number} options.minAgeHours - Minimum age in hours before checking for changes (default: 168 = 1 week)
   * @param {number} options.fastRecheckHours - Fast recheck interval for recently changed content (default: 24 = 1 day)
   * @param {boolean} options.enableTimeFilters - Enable time-based filtering (default: true)
   * @param {boolean} options.testMode - Enable detailed test mode logging (default: false)
   */
  constructor(options = {}) {
    this.db = options.db;
    this.minAgeHours = options.minAgeHours || 168; // 1 week default
    this.fastRecheckHours = options.fastRecheckHours || 24; // 1 day default
    this.enableTimeFilters = options.enableTimeFilters !== false;
    this.testMode = options.testMode || false;
    // Statistics for performance monitoring
    this.stats = {
      totalChecked: 0,
      skippedByAge: 0,
      skippedByETag: 0,
      skippedByLastModified: 0,
      skippedByHash: 0,
      newContent: 0,
      updatedContent: 0
    };
    logger.info(`[FAST_CHANGE] Initialized with minAge=${this.minAgeHours}h, fastRecheck=${this.fastRecheckHours}h`);
  }
  /**
   * Speed-optimized change detection using multi-tier filtering
   * Filters are applied in order of fastest to slowest checks
   * @param {string} url - URL to check for changes
   * @param {Response} response - HTTP response object
   * @param {string} extractedContent - Extracted content for hash comparison
   * @returns {Object} - Change detection result
   */
  async checkForChanges(url, response, extractedContent = null) {
    this.stats.totalChecked++;
    // Get existing page data from database
    const existingPage = this.db?.getPage(url);
    // Test mode: Log detailed decision process
    if (this.testMode) {
      logger.info(`[TEST] Checking ${url} for changes`);
      if (existingPage) {
        logger.info(`[TEST] - Found existing page (last crawled: ${existingPage.last_crawled})`);
        logger.info(`[TEST] - Existing ETag: ${existingPage.etag || 'none'}`);
        logger.info(`[TEST] - Existing Last-Modified: ${existingPage.last_modified || 'none'}`);
        logger.info(`[TEST] - Existing Content Hash: ${existingPage.content_hash || 'none'}`);
      } else {
        logger.info(`[TEST] - No existing page found - will download`);
      }
      logger.info(`[TEST] - Response ETag: ${response.headers.get('etag') || 'none'}`);
      logger.info(`[TEST] - Response Last-Modified: ${response.headers.get('last-modified') || 'none'}`);
    }
    // Tier 1: Age-based filtering (fastest - no network/computation)
    if (this.enableTimeFilters && existingPage) {
      const ageResult = this._checkAge(existingPage);
      if (ageResult.skip) {
        this.stats.skippedByAge++;
        const message = `too recent (${ageResult.ageHours.toFixed(1)}h < ${this.minAgeHours}h)`;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - ${message}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - Age filter: ${message}`);
        }
        return {
          hasChanged: false,
          reason: 'age_filter',
          ageHours: ageResult.ageHours,
          skipReason: `Content too recent (${ageResult.ageHours.toFixed(1)}h old, min age ${this.minAgeHours}h)`
        };
      }
    }
    // Tier 2: ETag comparison (very fast - header check)
    if (existingPage?.etag && response.headers.get('etag')) {
      const etagResult = this._checkETag(existingPage, response);
      if (!etagResult.hasChanged) {
        this.stats.skippedByETag++;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - ETag match: ${etagResult.etag}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - ETag match: ${etagResult.etag}`);
        }
        return {
          hasChanged: false,
          reason: 'etag_match',
          etag: etagResult.etag
        };
      } else if (this.testMode) {
        logger.info(`[TEST] - ETag changed: ${etagResult.previousETag} → ${etagResult.etag}`);
      }
    }
    // Tier 3: Last-Modified comparison (fast - header check)
    if (existingPage?.last_modified && response.headers.get('last-modified')) {
      const lastModResult = this._checkLastModified(existingPage, response);
      if (!lastModResult.hasChanged) {
        this.stats.skippedByLastModified++;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - Last-Modified match: ${lastModResult.lastModified}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - Last-Modified match: ${lastModResult.lastModified}`);
        }
        return {
          hasChanged: false,
          reason: 'last_modified_match',
          lastModified: lastModResult.lastModified
        };
      } else if (this.testMode) {
        logger.info(
          `[TEST] - Last-Modified changed: ${lastModResult.previousLastModified} → ${lastModResult.lastModified}`
        );
      }
    }
    // Tier 4: Content hash comparison (slower - requires content processing)
    if (extractedContent && existingPage?.content_hash) {
      const hashResult = this._checkContentHash(existingPage, extractedContent);
      if (!hashResult.hasChanged) {
        this.stats.skippedByHash++;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - content hash match: ${hashResult.hash}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - Content hash match: ${hashResult.hash}`);
        }
        return {
          hasChanged: false,
          reason: 'content_hash_match',
          hash: hashResult.hash
        };
      } else if (this.testMode) {
        logger.info(`[TEST] - Content hash changed: ${hashResult.previousHash} → ${hashResult.hash}`);
      }
    }
    // Content has changed or is new
    if (existingPage) {
      this.stats.updatedContent++;
      logger.info(`[FAST_CHANGE] Content updated: ${url}`);
      if (this.testMode) {
        logger.info(`[TEST] ✅ DOWNLOAD: ${url} - Content updated (will process through AI)`);
      }
      return {
        hasChanged: true,
        reason: 'content_updated',
        isNew: false
      };
    } else {
      this.stats.newContent++;
      logger.info(`[FAST_CHANGE] New content: ${url}`);
      if (this.testMode) {
        logger.info(`[TEST] ✅ DOWNLOAD: ${url} - New content (will process through AI)`);
      }
      return {
        hasChanged: true,
        reason: 'new_content',
        isNew: true
      };
    }
  }
  /**
   * Check if content is too recent to warrant a recheck
   * @param {Object} existingPage - Existing page data from database
   * @returns {Object} - Age check result
   * @private
   */
  _checkAge(existingPage) {
    const now = new Date();
    const lastCrawled = new Date(existingPage.last_crawled);
    const ageHours = (now - lastCrawled) / (1000 * 60 * 60);
    // Skip if content is too recent, unless it was recently updated (fast recheck window)
    const isInFastRecheckWindow = ageHours < this.fastRecheckHours;
    const isTooRecent = ageHours < this.minAgeHours;
    // Allow fast recheck for content that was recently updated
    const wasRecentlyUpdated =
      existingPage.last_updated &&
      (now - new Date(existingPage.last_updated)) / (1000 * 60 * 60) < this.fastRecheckHours;
    const skip = isTooRecent && !wasRecentlyUpdated;
    return {
      skip,
      ageHours,
      isInFastRecheckWindow,
      wasRecentlyUpdated: wasRecentlyUpdated || false
    };
  }
  /**
   * Check ETag for changes
   * @param {Object} existingPage - Existing page data
   * @param {Response} response - HTTP response
   * @returns {Object} - ETag check result
   * @private
   */
  _checkETag(existingPage, response) {
    const currentETag = response.headers.get('etag');
    const previousETag = existingPage.etag;
    return {
      hasChanged: currentETag !== previousETag,
      etag: currentETag,
      previousETag
    };
  }
  /**
   * Check Last-Modified header for changes
   * @param {Object} existingPage - Existing page data
   * @param {Response} response - HTTP response
   * @returns {Object} - Last-Modified check result
   * @private
   */
  _checkLastModified(existingPage, response) {
    const currentLastMod = response.headers.get('last-modified');
    const previousLastMod = existingPage.last_modified;
    return {
      hasChanged: currentLastMod !== previousLastMod,
      lastModified: currentLastMod,
      previousLastModified: previousLastMod
    };
  }
  /**
   * Check content hash for changes (hash of extracted content, not original HTML)
   * @param {Object} existingPage - Existing page data
   * @param {string} extractedContent - Current extracted content
   * @returns {Object} - Hash check result
   * @private
   */
  _checkContentHash(existingPage, extractedContent) {
    const currentHash = this._calculateContentHash(extractedContent);
    const previousHash = existingPage.content_hash;
    return {
      hasChanged: currentHash !== previousHash,
      hash: currentHash,
      previousHash
    };
  }
  /**
   * Calculate hash of extracted content (not original HTML)
   * This ensures we detect changes in the actual content that matters
   * @param {string} content - Extracted content to hash
   * @returns {string} - Content hash
   * @private
   */
  _calculateContentHash(content) {
    if (!content) return '';
    // Simple hash function optimized for speed
    // This hashes the extracted/processed content, not the original HTML
    let hash = 0;
    const str = content.toString().trim();
    if (str.length === 0) return '0';
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }
  /**
   * Generate conditional HTTP headers for efficient requests
   * @param {string} url - URL to generate headers for
   * @returns {Object} - HTTP headers object
   */
  generateConditionalHeaders(url) {
    const existingPage = this.db?.getPage(url);
    const headers = {};
    if (existingPage?.etag) {
      headers['If-None-Match'] = existingPage.etag;
      logger.log('DEBUG', `[FAST_CHANGE] Added If-None-Match: ${existingPage.etag}`);
    }
    if (existingPage?.last_modified) {
      headers['If-Modified-Since'] = existingPage.last_modified;
      logger.log('DEBUG', `[FAST_CHANGE] Added If-Modified-Since: ${existingPage.last_modified}`);
    }
    return headers;
  }
  /**
   * Update page data in database with new information
   * Only newly downloaded content gets 'raw' status for AI processing
   * @param {string} url - URL to update
   * @param {Response} response - HTTP response
   * @param {string} extractedContent - Extracted content
   * @param {string} filePath - Path to saved markdown file
   * @param {boolean} isNewContent - Whether this is newly downloaded content
   */
  updatePageData(url, response, extractedContent, filePath = null, isNewContent = true) {
    if (!this.db) {
      logger.warn('[FAST_CHANGE] No database available for page update');
      return;
    }
    const now = new Date().toISOString();
    const pageData = {
      url,
      etag: response.headers.get('etag') || '',
      last_modified: response.headers.get('last-modified') || '',
      content_hash: this._calculateContentHash(extractedContent),
      last_crawled: now,
      last_updated: now, // Mark as updated for fast recheck window
      status: response.status,
      title: null, // Will be extracted from content
      file_path: filePath
    };
    // Only set content_status to 'raw' for new or updated content
    // This ensures AI post-processing only runs on newly downloaded content
    if (isNewContent) {
      pageData.content_status = 'raw';
      logger.log('DEBUG', `[FAST_CHANGE] Marked ${url} for AI processing (content_status=raw)`);
    }
    this.db.upsertPage(pageData);
    logger.log('DEBUG', `[FAST_CHANGE] Updated page data for ${url} with hash ${pageData.content_hash}`);
  }
  /**
   * Update only timestamp for unchanged content (no AI processing needed)
   * @param {string} url - URL to update
   */
  updateUnchangedPage(url) {
    if (!this.db) {
      logger.warn('[FAST_CHANGE] No database available for page update');
      return;
    }
    const now = new Date().toISOString();
    // Only update the last_crawled timestamp, preserve ALL other fields including content_status
    // This prevents unchanged content from being re-processed by AI
    const updateStmt = this.db.db.prepare(`
      UPDATE pages 
      SET last_crawled = ? 
      WHERE url = ?
    `);
    const result = updateStmt.run(now, url);
    if (result.changes === 0) {
      logger.warn(`[FAST_CHANGE] No rows updated for URL: ${url}`);
    } else {
      logger.log('DEBUG', `[FAST_CHANGE] Updated timestamp for unchanged page: ${url}`);
    }
  }
  /**
   * Get performance statistics
   * @returns {Object} - Performance stats with efficiency metrics
   */
  getStats() {
    const totalSkipped =
      this.stats.skippedByAge + this.stats.skippedByETag + this.stats.skippedByLastModified + this.stats.skippedByHash;
    const efficiency = this.stats.totalChecked > 0 ? ((totalSkipped / this.stats.totalChecked) * 100).toFixed(1) : 0;
    return {
      ...this.stats,
      totalSkipped,
      efficiency: `${efficiency}%`,
      efficiencyRatio: totalSkipped / Math.max(this.stats.totalChecked, 1)
    };
  }
  /**
   * Reset statistics
   */
  resetStats() {
    Object.keys(this.stats).forEach(key => {
      this.stats[key] = 0;
    });
  }
  /**
   * Log performance summary
   */
  logPerformanceSummary() {
    const stats = this.getStats();
    logger.info(`[FAST_CHANGE] Performance Summary:`);
    logger.info(`  Total URLs checked: ${stats.totalChecked}`);
    logger.info(`  Skipped by age filter: ${stats.skippedByAge}`);
    logger.info(`  Skipped by ETag: ${stats.skippedByETag}`);
    logger.info(`  Skipped by Last-Modified: ${stats.skippedByLastModified}`);
    logger.info(`  Skipped by content hash: ${stats.skippedByHash}`);
    logger.info(`  New content: ${stats.newContent}`);
    logger.info(`  Updated content: ${stats.updatedContent}`);
    logger.info(`  Overall efficiency: ${stats.efficiency} (${stats.totalSkipped}/${stats.totalChecked} skipped)`);
  }
}

export class CrawlService {
  /**
   * Creates a new CrawlService instance
   * @param {Object} options - Configuration options
   * @param {string} options.domain - Domain to crawl
   * @param {string} options.startUrl - URL to start crawling from
   * @param {number} options.maxPages - Maximum number of pages to crawl
   * @param {number} options.maxDepth - Maximum crawl depth
   * @param {Object} options.urlService - URL service instance
   * @param {Object} options.fetchService - Fetch service instance
   * @param {Object} options.fileService - File service instance
   * @param {Object} options.contentService - Content service instance
   * @param {Object} options.markdownService - Markdown service instance
   * @param {Object} options.crawlStateService - Crawl state service instance
   * @param {boolean} options.debug - Whether to enable debug mode
   */
  constructor(options = {}) {
    this.options = options;
    this.domain = options.domain;
    this.startUrl = options.startUrl || this.domain;
    this.maxPages = options.maxPages !== undefined ? options.maxPages : 100;
    this.maxDepth = options.maxDepth || -1;
    this.urlService = options.urlService;
    this.fetchService = options.fetchService;
    this.fileService = options.fileService;
    this.contentService = options.contentService;
    this.markdownService = options.markdownService;
    this.crawlStateService = options.crawlStateService;
    this.sitemapService = new SitemapService(this.fetchService);
    this.urlFilter = new UrlFilterService(options.filtering || {});

    // Efficient URL tracking to minimize redundant processing
    this.visitedUrls = new Set(); // URLs already processed in this session
    this.queuedUrls = new Set(); // URLs in the queue to be processed
    this.eligibleUrls = new Set(); // URLs that pass all filters (for accurate progress tracking)
    this.foundUrls = new Set(); // URLs successfully processed (Set to prevent memory leak)
    this.contentHashes = new Map(); // In-memory cache of URL content hashes for this session
    this.linkMap = {}; // Map of source URLs to their outbound links

    this.activeCrawls = 0;
    this.maxConcurrency = options.maxConcurrency || 5; // Default is already 5, keeping it here for clarity
    this.debug = options.debug === true; // Ensure it's a boolean
    this.totalUrlsMapped = 0; // Counter for total URLs mapped

    // Initialize progress service
    this.progressService =
      options.progressService ||
      new ProgressService({
        updateFrequency: options.progressUpdateFrequency || 500
      });

    this.assetStats = {
      total: 0,
      images: 0,
      documents: 0,
      other: 0
    };

    this.errorStats = {
      total: 0,
      retries: 0
    };

    // Initialize fast change detector for optimized re-crawls
    // Will be properly initialized with database in initialize() method
    this.changeDetector = null;

    // Configure logger based on debug option
    logger.configure({debug: this.debug});
    logger.crawl(`Debug mode is ${this.debug ? 'enabled' : 'disabled'}`);
  }

  /**
   * Initializes the crawl service
   * @returns {Promise<void>}
   */
  async initialize() {
    let hostname;
    try {
      // Extract hostname from domain
      if (this.domain) {
        const url = new URL(this.domain);
        hostname = url.hostname;
      } else {
        hostname = 'unknown';
        logger.warn('No domain provided for CrawlService.initialize');
      }
    } catch (err) {
      hostname = this.domain?.split('/')?.pop() || 'unknown';
      logger.warn(`'${this.domain}' is not a valid URL in CrawlService.initialize. Using '${hostname}' as hostname.`);
    }

    // Initialize crawl state service if it has an initialize method
    if (this.crawlStateService && typeof this.crawlStateService.initialize === 'function') {
      await this.crawlStateService.initialize(hostname);
      logger.info(`[STATE] Initialized crawl state service for ${hostname}`);

      // Log the number of pages in the crawl state
      if (this.crawlStateService.pages) {
        const pageCount = this.crawlStateService.pages.size;
        logger.info(`[STATE] Loaded ${pageCount} pages from crawl state`);
      }
    }

    // Initialize fetch service (loads robots.txt) if domain is valid
    if (this.domain) {
      try {
        await this.fetchService.fetchRobotsTxt(this.domain);
      } catch (err) {
        logger.warn(`Could not fetch robots.txt for '${this.domain}': ${err.message}`);
      }
    }

    // Initialize fast change detector with database access
    if (this.contentService && this.contentService.db) {
      // Use balanced configuration by default, can be made configurable
      const testMode = this.options.test || false;
      this.changeDetector = new FastChangeDetector({
        db: this.contentService.db,
        minAgeHours: 72, // 3 days - balanced configuration
        fastRecheckHours: 24, // 1 day
        enableTimeFilters: true,
        testMode
      });

      // Log test mode status
      if (testMode) {
        logger.info('[TEST_MODE] Enabled detailed skip/download decision logging');
      }

      logger.info('[FAST_CHANGE] Initialized optimized change detection');
    } else {
      logger.warn('[FAST_CHANGE] No database available, change detection will be limited');
    }
  }

  /**
   * Crawls a website starting from the given URL
   * @param {string} startUrl - URL to start crawling from
   * @returns {Promise<string[]>} - Array of crawled URLs
   */
  async crawlSite(startUrl = null) {
    // Use provided startUrl or default to this.startUrl
    const url = startUrl || this.startUrl;
    logger.info(`Starting crawl from ${url}`, true);
    logger.info(`Max pages: ${this.maxPages}, Max depth: ${this.maxDepth}`, true);
    // Check if we have previous pages (re-crawl)
    this.isReCrawl = false;

    // Check if previous database files exist
    const outputDir = this.options.outputDir || './output';
    const site2ragDir = path.join(outputDir, '.site2rag');
    const dbPath = path.join(site2ragDir, 'crawl.db');
    const prevDbPath = path.join(site2ragDir, 'crawl_prev.db');

    try {
      // Check if any database file exists (either current or previous)
      const dbExists = fs.existsSync(dbPath);
      const prevDbExists = fs.existsSync(prevDbPath);

      if (dbExists || prevDbExists) {
        this.isReCrawl = true;
        logger.info(`Re-crawl detected - Found existing data: DB=${dbExists}, PrevDB=${prevDbExists}`);

        // Initialize re-crawl statistics
        if (this.progressService) {
          this.progressService.stats.newPages = 0;
          this.progressService.stats.updatedPages = 0;
          this.progressService.stats.unchangedPages = 0;

          // Set re-crawl flag in progress service
          this.progressService.isReCrawl = true;
          logger.debug(`Set isReCrawl flag in progress service: ${this.progressService.isReCrawl}`);
        }

        // Check if we can access the database
        if (this.contentService && this.contentService.db) {
          try {
            // Count pages in the database
            const stmt = this.contentService.db.prepare('SELECT COUNT(*) as count FROM pages');
            const result = stmt.get();
            logger.info(`[DB] Found ${result.count} pages in the database`);

            // List all pages in the database for debugging
            if (result.count > 0) {
              const pagesStmt = this.contentService.db.prepare('SELECT url, content_hash FROM pages');
              const pages = pagesStmt.all();
              logger.info(`[DB] Pages in database:`);
              pages.forEach(page => {
                logger.info(`[DB] - ${page.url} (hash: ${page.content_hash || 'none'})`);
              });
            }

            // Check database file paths
            const dbPath = this.contentService.db.name;
            logger.info(`[DB] Current database file: ${dbPath}`);
          } catch (err) {
            logger.error(`[DB] Error accessing database: ${err.message}`);
          }
        } else {
          logger.warn('[DB] Database not accessible for re-crawl detection');
        }
      } else {
        logger.info(`New crawl - No existing data found in ${outputDir}`);
      }
    } catch (err) {
      logger.warn(`Error checking for existing database: ${err.message}`);
    }

    // Start progress display
    if (this.progressService) {
      // Always start with 1 (the initial URL) and update dynamically as URLs are discovered
      const totalUrls = 1;

      if (process.env.DEBUG) {
        console.log(`[CRAWL_SERVICE] Starting progress - maxPages: ${this.maxPages}, initial totalUrls: ${totalUrls}`);
      }

      this.progressService.start({
        totalUrls: totalUrls,
        isReCrawl: this.isReCrawl,
        siteUrl: this.options.startUrl || this.domain,
        maxPages: this.maxPages // Pass the limit for reference
      });
    }

    // Extract and store base domain from the starting URL for domain filtering
    try {
      const startUrlObj = new URL(url);
      this.baseDomain = startUrlObj.hostname;
      logger.domainFilter(`Base domain for crawl: ${this.baseDomain}`);
    } catch (err) {
      logger.warn(`Error extracting base domain from ${url}: ${err.message}`);
    }

    // Ensure sameDomain option is set to true by default unless explicitly disabled
    if (this.options.sameDomain !== false) {
      if (this.options.sameDomain) {
        logger.domainFilter(`Domain filtering enabled, restricting to: ${this.baseDomain}`);
      } else {
        logger.domainFilter(`Domain filtering disabled, will crawl external domains`);
      }
    }

    try {
      logger.info('Initializing crawl...');
      await this.initialize();

      // Pre-load content hashes from previous session if crawlStateService is available
      // This allows for more efficient skipping of unchanged content
      if (this.crawlStateService && this.crawlStateService.pages) {
        logger.info('[CACHE] Loading content hashes from previous session...');

        if (this.crawlStateService.pages.size > 0) {
          logger.info(`[CACHE] Loaded ${this.crawlStateService.pages.size} pages from previous session`);

          // Populate in-memory content hash cache
          let hashCount = 0;

          // Iterate through the pages Map
          for (const [url, pageData] of this.crawlStateService.pages.entries()) {
            if (url && pageData.content_hash) {
              this.contentHashes.set(url, pageData.content_hash);
              hashCount++;
            }
          }

          logger.info(`[CACHE] Preloaded ${hashCount} content hashes into memory cache`);
        }
      }

      // Phase 1: Mapping - Discover and store all sitemap URLs with language metadata
      if (this.sitemapService && this.contentService?.db) {
        logger.info('Phase 1: Mapping - Discovering sitemap URLs...');
        const urlStorageHandler = urlMetadata => {
          this.contentService.db.upsertSitemapUrl(urlMetadata);
        };
        const totalDiscovered = await this.sitemapService.discoverAndStoreSitemapUrls(url, urlStorageHandler);
        logger.info(`Mapping complete: ${totalDiscovered} URLs discovered and stored`);
      }

      logger.info('Phase 2: Crawling - Starting selective crawl...');
      await this.crawl(url, 0);
      logger.info(`Crawl completed with ${this.foundUrls.size} URLs found`);

      return Array.from(this.foundUrls);
    } catch (err) {
      if (err instanceof CrawlLimitReached) {
        logger.info(`Crawl limit reached after ${this.foundUrls.size} URLs`);
        // This is an expected condition, not an error
        // Database state is automatically saved as we go
        logger.info(`[STATE] Crawl state is stored in the database`);

        // Return the array of found URLs
        return Array.from(this.foundUrls);
      }
      logger.error('Error during crawl:', err);
      throw err;
    } finally {
      // Ensure all active downloads are properly accounted for
      if (this.activeCrawls > 0) {
        logger.info(`Waiting for ${this.activeCrawls} active downloads to complete...`);
        // Wait a bit for active downloads to finish
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Abort any pending requests
      this.fetchService.abortAll();

      // Database state is automatically saved as we go
      logger.info(`[STATE] Crawl state is stored in the database`);

      // Log performance summary for fast change detection
      if (this.changeDetector) {
        this.changeDetector.logPerformanceSummary();
      }

      // Stop progress display without clearing the screen
      if (this.progressService) {
        // Final update of stats before stopping
        // Use eligible URLs for accurate total
        const finalTotal = this.eligibleUrls.size;

        this.progressService.updateStats({
          totalUrls: finalTotal,
          crawledUrls: this.visitedUrls.size,
          queuedUrls: 0,
          activeUrls: 0,
          assets: this.assetStats,
          errors: this.errorStats,
          // Include re-crawl statistics if this is a re-crawl
          ...(this.isReCrawl
            ? {
                newPages: this.progressService.stats.newPages,
                updatedPages: this.progressService.stats.updatedPages,
                unchangedPages: this.progressService.stats.unchangedPages
              }
            : {})
        });

        // Log final re-crawl statistics for debugging
        if (this.isReCrawl) {
          logger.info(
            `[STATS] Final re-crawl statistics: ${this.progressService.stats.newPages} new, ${this.progressService.stats.updatedPages} updated, ${this.progressService.stats.unchangedPages} unchanged`
          );
        }

        this.progressService.stop();
      }
    }
  }

  /**
   * Adds a URL to the crawl queue if it's not already visited or queued
   * @param {string} url - URL to add to the queue
   * @param {number} depth - Current crawl depth
   */
  async queueUrl(url, depth) {
    if (this.foundUrls.size >= this.options.maxPages) return;
    if (this.maxDepth > 0 && depth > this.maxDepth) return;
    let normalizedUrl = url;
    if (this.urlService && this.urlService.normalizeUrl) {
      normalizedUrl = this.urlService.normalizeUrl(url);
    }

    // Skip if this URL has already been visited or queued
    if (this.visitedUrls.has(normalizedUrl) || this.queuedUrls.has(normalizedUrl)) {
      return;
    }

    // Early domain check - before any processing
    try {
      const urlObj = new URL(normalizedUrl);
      const urlHostname = urlObj.hostname;

      // Get the base domain from the starting URL if not already set
      if (!this.baseDomain && this.startUrl) {
        const startUrlObj = new URL(this.startUrl);
        this.baseDomain = startUrlObj.hostname;
        logger.domainFilter(`Setting base domain at queue time: ${this.baseDomain}`);
      }

      // Strict domain filtering - only allow URLs from the same domain
      if (depth > 0 && this.options.sameDomain && this.baseDomain && urlHostname !== this.baseDomain) {
        logger.domainFilter(`Rejecting external URL at queue: ${normalizedUrl} (${urlHostname} ≠ ${this.baseDomain})`);
        return;
      }
    } catch (err) {
      logger.warn(`[DOMAIN_FILTER] Error checking domain for ${normalizedUrl}: ${err.message}`);
      // Skip URLs that cause errors in domain checking
      return;
    }

    // Apply URL filtering rules (paths, patterns)
    if (!this.urlFilter.shouldCrawlUrl(normalizedUrl)) {
      return; // URL filtering already logs the reason
    }

    // Add to queue
    this.queuedUrls.add(normalizedUrl);

    // Only add to eligible URLs if not in sitemap-first mode
    // In sitemap mode, eligible URLs are already determined from the sitemap
    if (!this._sitemapFirstMode) {
      // Only add to eligible if not already there (crawl() will also add it)
      if (!this.eligibleUrls.has(normalizedUrl)) {
        this.eligibleUrls.add(normalizedUrl);
      }

      // Update progress bar with eligible URLs only
      if (this.progressService) {
        const totalEligible = this.eligibleUrls.size;
        this.progressService.updateStats({
          totalUrls: totalEligible,
          queuedUrls: this.queuedUrls.size
        });
      }
    } else {
      // In sitemap mode, just update queue count
      if (this.progressService) {
        this.progressService.updateStats({
          queuedUrls: this.queuedUrls.size
        });
      }
    }

    // Recursively crawl this URL
    await this.crawl(normalizedUrl, depth + 1);
  }

  /**
   * Crawl URLs from sitemap database with language pre-filtering
   * @param {string} startUrl - Starting URL (used for home page)
   */
  async crawlFromSitemap(startUrl) {
    logger.info(`Using sitemap-first crawling with language filter: ${this.urlFilter.includeLanguage}`);

    // Add the start URL to eligible URLs
    this.eligibleUrls.add(startUrl);

    // Always process the home page first
    await this.processUrlDirectly(startUrl);

    // Get ALL unprocessed URLs from sitemap database (we'll filter them ourselves)
    const filters = {
      language: this.urlFilter.includeLanguage,
      unprocessedOnly: true,
      limit: 1000 // Get enough URLs to account for heavy filtering
    };

    const allSitemapUrls = this.contentService.db.getFilteredSitemapUrls(filters);
    logger.info(`Found ${allSitemapUrls.length} language-filtered URLs from sitemap database`);

    // Filter URLs that pass path/pattern filters and count them
    const validUrls = allSitemapUrls.filter(sitemapUrl => this.urlFilter.shouldCrawlUrl(sitemapUrl.url));
    logger.info(`After path/pattern filtering: ${validUrls.length} valid URLs to crawl`);

    // Add all valid URLs to eligible set
    for (const sitemapUrl of validUrls) {
      this.eligibleUrls.add(sitemapUrl.url);
    }

    // Update progress bar with final eligible count
    if (this.progressService) {
      const totalEligible = this.eligibleUrls.size;
      this.progressService.updateStats({
        totalUrls: totalEligible,
        queuedUrls: 0
      });
      logger.info(`Set progress total to ${totalEligible} eligible URLs from sitemap`);
    }

    // Process each valid URL directly
    for (const sitemapUrl of validUrls) {
      if (this.foundUrls.size >= this.maxPages) {
        logger.info(`Reached page limit of ${this.maxPages}`);
        break;
      }

      // Process the URL directly
      await this.processUrlDirectly(sitemapUrl.url);

      // Mark as processed in sitemap database
      this.contentService.db.markSitemapUrlProcessed(sitemapUrl.url);
    }

    // Mark remaining invalid URLs as processed so they don't get checked again
    const invalidUrls = allSitemapUrls.filter(sitemapUrl => !this.urlFilter.shouldCrawlUrl(sitemapUrl.url));
    for (const sitemapUrl of invalidUrls) {
      this.contentService.db.markSitemapUrlProcessed(sitemapUrl.url);
    }
    logger.info(`Marked ${invalidUrls.length} filtered URLs as processed`);
  }

  /**
   * Process a single URL directly without crawl complexity
   * @param {string} url - URL to process
   */
  async processUrlDirectly(url) {
    // Normalize URL
    let normalizedUrl = url;
    if (this.urlService && this.urlService.normalizeUrl) {
      normalizedUrl = this.urlService.normalizeUrl(url);
    }

    // Skip if this URL has already been visited
    if (this.visitedUrls.has(normalizedUrl)) {
      return;
    }

    // Mark as visited to prevent duplicate processing
    this.visitedUrls.add(normalizedUrl);

    // Add to active downloads in progress service
    this.progressService.addActiveUrl(normalizedUrl);

    try {
      logger.crawl(`Processing URL directly: ${normalizedUrl}`);

      // Check if we've reached the maximum number of pages
      if (this.foundUrls.size >= this.maxPages) {
        logger.crawl(`Reached max pages limit: ${this.foundUrls.size}/${this.maxPages}`, true);
        return;
      }

      // Prepare headers for request
      const headers = {'User-Agent': 'site2rag-crawler'};

      // Fetch the URL
      logger.crawl(`Fetching ${normalizedUrl}`);
      const response = await this.fetchService.fetchUrl(normalizedUrl, headers);

      // Handle non-OK responses
      if (!response.ok) {
        logger.error(`Error fetching ${normalizedUrl}: ${response.status} ${response.statusText}`);
        this.progressService.completeUrl(normalizedUrl, 'error');
        return;
      }

      // Get HTML content
      const html = await response.text();

      // Apply content-level filtering (language check)
      if (!this.urlFilter.shouldProcessContent(html, normalizedUrl)) {
        logger.info(`Content filtered out: ${normalizedUrl}`);
        this.progressService.completeUrl(normalizedUrl, 'filtered');
        return;
      }

      // Process HTML content
      const {$, main, links: allLinks, removedBlocks} = await this.contentService.processHtml(html, normalizedUrl);

      // Extract metadata from HTML
      const metadata = this.contentService.extractMetadata($);
      const title = metadata.title;

      // Convert to markdown
      const markdown = this.markdownService.toMarkdown(main, normalizedUrl);

      // Create enhanced metadata with all available information
      const enhancedMetadata = {
        ...metadata,
        url: normalizedUrl,
        crawled_at: new Date().toISOString(),
        language: this.urlFilter.includeLanguage || 'en'
      };

      // Generate frontmatter
      const frontmatter = Object.entries(enhancedMetadata)
        .filter(([key, value]) => value !== null && value !== undefined && value !== '' && 
                                 !(Array.isArray(value) && value.length === 0))
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            // Format arrays as YAML lists
            return `${key}:\n${value.map(item => `  - ${JSON.stringify(item)}`).join('\n')}`;
          } else if (typeof value === 'string') {
            return `${key}: ${JSON.stringify(value)}`;
          } else {
            return `${key}: ${value}`;
          }
        })
        .join('\n');

      const fullMarkdown = `---\n${frontmatter}\n---\n\n${markdown}`;

      // Save to file
      const outputPath = this.options.outputPath || this.options.outputDir || './output';
      let filePath;

      if (this.options.flat) {
        // Flat structure - all files in root
        const urlObj = new URL(normalizedUrl);
        const filename =
          urlObj.pathname === '/' ? 'index.md' : `${urlObj.pathname.split('/').filter(Boolean).join('-')}.md`;
        filePath = path.join(outputPath, filename);
      } else {
        // Directory structure matching URL path
        const urlObj = new URL(normalizedUrl);
        const pathSegments = urlObj.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 0) {
          filePath = path.join(outputPath, 'index.md');
        } else {
          const dirPath = path.join(outputPath, ...pathSegments.slice(0, -1));
          const filename = `${pathSegments[pathSegments.length - 1]}.md`;
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, {recursive: true});
          }
          filePath = path.join(dirPath, filename);
        }
      }

      // Ensure output directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
      }

      // Write the markdown file
      fs.writeFileSync(filePath, fullMarkdown, 'utf8');
      logger.crawl(`Saved: ${filePath}`);

      // Calculate content hash
      const contentHash = this.calculateContentHash(markdown);

      // Save page data to database
      const pageData = {
        url: normalizedUrl,
        etag: response.headers.get('etag') || null,
        last_modified: response.headers.get('last-modified') || null,
        content_hash: contentHash,
        status: response.status,
        last_crawled: new Date().toISOString(),
        title: title || '',
        file_path: filePath,
        language: this.urlFilter.includeLanguage || null
      };

      if (this.contentService?.db) {
        this.contentService.db.upsertPage(pageData);
      }

      // Add to found URLs list
      this.foundUrls.add(normalizedUrl);
      logger.crawl(`Added URL to found list: ${normalizedUrl} (${this.foundUrls.size}/${this.maxPages})`);

      // Mark download as complete
      this.progressService.completeUrl(normalizedUrl, 'success');
    } catch (err) {
      logger.error(`Error processing ${normalizedUrl}: ${err.message}`);
      this.progressService.completeUrl(normalizedUrl, 'error');
    }
  }

  /**
   * Crawls a URL and processes its content
   * @param {string} url - URL to crawl
   * @param {number} depth - Current crawl depth
   */
  async crawl(url, depth = 0) {
    // For depth 0 (starting URL), use sitemap-first approach if language filtering is enabled
    if (depth === 0 && this.urlFilter?.includeLanguage && this.contentService?.db && this._sitemapFirstMode !== false) {
      this._sitemapFirstMode = true; // Mark that we're in sitemap-first mode
      return await this.crawlFromSitemap(url);
    }

    // Normalize URL
    let normalizedUrl = url;
    if (this.urlService && this.urlService.normalizeUrl) {
      normalizedUrl = this.urlService.normalizeUrl(url);
    }

    // Apply URL filtering rules (paths, patterns) - critical for excluding unwanted URLs
    if (!this.urlFilter.shouldCrawlUrl(normalizedUrl)) {
      return; // URL filtering already logs the reason
    }

    // Skip if this URL has already been visited - no need to log for in-memory checks
    if (this.visitedUrls.has(normalizedUrl)) {
      return;
    }

    // Add to active downloads in progress service
    this.progressService.addActiveUrl(normalizedUrl);

    // Strict domain filtering at the beginning of crawl
    if (depth > 0 && this.options.sameDomain === true) {
      try {
        const urlObj = new URL(normalizedUrl);
        const urlHostname = urlObj.hostname;

        // Ensure we have the base domain
        if (!this.baseDomain && this.startUrl) {
          const startUrlObj = new URL(this.startUrl);
          this.baseDomain = startUrlObj.hostname;
          logger.domainFilter(`Setting base domain: ${this.baseDomain}`);
        }

        if (this.baseDomain && urlHostname !== this.baseDomain) {
          logger.domainFilter(
            `Skipping external URL: ${normalizedUrl} (domain: ${urlHostname}, not in base domain: ${this.baseDomain})`
          );
          // Remove from active downloads since we're not crawling it
          this.progressService.completeUrl(normalizedUrl, 'filtered');
          return;
        }
      } catch (err) {
        logger.warn(`Error checking domain for ${normalizedUrl}: ${err.message}`);
        this.progressService.completeUrl(normalizedUrl, 'error');
        return;
      }
    }

    // Add to eligible URLs set AFTER all filtering checks pass
    // But not in sitemap-first mode where eligible URLs are predetermined
    if (!this._sitemapFirstMode) {
      this.eligibleUrls.add(normalizedUrl);
    }

    // Domain filtering is now handled at the beginning of the crawl method

    // Note: We don't skip URLs that are in the queue since they may be from sitemaps
    // and need to be processed. The visitedUrls check above prevents duplicate processing.

    // Mark as queued immediately to prevent duplicate processing
    this.queuedUrls.add(normalizedUrl);

    // Check if this URL is a resource link (contains resource parameter)
    try {
      const resourceUrlObj = new URL(normalizedUrl);
      const resourceParam = resourceUrlObj.searchParams.get('resource');

      if (resourceParam && resourceParam.match(/\.(pdf|docx?|xlsx?|pptx?|rtf|zip|rar|7z|tar|gz)$/i)) {
        logger.info(`[BINARY_TRACKING] Detected resource URL: ${normalizedUrl} with resource: ${resourceParam}`);

        // Add to database for tracking
        if (this.crawlStateService && typeof this.crawlStateService.queueUrl === 'function') {
          await this.crawlStateService.queueUrl(normalizedUrl, {resourceType: 'binary', resourceParam});
          logger.info(`[BINARY_TRACKING] Added binary resource to queue: ${resourceParam}`);
        }

        // Add to active downloads in progress service
        this.progressService.addActiveUrl(normalizedUrl);

        // First try to build a direct URL to the resource based on the base URL and resource parameter
        const resourceUrlObj = new URL(normalizedUrl);
        const baseUrl = `${resourceUrlObj.protocol}//${resourceUrlObj.host}`;

        // Try multiple possible resource URL patterns
        const possibleResourceUrls = [
          // Direct download from the resource parameter using /file/ path
          `${baseUrl}/file/${resourceParam}`,
          // Try with /wp-content/uploads/ path
          `${baseUrl}/wp-content/uploads/${resourceParam}`,
          // Try direct resource parameter as path
          `${baseUrl}/${resourceParam}`,
          // Try the original URL as fallback
          normalizedUrl
        ];

        let resourceUrl = null;
        let resourceResponse = null;
        let contentType = null;

        // Try each possible URL until we get a successful response
        for (const url of possibleResourceUrls) {
          try {
            logger.info(`[CRAWL] Attempting to download from: ${url}`);
            const response = await fetch(url, {timeout: this.options.timeout});

            if (response.ok) {
              contentType = response.headers.get('content-type') || '';

              // Verify it's actually a binary file by content type
              if (this.isBinaryFile(contentType)) {
                resourceUrl = url;
                resourceResponse = response;
                logger.info(`[CRAWL] Successfully downloaded binary file from: ${url} (${contentType})`);
                break;
              } else {
                logger.info(`[CRAWL] URL ${url} returned non-binary content type: ${contentType}`);
              }
            } else {
              logger.warn(`[CRAWL] Failed to download from ${url}: HTTP ${response.status}`);
            }
          } catch (err) {
            logger.warn(`[CRAWL] Failed to download from ${url}: ${err.message}`);
          }
        }

        // If all attempts failed, skip this resource
        if (!resourceResponse) {
          logger.error(`[CRAWL] Failed to download resource: ${resourceParam} from any URL`);
          // Mark download as failed in progress service
          this.progressService.completeUrl(normalizedUrl, 'error');
          return;
        }

        try {
          // We already have the resourceResponse from our earlier attempts
          logger.info(`[CRAWL] Processing binary resource: ${resourceParam} from ${resourceUrl}`);

          const contentType = resourceResponse.headers.get('content-type') || '';

          let contentChanged = true;

          // First check in-memory cache for faster lookups
          if (this.isBinaryFile(contentType, normalizedUrl)) {
            // Clone the response to avoid consuming it
            const responseClone = resourceResponse.clone();

            try {
              // Get binary data
              const buffer = await responseClone.arrayBuffer();

              // Calculate binary hash
              const binaryHash = this.calculateBinaryHash(buffer);

              // Check in-memory cache first (fastest)
              if (this.contentHashes.has(normalizedUrl)) {
                const cachedHash = this.contentHashes.get(normalizedUrl);
                if (cachedHash === binaryHash) {
                  if (this.debug) {
                    logger.info(`[CACHE] Binary file unchanged (in-memory): ${normalizedUrl}`);
                  }
                  contentChanged = false;
                }
              } else if (this.crawlStateService && typeof this.crawlStateService.getPageHash === 'function') {
                // Check database cache
                const previousHash = await this.crawlStateService.getPageHash(normalizedUrl);
                if (previousHash && previousHash === binaryHash) {
                  if (this.debug) {
                    logger.info(`[CACHE] Binary file unchanged (database): ${normalizedUrl}`);
                  }
                  contentChanged = false;
                }
              }

              // Update caches regardless
              this.contentHashes.set(normalizedUrl, binaryHash);
              if (this.crawlStateService && typeof this.crawlStateService.savePageHash === 'function') {
                await this.crawlStateService.savePageHash(normalizedUrl, binaryHash);
              }
            } catch (err) {
              logger.warn(`[BINARY] Error checking binary hash: ${err.message}`);
              // Continue with contentChanged = true if there was an error
            }
          } else {
            // For non-binary files, use text-based content hash
            if (
              this.crawlStateService &&
              typeof this.crawlStateService.getPageHash === 'function' &&
              typeof this.crawlStateService.savePageHash === 'function'
            ) {
              const responseClone = resourceResponse.clone();
              const content = await responseClone.text();
              const contentHash = this.calculateContentHash(content);

              // Check in-memory cache first
              if (this.contentHashes.has(normalizedUrl)) {
                const cachedHash = this.contentHashes.get(normalizedUrl);
                if (cachedHash === contentHash) {
                  contentChanged = false;
                  logger.cache(`Content unchanged (in-memory): ${normalizedUrl}`);

                  // Increment unchanged pages count for re-crawls
                  if (this.progressService && this.isReCrawl) {
                    this.progressService.stats.unchangedPages++;
                  }
                }
              } else if (this.isReCrawl && this.contentService.db) {
                // We'll handle re-crawl statistics in the database section below
                if (this.isReCrawl) {
                  logger.debug(`Processing URL in re-crawl mode: ${normalizedUrl}`);
                }
              }

              // Update in-memory cache
              this.contentHashes.set(normalizedUrl, contentHash);

              // Update database directly if available
              if (this.contentService.db) {
                try {
                  // First check if the page already exists in the database
                  const checkStmt = this.contentService.db.prepare('SELECT url, content_hash FROM pages WHERE url = ?');
                  const existingPage = checkStmt.get(normalizedUrl);

                  // For re-crawls, determine if the page is new, updated, or unchanged
                  if (this.isReCrawl) {
                    // Normal re-crawl logic
                    if (!existingPage) {
                      // New page
                      logger.debug(`New page: ${normalizedUrl}`);
                      if (this.progressService) {
                        this.progressService.stats.newPages++;
                        logger.debug(`New pages: ${this.progressService.stats.newPages}`);
                      }
                    } else if (existingPage.content_hash !== contentHash) {
                      // Updated page
                      logger.debug(
                        `Updated page: ${normalizedUrl} (old hash: ${existingPage.content_hash}, new hash: ${contentHash})`
                      );
                      if (this.progressService) {
                        this.progressService.stats.updatedPages++;
                        logger.debug(`Updated pages: ${this.progressService.stats.updatedPages}`);
                      }
                    } else {
                      // Unchanged page
                      logger.debug(`Unchanged page: ${normalizedUrl} (hash: ${contentHash})`);
                      if (this.progressService) {
                        this.progressService.stats.unchangedPages++;
                        logger.debug(`Unchanged pages: ${this.progressService.stats.unchangedPages}`);
                      }
                    }
                  }

                  // Use upsert pattern (insert or update)
                  const stmt = this.contentService.db.prepare(
                    'INSERT INTO pages (url, content_hash, last_crawled) VALUES (?, ?, ?) ' +
                      'ON CONFLICT(url) DO UPDATE SET content_hash = ?, last_crawled = ?'
                  );

                  const now = new Date().toISOString();
                  stmt.run(normalizedUrl, contentHash, now, contentHash, now);
                } catch (err) {
                  logger.error(`[DB] Error saving page hash: ${err.message}`);
                }
              }
            }
          }

          if (this.isBinaryFile(contentType, normalizedUrl)) {
            if (contentChanged) {
              await this.handleBinaryFile(normalizedUrl, resourceResponse, contentType, resourceParam);
            }
            return;
          }
        } catch (err) {
          logger.error(`Error downloading resource: ${resourceParam}, ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`Error parsing URL: ${normalizedUrl}, ${err.message}`);
    }

    // Move from queued to visited
    this.queuedUrls.delete(normalizedUrl);
    this.visitedUrls.add(normalizedUrl);

    // Extract hostname from the URL for domain checking
    let domainUrlObj;
    let shouldFetch = true;

    try {
      domainUrlObj = new URL(normalizedUrl);

      // Skip URLs that are not from the same domain as the starting domain
      // Only apply this check to links beyond the start URL (depth > 0)
      if (depth > 0 && this.options && this.options.sameDomain === true) {
        // Simple domain check if urlService is not available
        const hostname = domainUrlObj.hostname;

        try {
          const domainObj = new URL(this.startUrl || '');
          const baseDomain = domainObj.hostname;

          // Use urlService if available, otherwise do a simple hostname comparison
          let sameDomain = false;
          if (this.urlService && typeof this.urlService.isSameDomain === 'function') {
            sameDomain = this.urlService.isSameDomain(normalizedUrl, baseDomain);
          } else {
            // Simple hostname comparison as fallback
            sameDomain = hostname === baseDomain;
          }

          if (!sameDomain) {
            if (this.debug) {
              logger.log('DEBUG', `Skipping external URL: ${normalizedUrl} (not in domain ${baseDomain})`);
            }
            shouldFetch = false;
          }
        } catch (domainErr) {
          logger.warn(`Error checking domain for ${normalizedUrl}: ${domainErr.message}`);
          // Continue processing if we can't check the domain
        }
      }

      // Check if we have content hash from previous session
      // Only do this check if we're going to fetch the URL
      if (shouldFetch && this.crawlStateService && typeof this.crawlStateService.getPageHash === 'function') {
        const previousHash = await this.crawlStateService.getPageHash(normalizedUrl);
        if (previousHash) {
          // We'll check for content changes after fetching
          if (this.debug) {
            logger.log('DEBUG', `Found previous hash for ${normalizedUrl}`);
          }
        }
      }

      if (!shouldFetch) {
        return;
      }
    } catch (e) {
      logger.error(`Error parsing URL ${normalizedUrl}: ${e.message}`);
      return;
    }

    // Check robots.txt to ensure we're allowed to crawl this URL
    if (this.fetchService && !this.fetchService.canCrawl(normalizedUrl)) {
      logger.info(`Robots.txt disallows crawling: ${normalizedUrl}`);
      return;
    }

    // Track active crawls for concurrency control
    this.activeCrawls++;
    if (this.debug) {
      logger.log('DEBUG', `Crawling URL: ${url} (depth=${depth})`);
    }
    // Ensure URL is a string, not an object
    const urlString = typeof normalizedUrl === 'object' ? normalizedUrl.href : normalizedUrl;

    // Mark URL as visited and remove from queue
    this.visitedUrls.add(normalizedUrl);
    this.queuedUrls.delete(normalizedUrl); // Remove from queue if it was there
    // Note: URL will be added to foundUrls only after successful processing

    // Update crawl stats with eligible URLs total
    this.progressService.updateStats({
      totalUrls: this.eligibleUrls.size,
      crawledUrls: this.visitedUrls.size,
      queuedUrls: this.queuedUrls.size,
      activeUrls: this.activeCrawls
    });

    // For re-crawls, check if the page exists in the database
    let existingPage = null;
    if (this.isReCrawl && this.contentService.db) {
      try {
        // Query the database directly for the page data
        const stmt = this.contentService.db.prepare(
          'SELECT url, etag, last_modified, content_hash FROM pages WHERE url = ?'
        );
        existingPage = stmt.get(normalizedUrl);

        // Debug log for re-crawl detection
        logger.info(`[DEBUG] DB page data for ${normalizedUrl}: ${existingPage ? 'Found' : 'Not found'}`);
        if (existingPage) {
          logger.info(`[DEBUG] DB content hash: ${existingPage.content_hash || 'Not set'}`);
        }
      } catch (err) {
        logger.error(`[DB] Error querying page data: ${err.message}`);
      }
    }

    // Skip if we're beyond the max depth (but allow if maxDepth is -1, which means no limit)
    if (this.maxDepth >= 0 && depth > this.maxDepth) {
      logger.crawl(`Skipping URL due to depth: ${normalizedUrl} (depth=${depth}, maxDepth=${this.maxDepth})`);
      return;
    }

    // Check if we've reached the maximum number of pages
    if (this.foundUrls.size >= this.maxPages) {
      this.activeCrawls--;
      logger.crawl(`Reached max pages limit: ${this.foundUrls.size}/${this.maxPages}`, true);
      throw new CrawlLimitReached('Crawl limit reached');
    }

    try {
      // Prepare headers for conditional request using optimized change detector
      const headers = {'User-Agent': 'site2rag-crawler'};

      // Use fast change detector if available for optimal performance
      if (this.changeDetector) {
        const conditionalHeaders = this.changeDetector.generateConditionalHeaders(normalizedUrl);
        Object.assign(headers, conditionalHeaders);
      } else {
        // Fallback to basic conditional headers
        if (existingPage) {
          logger.cache(`Found previous data for ${urlString}`);

          if (existingPage.etag) {
            logger.cache(`Using ETag: ${existingPage.etag}`);
            headers['If-None-Match'] = existingPage.etag;
          }

          if (existingPage.last_modified) {
            logger.cache(`Using Last-Modified: ${existingPage.last_modified}`);
            headers['If-Modified-Since'] = existingPage.last_modified;
          }
        }
      }

      // Fetch the URL with conditional headers
      logger.crawl(`FetchService.fetchUrl: Fetching ${normalizedUrl}`);
      // Only log fetch headers in debug mode
      if (this.debug) {
        logger.crawl(`Fetch headers: ${JSON.stringify(headers)}`);
      }
      const response = await this.fetchService.fetchUrl(normalizedUrl, headers);

      // Handle 304 Not Modified
      if (response.status === 304) {
        logger.cache(`Not modified: ${normalizedUrl}`);
        // Update last_crawled timestamp but keep all other data the same
        this.crawlStateService.upsertPage(urlString, {
          last_crawled: new Date().toISOString()
        });

        // Track unchanged pages for re-crawls
        if (this.progressService && this.isReCrawl) {
          this.progressService.stats.unchangedPages++;
          this.progressService.stats.crawledUrls++; // Count as crawled for progress
          logger.info(
            `[STATS] Unchanged page (304): ${normalizedUrl}, total unchanged: ${this.progressService.stats.unchangedPages}`
          );
        }
        return;
      }

      // Handle non-OK responses (like 404) - save content for analysis
      if (!response.ok) {
        // Log actual errors only, not redirects (redirects are handled transparently)
        logger.error(`Error fetching ${normalizedUrl}: ${response.status} ${response.statusText}`);

        // Get error page content to save it
        const errorHtml = await response.text();
        const contentHash = this.calculateContentHash(errorHtml);

        // Create error page metadata
        const errorMetadata = {
          status: response.status,
          statusText: response.statusText,
          originalUrl: normalizedUrl,
          finalUrl: response.url,
          redirected: response.url !== normalizedUrl,
          crawled_at: new Date().toISOString(),
          error: true
        };

        // Save error page content for debugging/analysis
        try {
          const markdownContent = this.markdownService.toMarkdown(errorHtml, normalizedUrl);

          // Add error metadata to markdown content
          const metadataString = Object.entries(errorMetadata)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join('\n');

          const fullMarkdownContent = `---
${metadataString}
---

${markdownContent}`;

          // Generate error filename based on URL
          const urlObj = new URL(normalizedUrl);
          const urlPath = urlObj.pathname || '/';
          let filename;

          if (this.options.flat) {
            filename = this.fileService.generateFlatFilename(urlPath);
          } else {
            filename = urlPath === '/' ? 'index.md' : `${urlPath.replace(/^\/+/, '').replace(/\/+/g, '/')}.md`;
          }

          const errorFilename = filename.replace(/\.md$/, '.error.md');

          // Save error content to file directly
          let filepath;
          try {
            const outputDir = this.options.outputDir || './output';

            // Ensure output directory exists
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, {recursive: true});
            }

            filepath = path.join(outputDir, errorFilename);
            await fs.promises.writeFile(filepath, fullMarkdownContent, 'utf8');
          } catch (fsError) {
            logger.error(`File system save failed: ${fsError.message}`);
            throw fsError;
          }

          logger.info(`Saved error page content to: ${errorFilename} (status: ${response.status})`);

          // Update database with error status and file path
          this.crawlStateService.upsertPage(urlString, {
            status: response.status,
            final_url: response.url,
            file_path: filepath,
            content_hash: contentHash,
            last_crawled: new Date().toISOString(),
            error: true
          });
        } catch (saveError) {
          logger.error(`Failed to save error page content: ${saveError.message}`);

          // Update status in page data without file path
          this.crawlStateService.upsertPage(urlString, {
            status: response.status,
            final_url: response.url,
            last_crawled: new Date().toISOString(),
            error: true
          });
        }

        return;
      }

      // Get HTML content from response
      const html = await response.text();

      // Apply content-based filtering (language detection)
      if (!this.urlFilter.shouldProcessContent(html, normalizedUrl)) {
        // Content filtered out - remove from queue and return
        this.queuedUrls.delete(normalizedUrl);
        return;
      }

      // Calculate content hash for change detection
      const contentHash = this.calculateContentHash(html);

      if (this.debug) {
        logger.log('DEBUG', `Content hash for ${normalizedUrl}: ${contentHash}`);
      }

      // First check in-memory cache for faster lookups
      if (this.contentHashes.has(normalizedUrl)) {
        const cachedHash = this.contentHashes.get(normalizedUrl);
        if (cachedHash === contentHash) {
          logger.cache(`Content unchanged (in-memory cache): ${normalizedUrl}`);
          // Update last_crawled timestamp but keep all other data the same
          this.crawlStateService.upsertPage(urlString, {
            last_crawled: new Date().toISOString()
          });

          // Track unchanged pages for re-crawls
          if (this.progressService && this.isReCrawl) {
            this.progressService.stats.unchangedPages++;
            this.progressService.stats.crawledUrls++; // Count as crawled for progress
          }
          return;
        }
      }

      // Update in-memory cache with new hash
      this.contentHashes.set(normalizedUrl, contentHash);

      // Always store the content hash in the page data
      // This ensures it's available for future re-crawls
      if (existingPage) {
        this.crawlStateService.upsertPage(urlString, {
          content_hash: contentHash
        });
      }

      // Check if content has changed using ETag, Last-Modified, and content hash
      if (existingPage) {
        let contentUnchanged = false;

        // Check ETag if available
        const etag = response.headers.get('etag');
        if (etag && existingPage.etag && existingPage.etag === etag) {
          if (this.debug) {
            logger.log('DEBUG', `ETag match for ${urlString}: ${etag}`);
          }
          contentUnchanged = true;
        }

        // Check Last-Modified if available
        const lastModified = response.headers.get('last-modified');
        if (
          !contentUnchanged &&
          lastModified &&
          existingPage.last_modified &&
          existingPage.last_modified === lastModified
        ) {
          if (this.debug) {
            logger.log('DEBUG', `Last-Modified match for ${urlString}: ${lastModified}`);
          }
          contentUnchanged = true;
        }

        // Check content hash as a fallback - this is the most reliable method
        // for re-crawls since ETags and Last-Modified headers might not be consistent
        if (!contentUnchanged && contentHash && existingPage.content_hash) {
          if (contentHash === existingPage.content_hash) {
            if (this.debug) {
              logger.log('DEBUG', `Content hash match for ${urlString}: ${contentHash}`);
            }
            contentUnchanged = true;
          } else if (this.debug) {
            logger.log(
              'DEBUG',
              `Content hash mismatch for ${urlString}: ${contentHash} vs ${existingPage.content_hash}`
            );
          }
        }

        if (contentUnchanged) {
          logger.cache(`Content unchanged for ${normalizedUrl}, skipping processing`);
          // Update last_crawled timestamp but keep all other data the same
          this.crawlStateService.upsertPage(urlString, {
            last_crawled: new Date().toISOString(),
            content_hash: contentHash // Update the hash in case it wasn't stored before
          });

          // Track unchanged pages for re-crawls
          if (this.progressService && this.isReCrawl) {
            this.progressService.stats.unchangedPages++;
            this.progressService.stats.crawledUrls++; // Count as crawled for progress
          }

          return;
        } else {
          logger.cache(`Content changed for ${urlString}`);

          // Track updated pages for re-crawls
          if (this.progressService && this.isReCrawl && existingPage) {
            this.progressService.stats.updatedPages++;
          }
        }
      }

      // Process HTML content
      const {$, main, links: allLinks, removedBlocks} = await this.contentService.processHtml(html, normalizedUrl);

      // Extract and download PDFs/documents from external domains
      // These won't go through the normal crawl queue to bypass domain filtering
      await this.downloadExternalDocuments($, normalizedUrl);
      
      // Extract document links from same domain to add to crawl queue
      const documentLinks = this.extractDocumentLinks($, normalizedUrl);
      if (documentLinks.length > 0) {
        logger.info(`[DOCS] Extracted ${documentLinks.length} same-domain document links from ${normalizedUrl}`);
      }
      const combinedLinks = [...allLinks, ...documentLinks];

      // Filter out external URLs early to avoid processing them later
      let links = combinedLinks;
      if (this.options && this.options.sameDomain === true && this.startUrl) {
        try {
          // Extract base domain from the starting URL
          const startUrlObj = new URL(this.startUrl);
          const baseDomain = startUrlObj.hostname;

          // Filter links to only include those from the same domain
          const internalLinks = combinedLinks.filter(link => {
            try {
              const linkObj = new URL(link);
              const linkHostname = linkObj.hostname;

              // Strict domain checking - exact hostname match
              const sameDomain = linkHostname === baseDomain;

              if (!sameDomain && this.debug) {
                logger.log('DEBUG', `Filtered external URL: ${link} (domain: ${linkHostname})`);
              }

              return sameDomain;
            } catch (e) {
              // If there's an error checking the domain, skip this link
              logger.error(`Error checking domain for link ${link}: ${e.message}`);
              return false;
            }
          });

          if (this.debug && internalLinks.length < allLinks.length) {
            logger.log(
              'DEBUG',
              `Filtered out ${allLinks.length - internalLinks.length} external URLs from ${normalizedUrl}`
            );
          }

          links = internalLinks;
        } catch (e) {
          logger.warn(`Error filtering external URLs: ${e.message}`);
          // Continue with all links if there was an error
        }
      }

      // Extract metadata from HTML
      const metadata = this.contentService.extractMetadata($);
      const title = metadata.title;

      // Convert to markdown and generate frontmatter
      // Pass the normalized URL as the base URL for link resolution
      const markdown = this.markdownService.toMarkdown(main, normalizedUrl);

      // Fast change detection - check if content has actually changed
      if (this.changeDetector && this.isReCrawl) {
        const changeResult = await this.changeDetector.checkForChanges(normalizedUrl, response, markdown);

        if (!changeResult.hasChanged) {
          logger.info(
            `[FAST_CHANGE] Skipping ${normalizedUrl} - ${changeResult.reason}: ${changeResult.skipReason || changeResult.etag || changeResult.lastModified || changeResult.hash}`
          );

          // Update only the timestamp, preserving content_status to avoid AI re-processing
          this.changeDetector.updateUnchangedPage(normalizedUrl);

          // Track as unchanged for statistics
          if (this.progressService) {
            this.progressService.stats.unchangedPages++;
            this.progressService.stats.crawledUrls++;
          }

          return; // Skip further processing - content hasn't changed
        }

        // Content has changed - log the change type
        logger.info(
          `[FAST_CHANGE] Processing ${normalizedUrl} - ${changeResult.reason}${changeResult.isNew ? ' (new)' : ' (updated)'}`
        );

        // Update statistics
        if (this.progressService) {
          if (changeResult.isNew) {
            this.progressService.stats.newPages++;
          } else {
            this.progressService.stats.updatedPages++;
          }
        }
      }

      // Use the extracted metadata
      const metaData = metadata || {};

      // Decode the URL for human-readable frontmatter
      let decodedUrl = normalizedUrl;
      try {
        decodedUrl = decodeURIComponent(normalizedUrl);
      } catch (e) {
        // If decoding fails, use the original URL
        logger.warn(`Failed to decode URL: ${normalizedUrl}`);
      }

      // Prepare comprehensive frontmatter with all available metadata
      const frontmatterData = {
        title: title || '',
        url: decodedUrl,
        crawled_at: new Date().toISOString(),
        // Safely access meta properties with fallbacks
        description: metaData.description || metaData.ogDescription || '',
        keywords: metaData.keywords || '',
        author: metaData.author || '',
        image: metaData.ogImage || ''
      };

      // Add any additional metadata that might be present
      if (metaData) {
        Object.keys(metaData).forEach(key => {
          // Only add if not already present and has a value
          if (!frontmatterData[key] && metaData[key]) {
            frontmatterData[key] = metaData[key];
          }
        });
      }

      // Filter out empty values
      Object.keys(frontmatterData).forEach(key => {
        if (!frontmatterData[key] || frontmatterData[key] === '') {
          delete frontmatterData[key];
        }
      });

      const markdownWithFrontmatter = this.markdownService.addFrontmatter(markdown, frontmatterData);

      // Generate safe filename
      const filename = this.urlService.safeFilename(normalizedUrl);

      // Write markdown file
      const {hostname} = new URL(normalizedUrl);
      logger.crawl(`Saving markdown for ${normalizedUrl}`);
      logger.crawl(`- Hostname: ${hostname}`);
      logger.crawl(`- Filename: ${filename}.md`);

      // Add blank lines at the end for better VS Code/Windsurf display
      const markdownWithBlankLines = markdownWithFrontmatter + '\n\n';

      let filePath = null;
      try {
        filePath = await this.fileService.saveMarkdown(hostname, filename + '.md', markdownWithBlankLines);
        logger.crawl(`- Saved to: ${filePath}`, true);

        // Save debug markdown if debug mode is enabled and we have removedBlocks
        logger.log('DEBUG', `Debug mode is ${this.debug ? 'enabled' : 'disabled'}`);
        logger.log('DEBUG', `removedBlocks is ${removedBlocks ? 'available' : 'not available'}`);

        if (this.debug && removedBlocks) {
          try {
            // Check if main is a valid object before generating debug markdown
            if (main && typeof main === 'object') {
              // Generate debug markdown content using our enhanced method
              const debugMarkdown = this.contentService.generateDebugMarkdown($, main, removedBlocks, normalizedUrl);
              logger.log('DEBUG', `Generated debug markdown: ${debugMarkdown ? 'yes' : 'no'}`);

              if (debugMarkdown) {
                // Get the base output directory
                const outputBaseDir = this.fileService.outputDir;

                // Save debug markdown
                await this.contentService.saveDebugInfo(normalizedUrl, debugMarkdown, filename);
              }
            } else {
              logger.log('DEBUG', `Skipping debug markdown generation: main content is ${main ? 'invalid' : 'null'}`);
            }
          } catch (err) {
            logger.error('[DEBUG] Error saving debug information:', err.message);
          }
        }
      } catch (err) {
        logger.error(`Error saving markdown file: ${err.message}`);
        logger.error(err.stack);
      }

      // Update page data with response headers and content hash
      // Save page data using FastChangeDetector for optimal hash storage
      if (this.changeDetector) {
        // Use FastChangeDetector to save page with extracted content hash
        // Mark as new content so it gets 'raw' status for AI processing
        this.changeDetector.updatePageData(normalizedUrl, response, markdown, filePath, true);

        // Update additional fields not handled by FastChangeDetector
        this.crawlStateService.upsertPage(normalizedUrl, {
          title: title || '',
          file_path: filePath || null
        });
      } else {
        // Fallback to basic page data saving
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');

        this.crawlStateService.upsertPage(normalizedUrl, {
          etag: etag || null,
          last_modified: lastModified || null,
          content_hash: contentHash || null,
          status: response.status,
          last_crawled: new Date().toISOString(),
          title: title || '',
          file_path: filePath || null
        });
      }

      // Successfully processed the page - add to found URLs list
      this.foundUrls.add(normalizedUrl);
      logger.crawl(`Added URL to found list: ${normalizedUrl} (${this.foundUrls.size}/${this.maxPages})`);
      this.totalUrlsMapped++;
      if (this.totalUrlsMapped % 100 === 0) {
        logger.crawl(`Total URLs mapped so far: ${this.totalUrlsMapped}`);
      }

      // Update progress bar with eligible URLs
      if (this.progressService) {
        // Always use eligible URLs for the total
        const totalEligible = this.eligibleUrls.size;
        this.progressService.updateStats({
          totalUrls: totalEligible,
          crawledUrls: this.foundUrls.size
        });
      }

      // Context enhancement integration - process in background (non-blocking)
      if (this.options.aiConfig && filePath && title) {
        // Track that AI enhancement is starting
        this.progressService.trackAIEnhancement(normalizedUrl, 'pending');

        // Start AI enhancement in background - don't await!
        import('../core/context_enrichment.js')
          .then(async ({enhanceSinglePage}) => {
            const db = this.contentService?.db;

            if (db && this.options.aiConfig.provider) {
              try {
                // Process enhancement asynchronously
                const enhanceResult = await enhanceSinglePage(normalizedUrl, filePath, this.options.aiConfig, db);

                if (enhanceResult && enhanceResult.success !== false) {
                  logger.crawl(`[CONTEXT] ✓ Enhanced: ${normalizedUrl}`, true);
                  this.progressService.trackAIEnhancement(normalizedUrl, 'success');
                } else {
                  logger.crawl(`[CONTEXT] ⚠️  Enhancement failed: ${normalizedUrl}`, true);
                  this.progressService.trackAIEnhancement(normalizedUrl, 'failed');
                }
              } catch (contextError) {
                // Context enhancement failure should not break the crawl
                logger.warn(`[CONTEXT] Enhancement failed for ${normalizedUrl}: ${contextError.message}`);
                this.progressService.trackAIEnhancement(normalizedUrl, 'failed');
              }
            }
          })
          .catch(importError => {
            logger.warn(`[CONTEXT] Failed to import enhancement module: ${importError.message}`);
            this.progressService.trackAIEnhancement(normalizedUrl, 'failed');
          });
      }

      // Mark download as complete in progress service
      this.progressService.completeUrl(normalizedUrl, 'success');

      // Store links for future reference
      let links_to_crawl = [];
      try {
        this.linkMap[normalizedUrl] = links;

        // Update total URLs mapped counter
        if (links && links.length) {
          this.totalUrlsMapped += links.length;
          logger.crawl(`Total URLs mapped so far: ${this.totalUrlsMapped}`);
        }

        // Only call saveLinks if it exists
        if (typeof this.crawlStateService.saveLinks === 'function') {
          this.crawlStateService.saveLinks(normalizedUrl, links);
        }

        links_to_crawl = links;

        // Immediately update progress bar with all discovered links
        if (this.progressService && links.length > 0) {
          // Count how many new URLs we're discovering (not already visited or queued)
          let newUrlCount = 0;
          for (const link of links) {
            const linkString = typeof link === 'object' ? link.href : link;
            const normalizedLink = this.urlService?.normalizeUrl
              ? this.urlService.normalizeUrl(linkString)
              : linkString;

            // Only count if not already visited or queued
            if (!this.visitedUrls.has(normalizedLink) && !this.queuedUrls.has(normalizedLink)) {
              // Apply same filtering rules as queueUrl
              if (this.urlFilter.shouldCrawlUrl(normalizedLink)) {
                // Check domain filtering for depth > 0
                if (depth === 0 || !this.options.sameDomain || this.isInternalUrl(normalizedLink)) {
                  // In sitemap-first mode, don't add new URLs to eligible set
                  // The sitemap already gave us all URLs we should crawl
                  if (!this._sitemapFirstMode) {
                    // Only count if not already in eligible URLs
                    if (!this.eligibleUrls.has(normalizedLink)) {
                      this.eligibleUrls.add(normalizedLink);
                      newUrlCount++;
                    }
                  } else {
                    // In sitemap mode, just count for logging but don't add to eligible
                    if (!this.eligibleUrls.has(normalizedLink)) {
                      newUrlCount++;
                    }
                  }
                }
              }
            }
          }

          if (newUrlCount > 0) {
            logger.info(`Discovered ${newUrlCount} new eligible URLs from ${normalizedUrl}`);

            // In sitemap-first mode, don't update the total - it's already set from sitemap
            if (!this._sitemapFirstMode) {
              // Only update progress total if we're not in sitemap-first mode
              const totalEligible = this.eligibleUrls.size;
              // If maxPages is set, use the minimum of eligible URLs and maxPages
              const progressTotal = this.maxPages ? Math.min(totalEligible, this.maxPages) : totalEligible;

              this.progressService.updateStats({
                totalUrls: progressTotal,
                queuedUrls: this.queuedUrls.size
              });

              logger.info(`Updated total eligible to: ${progressTotal} (${totalEligible} eligible, limit: ${this.maxPages || 'none'})`);
            } else {
              // In sitemap mode, just update the queue count
              this.progressService.updateStats({
                queuedUrls: this.queuedUrls.size
              });
            }

            if (this.debug) {
              logger.debug(`[ELIGIBLE] Current eligible URLs count: ${this.eligibleUrls.size}`);
              logger.debug(`[ELIGIBLE] Links found: ${links.length}, New eligible: ${newUrlCount}`);
            }
          }
        }
      } catch (err) {
        logger.error(`Error saving links: ${err.message}`);
        // Continue with empty links if there was an error
      }

      // Process links recursively
      for (const link of links_to_crawl) {
        // Skip if we've reached the page limit
        if (this.foundUrls.size >= this.maxPages) {
          logger.crawl(`Reached max pages limit during link processing: ${this.foundUrls.size}/${this.maxPages}`);
          throw new CrawlLimitReached('Crawl limit reached');
        }

        // Skip if we've already visited or queued this URL - no logging needed for in-memory checks
        if (this.visitedUrls.has(link) || this.queuedUrls.has(link)) {
          continue;
        }

        // Ensure link is a string before recursive crawl
        const linkString = typeof link === 'object' ? link.href : link;

        // Crawl the link
        await this.crawl(linkString, depth + 1);
      }
    } catch (err) {
      if (err instanceof CrawlLimitReached) {
        // Re-throw to stop the crawl
        throw err;
      }
      logger.error(`Error crawling ${normalizedUrl}: ${err.message}`);
    }
  }
  /**
   * Check if a URL is internal (same domain as base)
   * @param {string} url - URL to check
   * @returns {boolean} - True if internal
   */
  isInternalUrl(url) {
    try {
      const urlObj = new URL(url);
      const urlHostname = urlObj.hostname;

      // Get base domain if not already set
      if (!this.baseDomain && this.startUrl) {
        const startUrlObj = new URL(this.startUrl);
        this.baseDomain = startUrlObj.hostname;
      }

      return this.baseDomain && urlHostname === this.baseDomain;
    } catch (err) {
      return false;
    }
  }

  calculateContentHash(content) {
    // Simple hash function for strings
    // This is a basic implementation - for production, consider using crypto.createHash
    let hash = 0;
    if (content.length === 0) return hash.toString(16);

    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return hash.toString(16);
  }

  /**
   * Calculate hash for binary content
   * @param {ArrayBuffer} buffer - Binary content to hash
   * @returns {string} - Content hash
   */
  calculateBinaryHash(buffer) {
    // Create a view of the buffer as 8-bit integers
    const view = new Uint8Array(buffer);
    let hash = 0;

    // Only hash a sample of the buffer for efficiency if it's large
    // For files > 1MB, we'll sample at regular intervals
    const length = view.length;
    const sampleSize = length > 1024 * 1024 ? 1024 : length;
    const step = Math.max(1, Math.floor(length / sampleSize));

    for (let i = 0; i < length; i += step) {
      const byte = view[i];
      hash = (hash << 5) - hash + byte;
      hash = hash & hash; // Convert to 32bit integer
    }

    return hash.toString(16);
  }

  /**
   * Checks if a content type represents a binary file
   * @param {string} contentType - Content type to check
   * @returns {boolean} - Whether the content type represents a binary file
   * @private
   */
  isBinaryFile(contentType) {
    if (!contentType) return false;

    const binaryTypes = [
      // Document formats
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/vnd.ms-word',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.oasis.opendocument',
      'application/rtf',
      'application/x-rtf',
      'text/rtf',

      // Archive formats
      'application/zip',
      'application/x-zip-compressed',
      'application/x-rar-compressed',
      'application/x-7z-compressed',
      'application/x-tar',
      'application/x-gzip',

      // Binary data
      'application/octet-stream',

      // Media formats
      'image/',
      'audio/',
      'video/',

      // Other common binary formats
      'application/x-shockwave-flash',
      'application/x-silverlight',
      'application/x-ms-application'
    ];

    const result = binaryTypes.some(type => contentType.toLowerCase().includes(type));
    if (result) {
      logger.info(`[BINARY] Detected binary file with content type: ${contentType}`);
    }
    return result;
  }

  /**
   * Handles a binary file
   * @param {string} url - URL of the binary file
   * @param {Response} response - Fetch response object
   * @param {string} contentType - Content type of the binary file
   * @param {string} [resourceName] - Optional resource name from URL parameter
   * @returns {Promise<void>}
   */
  async handleBinaryFile(url, response, contentType, resourceName) {
    logger.info(`[BINARY_TRACKING] Handling binary file: ${url} (${contentType})`);
    if (resourceName) {
      logger.info(`[BINARY_TRACKING] Resource parameter: ${resourceName}`);
    }

    try {
      // Get the binary data
      const buffer = await response.arrayBuffer();

      // Calculate binary hash for caching
      const binaryHash = this.calculateBinaryHash(buffer);

      // Check if we've already processed this binary file
      let skipProcessing = false;
      if (this.crawlStateService && typeof this.crawlStateService.getPageHash === 'function') {
        // Check in-memory cache first (fastest)
        if (this.contentHashes.has(url)) {
          const cachedHash = this.contentHashes.get(url);
          if (cachedHash === binaryHash) {
            if (this.debug) {
              logger.info(`[CACHE] Binary file unchanged (in-memory): ${url}`);
            }
            skipProcessing = true;
          }
        } else {
          // Check database cache
          const previousHash = await this.crawlStateService.getPageHash(url);
          if (previousHash && previousHash === binaryHash) {
            if (this.debug) {
              logger.info(`[CACHE] Binary file unchanged (database): ${url}`);
            }
            skipProcessing = true;
          }
        }

        // Update caches regardless
        this.contentHashes.set(url, binaryHash);
        if (typeof this.crawlStateService.savePageHash === 'function') {
          await this.crawlStateService.savePageHash(url, binaryHash);
        }
      }

      // Skip processing if content hasn't changed
      if (skipProcessing) {
        return;
      }

      if (this.fileService) {
        // Extract hostname for folder structure
        let hostname;
        try {
          const urlObj = new URL(url);
          hostname = urlObj.hostname;
        } catch (err) {
          logger.warn(`[BINARY] Error parsing URL: ${url}, ${err.message}`);
          hostname = 'unknown-host';
        }

        // Determine filename
        let filename;

        // First try to use resourceName if available (from URL parameter)
        if (resourceName) {
          logger.info(`[BINARY] Using resource name: ${resourceName}`);
          filename = resourceName;
        } else {
          // Otherwise extract from path or generate hash
          try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/');
            const lastPart = pathParts[pathParts.length - 1];

            if (lastPart && lastPart.includes('.')) {
              filename = lastPart;
              if (this.debug) {
                logger.info(`[BINARY] Using pathname for filename: ${filename}`);
              }
            } else {
              // Generate a filename based on URL hash
              const urlHash = this.calculateContentHash(url);

              // Determine extension from content type
              let extension = '';
              if (contentType.includes('pdf')) {
                extension = '.pdf';
              } else if (contentType.includes('word') || contentType.includes('docx')) {
                extension = '.docx';
              } else if (contentType.includes('excel') || contentType.includes('xlsx')) {
                extension = '.xlsx';
              } else if (contentType.includes('powerpoint') || contentType.includes('pptx')) {
                extension = '.pptx';
              } else {
                // Default extension based on content type
                const mainType = contentType.split('/')[1] || 'bin';
                extension = `.${mainType}`;
              }

              filename = `document-${urlHash}${extension}`;
              if (this.debug) {
                logger.info(`[BINARY] Generated filename: ${filename}`);
              }
            }
          } catch (err) {
            logger.warn(`[BINARY] Error determining filename: ${err.message}`);
            // Fallback to a generic filename with timestamp
            filename = `document-${Date.now()}.bin`;
          }
        }

        // Save the binary file
        logger.info(`[BINARY_TRACKING] Saving binary file: ${filename} to ${hostname}/documents`);
        const savedPath = await this.fileService.saveBinaryFile(buffer, `${hostname}/documents`, filename);
        logger.info(`[BINARY_TRACKING] Successfully saved binary file: ${savedPath}`);

        // Mark download as complete in progress service
        this.progressService.completeUrl(url, 'success');

        // Log detailed information about the saved file
        const fileExtension = filename.split('.').pop().toLowerCase();
        logger.info(`[BINARY_TRACKING] File type: ${fileExtension}, Size: ${buffer.byteLength} bytes`);
        if (fileExtension === 'pdf' || fileExtension === 'docx' || fileExtension === 'doc') {
          logger.info(`[BINARY_TRACKING] Document file saved: ${savedPath} (${contentType})`);
        }

        // Update crawl state if available
        if (this.crawlStateService && typeof this.crawlStateService.savePage === 'function') {
          await this.crawlStateService.savePage(url, {
            title: filename,
            content_type: contentType,
            file_path: savedPath,
            is_binary: true,
            file_size: buffer.length,
            content_hash: binaryHash // Store the binary hash
          });
        }
        
        // Add to foundUrls to count towards the limit (treat as first-class page)
        this.foundUrls.add(url);
        logger.info(`[BINARY_TRACKING] Added binary file to foundUrls: ${url} (${this.foundUrls.size}/${this.maxPages})`);
        
        // Update database to track for efficient re-crawls
        if (this.contentService?.db) {
          const pageData = {
            url: url,
            etag: response.headers?.get('etag') || null,
            last_modified: response.headers?.get('last-modified') || null,
            content_hash: binaryHash,
            status: response.status || 200,
            last_crawled: new Date().toISOString(),
            title: filename,
            file_path: savedPath,
            is_binary: true,
            content_type: contentType
          };
          this.contentService.db.upsertPage(pageData);
          logger.info(`[BINARY_TRACKING] Saved binary file to database for re-crawl tracking`);
        }
      } else {
        logger.warn('[BINARY] FileService not available, skipping binary file save');
      }
    } catch (error) {
      logger.error(`[BINARY] Error handling binary file ${url}: ${error.message}`);
    }
  }

  /**
   * Process sitemaps for a domain
   * @param {string} domain - Domain to process sitemaps for
   * @returns {Promise<string[]>} - Array of URLs found in sitemaps
   */
  async processSitemaps(domain) {
    logger.info(`Processing sitemaps for ${domain}`);
    try {
      const sitemapUrls = await this.sitemapService.getAllSitemapUrls(domain);
      if (sitemapUrls.length > 0) {
        logger.info(`Found ${sitemapUrls.length} URLs in sitemaps`);

        // Filter sitemap URLs and only add eligible ones to the queue
        let eligibleCount = 0;
        for (const url of sitemapUrls) {
          if (!this.visitedUrls.has(url) && !this.queuedUrls.has(url)) {
            // Apply URL filtering to check if this URL should be crawled
            if (this.urlFilter.shouldCrawlUrl(url)) {
              // Also check domain filtering if enabled
              if (!this.options.sameDomain || this.isInternalUrl(url)) {
                this.queuedUrls.add(url);
                this.eligibleUrls.add(url);
                eligibleCount++;
              }
            }
          }
        }

        logger.info(`Filtered to ${eligibleCount} eligible URLs from ${sitemapUrls.length} sitemap URLs`);
        logger.info(`Total eligible URLs after sitemap processing: ${this.eligibleUrls.size}`);

        // Update progress bar total with eligible URLs only, considering limit
        if (this.progressService) {
          const totalEligible = this.eligibleUrls.size;
          // If maxPages is set, use the minimum of eligible URLs and maxPages
          const progressTotal = this.maxPages ? Math.min(totalEligible, this.maxPages) : totalEligible;
          this.progressService.updateStats({
            totalUrls: progressTotal,
            queuedUrls: this.queuedUrls.size
          });
          logger.info(`Updated progress total to ${progressTotal} (${totalEligible} eligible, limit: ${this.maxPages || 'none'})`);
        }

        return sitemapUrls;
      } else {
        logger.info('No sitemap URLs found');
        return [];
      }
    } catch (error) {
      logger.warn(`Error processing sitemaps for ${domain}: ${error.message}`);
      return [];
    }
  }

  /**
   * Extract document links from a page and return them for queueing
   * Documents will be processed through the normal crawl queue
   * @param {Object} $ - Cheerio instance of the page
   * @param {string} pageUrl - URL of the page containing documents
   * @returns {Array<string>} - Array of document URLs found
   * @private
   */
  extractDocumentLinks($, pageUrl) {
    const documentUrls = [];
    // Only download document types that contain searchable text content
    const downloadableExtensions = ['.pdf', '.doc', '.docx', '.odt', '.rtf'];
    
    const allLinks = $('a[href]').length;
    if (logger.verbose) {
      logger.info(`[DOCS] Checking ${allLinks} links on ${pageUrl}`);
    }
    
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        // Check if the link has a searchable document extension
        const hasDownloadableExt = downloadableExtensions.some(ext => 
          href.toLowerCase().endsWith(ext) || href.toLowerCase().includes(ext + '?')
        );
        
        if (hasDownloadableExt) {
          try {
            // Resolve to absolute URL
            const absoluteUrl = new URL(href, pageUrl).href;
            const normalizedUrl = this.urlService.normalizeUrl(absoluteUrl);
            documentUrls.push(normalizedUrl);
          } catch (e) {
            // Invalid URL, skip
            if (logger.verbose) {
              logger.info(`[DOCS] Invalid document URL: ${href}`);
            }
          }
        }
      }
    });

    if (documentUrls.length > 0) {
      logger.info(`[DOCS] Found ${documentUrls.length} document links on ${pageUrl}`);
    }
    
    return documentUrls;
  }

  /**
   * Download documents (PDFs, DOCX, etc.) from external domains directly
   * This bypasses the normal crawl queue and domain filtering
   * @param {Object} $ - Cheerio instance of the page
   * @param {string} pageUrl - URL of the page containing documents
   * @returns {Promise<void>}
   * @private
   */
  async downloadExternalDocuments($, pageUrl) {
    const downloadableExtensions = ['.pdf', '.doc', '.docx', '.odt', '.rtf'];
    const downloads = [];
    
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        // Check if the link has a downloadable extension
        const hasDownloadableExt = downloadableExtensions.some(ext => 
          href.toLowerCase().endsWith(ext) || href.toLowerCase().includes(ext + '?')
        );
        
        if (hasDownloadableExt) {
          try {
            // Resolve to absolute URL
            const absoluteUrl = new URL(href, pageUrl).href;
            downloads.push(absoluteUrl);
          } catch (e) {
            if (logger.verbose) {
              logger.info(`[DOCS] Invalid document URL: ${href}`);
            }
          }
        }
      }
    });

    if (downloads.length === 0) return;
    
    logger.info(`[DOCS] Found ${downloads.length} document links on ${pageUrl}`);
    
    // Download each document
    for (const docUrl of downloads) {
      // Skip if we've reached the page limit
      if (this.foundUrls.size >= this.maxPages) {
        logger.info(`[DOCS] Reached max pages limit, skipping remaining documents`);
        break;
      }
      
      // Skip if already downloaded
      if (this.visitedUrls.has(docUrl)) {
        continue;
      }
      
      try {
        logger.info(`[DOCS] Downloading document: ${docUrl}`);
        
        // Mark as visited to prevent duplicates
        this.visitedUrls.add(docUrl);
        
        // Fetch the document
        const response = await fetch(docUrl);
        if (!response.ok) {
          logger.warn(`[DOCS] Failed to download document: ${response.status} ${response.statusText}`);
          continue;
        }
        
        // Get the document data
        const buffer = await response.arrayBuffer();
        
        // Determine filename from URL
        const urlObj = new URL(docUrl);
        let filename = path.basename(urlObj.pathname);
        
        // If filename is empty, generate one
        if (!filename || !path.extname(filename)) {
          const contentType = response.headers.get('content-type') || '';
          let extension = '.bin';
          if (contentType.includes('pdf')) extension = '.pdf';
          else if (contentType.includes('word') || contentType.includes('docx')) extension = '.docx';
          filename = `document-${Date.now()}${extension}`;
        }
        
        // Save the document
        const {hostname} = new URL(pageUrl);
        const savedPath = await this.fileService.saveBinaryFile(
          Buffer.from(buffer), 
          hostname, 
          filename
        );
        
        logger.info(`[DOCS] Saved document to: ${savedPath}`);
        
        // Add to foundUrls to count towards limit
        this.foundUrls.add(docUrl);
        logger.info(`[DOCS] Document counted towards limit: ${this.foundUrls.size}/${this.maxPages}`);
        
        // Save to database for re-crawl tracking
        if (this.contentService?.db) {
          const pageData = {
            url: docUrl,
            etag: response.headers.get('etag') || null,
            last_modified: response.headers.get('last-modified') || null,
            content_hash: this.calculateBinaryHash(buffer),
            status: response.status,
            last_crawled: new Date().toISOString(),
            title: filename,
            file_path: savedPath,
            is_binary: true,
            content_type: response.headers.get('content-type') || 'application/octet-stream'
          };
          this.contentService.db.upsertPage(pageData);
        }
        
        // Update progress
        if (this.progressService) {
          this.progressService.updateStats({
            crawledUrls: this.visitedUrls.size,
            assets: {
              documents: (this.assetStats.documents || 0) + 1,
              total: (this.assetStats.total || 0) + 1
            }
          });
        }
        
      } catch (error) {
        logger.error(`[DOCS] Error downloading document ${docUrl}: ${error.message}`);
      }
    }
  }
}

// Export FastChangeDetector for testing
export {FastChangeDetector};
