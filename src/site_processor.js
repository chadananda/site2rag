import {URL} from 'url';
import {CrawlLimitReached} from './utils/errors.js';
// Service imports
import {UrlService} from './services/url_service.js';
import {FetchService} from './services/fetch_service.js';
import {ContentService} from './services/content_service.js';
import {MarkdownService} from './services/markdown_service.js';
import {FileService} from './services/file_service.js';
import {CrawlService} from './services/crawl_service.js';
import {getDB} from './db.js';
import {DefaultCrawlState} from './core/crawl_state.js';
import logger from './services/logger_service.js';
import fs from 'fs';
import path from 'path';
/**
 * Main site processor that coordinates the crawling and processing pipeline
 */
export class SiteProcessor {
  /**
   * Creates a new SiteProcessor instance
   * @param {string} startUrl - URL to start crawling from
   * @param {Object} options - Configuration options
   * @param {number} options.limit - Maximum pages to crawl
   * @param {number} options.maxDepth - Maximum crawl depth
   * @param {number} options.politeWaitMs - Time to wait between requests in ms
   * @param {string} options.outputDir - Output directory for markdown files
   * @param {Object} options.aiConfig - AI service configuration
   */
  constructor(startUrl, options = {}) {
    let hostname, domain;
    try {
      // Try to parse the URL (will throw if invalid)
      const url = new URL(startUrl);
      hostname = url.hostname;
      domain = url.origin;
    } catch (err) {
      // Handle case where startUrl isn't a valid URL (e.g., a file path)
      hostname = startUrl.split('/').pop() || 'output';
      domain = '';
      logger.warn(`'${startUrl}' is not a valid URL. Using '${hostname}' as output directory name.`);
    }
    // Create a unified options object with all configuration values
    this.options = {
      startUrl,
      domain,
      maxPages: options.limit !== undefined ? options.limit : -1,
      maxDepth: options.maxDepth !== undefined ? options.maxDepth : -1,
      politeWaitMs: options.politeWaitMs || 1000,
      outputDir: options.outputDir || options.output || `./${hostname}`,
      aiConfig: options.aiConfig || {},
      debug: options.debug || false,
      flat: options.flat || false,
      enhancement: options.enhancement !== undefined ? options.enhancement : true, // Enable enhancement by default
      test: options.test || false, // Test mode for insertion tracking
      // Explicitly set sameDomain to true by default unless explicitly disabled
      sameDomain: options.sameDomain !== false
    };

    // Configure logger based on debug option
    logger.configure({debug: this.options.debug});

    // Log important configuration details
    logger.info(`Max depth: ${this.options.maxDepth}`, true);
    logger.info(`Limit: ${this.options.maxPages} pages`, true);
    logger.info(`Crawling: ${this.options.domain}`, true);
    logger.info(`Output dir: ${this.options.outputDir}`, true);

    // Log domain filtering status
    if (this.options.sameDomain) {
      logger.domainFilter(`Domain filtering enabled, restricting to: ${hostname}`);
    } else {
      logger.domainFilter(`Domain filtering explicitly disabled, will crawl external domains`);
    }
    // Initialize services as instance properties
    const {outputDir, politeWaitMs, aiConfig, debug, flat} = this.options;
    this.fileService = new FileService({outputDir, flat});
    this.urlService = new UrlService();
    this.fetchService = new FetchService({politeWaitMs});

    // Create database and crawl state if not provided
    let db = null;
    if (options.crawlState) {
      this.crawlStateService = options.crawlState;
      db = this.crawlStateService.db;
    } else {
      // Create database and DefaultCrawlState for proper database integration
      const dbPath = path.join(outputDir, '.site2rag');
      db = getDB(dbPath);
      this.crawlStateService = new DefaultCrawlState(db);
    }

    this.contentService = new ContentService({aiConfig, debug, outputDir, db});
    this.markdownService = new MarkdownService();
    // Copy configuration options to instance properties for backward compatibility
    Object.assign(this, this.options);
    // Proxy methods for backward compatibility
    /**
     * Proxy method to FetchService.fetchRobotsTxt for backward compatibility
     * @param {string} domain - Domain to fetch robots.txt from
     * @returns {Promise<boolean>} - Whether robots.txt was successfully fetched
     */
    this.fetchRobotsTxt = async (domain = this.options.domain) => {
      return await this.fetchService.fetchRobotsTxt(domain);
    };
    /**
     * Proxy method to FetchService.canCrawl for backward compatibility
     * @param {string} url - URL to check
     * @returns {boolean} - Whether the URL can be crawled
     */
    this.canCrawl = url => {
      return this.fetchService.canCrawl(url);
    };
    // Define getter for robots property
    Object.defineProperty(this, 'robots', {
      get: () => this.fetchService.robots
    });
    // Create the main crawl service that coordinates everything
    this.crawlService = new CrawlService({
      ...this.options,
      fileService: this.fileService,
      urlService: this.urlService,
      fetchService: this.fetchService,
      contentService: this.contentService,
      markdownService: this.markdownService,
      crawlStateService: this.crawlStateService,
      debug: debug
    });
    // State tracking for this instance
    this.visited = new Set();
    this.found = [];
    this.linkMap = {};
  }
  /**
   * Process the site by crawling it and running post-processing
   * @returns {Promise<string[]>} - Array of crawled URLs
   */
  async process() {
    logger.info(
      `SiteProcessor.process: Starting with domain=${this.options.domain}, outputDir=${this.options.outputDir}`,
      true
    );

    // Ensure output directory exists
    if (!fs.existsSync(this.options.outputDir)) {
      logger.info(`Creating output directory: ${this.options.outputDir}`);
      fs.mkdirSync(this.options.outputDir, {recursive: true});
    }

    // Create .site2rag directory inside output directory
    const site2ragDir = path.join(this.options.outputDir, '.site2rag');
    if (!fs.existsSync(site2ragDir)) {
      logger.info(`Creating .site2rag directory: ${site2ragDir}`);
      fs.mkdirSync(site2ragDir, {recursive: true});
    }

    this.visited = new Set();
    this.found = [];
    try {
      logger.info(`Processing sitemaps...`, true);
      await this.crawlService.processSitemaps(this.options.domain);
      logger.info(`Starting site crawl...`, true);
      this.found = await this.crawlService.crawlSite(this.options.startUrl);
      logger.info(`Crawl complete. Processed ${this.crawlService.foundUrls.length} URLs.`, true);
      if (this.found.length === 1 && this.options.maxDepth === 0) {
        logger.info('Single page crawl completed, skipping post-processing');
        return this.found;
      }
      logger.info('Running post-crawl pipeline...');
      await this.runPostCrawlPipeline();
      logger.info('Post-crawl pipeline completed');
    } catch (err) {
      if (!(err instanceof CrawlLimitReached)) {
        logger.error('Error during crawl:', err);
        throw err;
      } else {
        logger.info('Crawl limit reached, stopping crawl');
      }
    }
    return this.found;
  }
  /**
   * Runs the post-crawl pipeline for context enrichment and PDF conversion
   * @returns {Promise<void>}
   * @private
   */
  async runPostCrawlPipeline() {
    try {
      // Validate domain before using it
      let hostname = '';
      if (this.options.domain) {
        try {
          const url = new URL(this.options.domain);
          hostname = url.hostname;
        } catch (urlError) {
          logger.warn(`Invalid domain URL: ${this.options.domain}. Using fallback hostname.`);
          // Use the domain string as hostname if it's not a valid URL
          hostname = this.options.domain.replace(/[^a-zA-Z0-9.-]/g, '');
        }
      } else {
        logger.warn('No domain provided for post-crawl pipeline. Using default hostname.');
        hostname = 'unknown-domain';
      }

      // Save final crawl state if the method exists
      if (this.crawlStateService && typeof this.crawlStateService.saveState === 'function') {
        await this.crawlStateService.saveState(hostname);
      }

      // Main AI enhancement process
      if (
        this.options.enhancement &&
        this.options.aiConfig &&
        (this.options.aiConfig.provider || this.options.aiConfig.type === 'fallback')
      ) {
        try {
          const {runContextEnrichment, insertionTracker} = await import('./core/context_processor.js');
          const dbInstance = this.contentService.db;

          // Start insertion tracking session if test mode is enabled
          if (this.options.test) {
            insertionTracker.enabled = true;
            const sessionId = `${this.options.startUrl.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;

            // Get the actual LLM config for tracking
            const trackingConfig =
              this.options.aiConfig.type === 'fallback'
                ? this.options.aiConfig.availableLLMs[0]
                : this.options.aiConfig;

            insertionTracker.startSession(sessionId, trackingConfig);
            logger.info(`Started LLM enhancement session: ${trackingConfig.provider}/${trackingConfig.model}`);
          }

          // Run the main context enrichment for all raw pages
          if (this.options.aiConfig.type === 'fallback') {
            // For fallback config, use the first available LLM
            const firstLLM = this.options.aiConfig.availableLLMs[0];
            console.log(`[CONTEXT] Using first fallback LLM: ${firstLLM.fallbackName}`);
            await runContextEnrichment(dbInstance, firstLLM);
          } else {
            // Regular AI config
            await runContextEnrichment(dbInstance, this.options.aiConfig);
          }

          // Log insertion tracking summary if test mode was enabled
          if (this.options.test && insertionTracker.enabled) {
            insertionTracker.logSessionSummary();
          }
        } catch (error) {
          logger.error(`[CONTEXT] AI enhancement failed: ${error.message}`);
        }
      } else if (!this.options.enhancement) {
        logger.info('[CONTEXT] AI enhancement disabled by --no-enhancement flag');
      } else if (
        !this.options.aiConfig ||
        (!this.options.aiConfig.provider && this.options.aiConfig.type !== 'fallback')
      ) {
        logger.info('[CONTEXT] AI enhancement skipped - no AI configuration available');
      }

      // Context enhancement cleanup - retry failed/rate-limited pages
      try {
        const {enhanceSinglePage} = await import('./core/context_processor.js');
        const dbInstance = this.contentService.db;

        if (dbInstance && this.options.aiConfig && this.options.aiConfig.provider) {
          // Find pages that need context enhancement retry
          const retryStmt = dbInstance.db.prepare(`
            SELECT url, file_path 
            FROM pages 
            WHERE content_status IN ('rate_limited', 'timeout', 'failed', 'processing') 
            AND file_path IS NOT NULL
          `);
          const retryPages = retryStmt.all();

          if (retryPages.length > 0) {
            logger.info(`[CONTEXT] Retrying context enhancement for ${retryPages.length} failed pages`);

            for (const page of retryPages) {
              try {
                // Add delay between retries to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 2000));

                const result = await enhanceSinglePage(page.url, page.file_path, this.options.aiConfig, dbInstance);

                if (result.success) {
                  logger.info(`[CONTEXT] ✓ Retry success: ${page.url}`);
                } else {
                  logger.warn(`[CONTEXT] ⚠️  Retry failed: ${page.url} - ${result.error}`);
                }
              } catch (retryError) {
                logger.warn(`[CONTEXT] Retry error for ${page.url}: ${retryError.message}`);
              }
            }
          } else {
            logger.info(`[CONTEXT] No pages need context enhancement retry`);
          }
        }
      } catch (contextErr) {
        logger.error(`Context enhancement cleanup error: ${contextErr.message}`);
      }

      // PDF conversion (if enabled)
      if (this.options.aiConfig && this.options.aiConfig.pdfApiEnabled) {
        try {
          // await runPdfConversionTask(dbInstance, this.options.aiConfig); // Implement as needed
        } catch (pdfErr) {
          logger.error(`PDF conversion error: ${pdfErr.message}`);
        }
      }

      // PDF-generated markdown would be processed by the same integrated enhancement system
    } catch (err) {
      throw err;
    }
  }
}
// Command-line interface for quick testing
if (process.env.NODE_ENV !== 'test' && process.argv[1] && process.argv[1].endsWith('site_processor.js')) {
  // Handle --help flag
  if (!process.argv[2] || process.argv[2] === '--help' || process.argv[2] === '-h') {
    logger.info('Usage: node src/site_processor.js <url> [limit]');
    logger.info('Example: node src/site_processor.js https://example.com 10');
    process.exit(0);
  }
  const url = process.argv[2];
  const limit = parseInt(process.argv[3] || '5', 10);
  (async () => {
    try {
      // Validate URL before proceeding
      try {
        new URL(url); // This will throw if URL is invalid
      } catch (e) {
        logger.error(`'${url}' is not a valid URL. Please provide a URL with protocol (e.g., https://example.com)`);
        process.exit(1);
      }
      logger.info(`Starting crawl of ${url} with limit ${limit}...`, true);
      const sp = new SiteProcessor(url, {limit});
      const found = await sp.process();
      logger.info(`Crawled ${found.length} pages: ${found.join(', ')}`, true);
    } catch (err) {
      logger.error(`Error during crawl: ${err.message}`);
      process.exit(1);
    }
  })();
}
