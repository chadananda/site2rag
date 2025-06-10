import path from 'path';
import fs from 'fs';
import { URL } from 'url';
import { CrawlLimitReached } from '../errors.js';

import logger from './logger_service.js';

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
    this.maxPages = options.maxPages || 100;
    this.maxDepth = options.maxDepth || -1;
    this.urlService = options.urlService;
    this.fetchService = options.fetchService;
    this.fileService = options.fileService;
    this.contentService = options.contentService;
    this.markdownService = options.markdownService;
    this.crawlStateService = options.crawlStateService;
    
    // Efficient URL tracking to minimize redundant processing
    this.visitedUrls = new Set(); // URLs already processed in this session
    this.queuedUrls = new Set(); // URLs in the queue to be processed
    this.foundUrls = []; // URLs successfully processed
    this.contentHashes = new Map(); // In-memory cache of URL content hashes for this session
    this.linkMap = {}; // Map of source URLs to their outbound links
    
    this.activeCrawls = 0;
    this.maxConcurrency = options.maxConcurrency || 5; // Default is already 5, keeping it here for clarity
    this.debug = options.debug === true; // Ensure it's a boolean
    this.totalUrlsMapped = 0; // Counter for total URLs mapped
    
    // Configure logger based on debug option
    logger.configure({ debug: this.debug });
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
    }
    
    // Initialize fetch service (loads robots.txt) if domain is valid
    if (this.domain) {
      try {
        await this.fetchService.fetchRobotsTxt(this.domain);
      } catch (err) {
        logger.warn(`Could not fetch robots.txt for '${this.domain}': ${err.message}`);
      }
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
      if (this.crawlStateService && typeof this.crawlStateService.getAllPages === 'function') {
        logger.info('[CACHE] Loading content hashes from previous session...');
        const previousPages = await this.crawlStateService.getAllPages();
        if (previousPages && previousPages.length > 0) {
          logger.info(`[CACHE] Loaded ${previousPages.length} pages from previous session`);
          
          // Populate in-memory content hash cache
          let hashCount = 0;
          for (const page of previousPages) {
            if (page.url && page.content_hash) {
              this.contentHashes.set(page.url, page.content_hash);
              hashCount++;
            }
          }
          
          logger.info(`[CACHE] Preloaded ${hashCount} content hashes into memory cache`);
        }
      }
      
      logger.info('Starting recursive crawl...');
      await this.crawl(url, 0);
      logger.info(`Crawl completed with ${this.foundUrls.length} URLs found`);
      return this.foundUrls;
    } catch (err) {
      if (err instanceof CrawlLimitReached) {
        logger.info(`Crawl limit reached after ${this.foundUrls.length} URLs`);
        // This is an expected condition, not an error
        return this.foundUrls;
      }
      logger.error('Error during crawl:', err);
      throw err;
    } finally {
      // Abort any pending requests
      this.fetchService.abortAll();
    }
  }

  /**
   * Adds a URL to the crawl queue if it's not already visited or queued
   * @param {string} url - URL to add to the queue
   * @param {number} depth - Current crawl depth
   */
  async queueUrl(url, depth) {
    if (this.foundUrls.length >= this.options.maxPages) return;
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
    
    // Add to queue
    this.queuedUrls.add(normalizedUrl);
    
    // Recursively crawl this URL
    await this.crawl(normalizedUrl, depth + 1);
  }

  /**
   * Crawls a URL and processes its content
   * @param {string} url - URL to crawl
   * @param {number} depth - Current crawl depth
   */
  async crawl(url, depth = 0) {
    // Normalize URL
    let normalizedUrl = url;
    if (this.urlService && this.urlService.normalizeUrl) {
      normalizedUrl = this.urlService.normalizeUrl(url);
    }
    
    // Skip if this URL has already been visited - no need to log for in-memory checks
    if (this.visitedUrls.has(normalizedUrl)) {
      return;
    }
    
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
          logger.domainFilter(`Skipping external URL: ${normalizedUrl} (domain: ${urlHostname}, not in base domain: ${this.baseDomain})`);
          return;
        }
      } catch (err) {
        logger.warn(`Error checking domain for ${normalizedUrl}: ${err.message}`);
        return;
      }
    }
    
    // Domain filtering is now handled at the beginning of the crawl method
    
    // Skip if this URL is already in the queue - no need to log for in-memory checks
    if (this.queuedUrls.has(normalizedUrl)) {
      return;
    }
    
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
          await this.crawlStateService.queueUrl(normalizedUrl, { resourceType: 'binary', resourceParam });
          logger.info(`[BINARY_TRACKING] Added binary resource to queue: ${resourceParam}`);
        }
        
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
            const response = await fetch(url, { timeout: this.options.timeout });
            
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
            if (this.crawlStateService && typeof this.crawlStateService.getPageHash === 'function' && 
                typeof this.crawlStateService.savePageHash === 'function') {
              
              const responseClone = resourceResponse.clone();
              const content = await responseClone.text();
              const contentHash = this.calculateContentHash(content);
              
              // Check in-memory cache first
              if (this.contentHashes.has(normalizedUrl)) {
                const cachedHash = this.contentHashes.get(normalizedUrl);
                if (cachedHash === contentHash) {
                  contentChanged = false;
                  logger.cache(`Content unchanged (in-memory): ${normalizedUrl}`);
                }
              } else {
                // Check database cache
                const previousHash = await this.crawlStateService.getPageHash(normalizedUrl);
                if (previousHash && previousHash === contentHash) {
                  contentChanged = false;
                  logger.cache(`Content unchanged for ${normalizedUrl}, using cached version`);
                } else if (previousHash) {
                  logger.cache(`Content changed for ${normalizedUrl}, processing new version`);
                }
              }
              
              // Update caches
              this.contentHashes.set(normalizedUrl, contentHash);
              await this.crawlStateService.savePageHash(normalizedUrl, contentHash);
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
    
    // Track active crawls for concurrency control
    this.activeCrawls++;
    if (this.debug) {
      logger.log('DEBUG', `Crawling URL: ${url} (depth=${depth})`);
    }
    // Ensure URL is a string, not an object
    const urlString = typeof normalizedUrl === 'object' ? normalizedUrl.href : normalizedUrl;
    
    // Mark URL as visited
    this.visitedUrls.add(normalizedUrl);
    this.queuedUrls.delete(normalizedUrl); // Remove from queue if it was there
    this.foundUrls.push(normalizedUrl);
    logger.crawl(`Added URL to found list: ${normalizedUrl} (${this.foundUrls.length}/${this.maxPages})`);
    this.totalUrlsMapped++;
    if (this.totalUrlsMapped % 100 === 0) {
      logger.crawl(`Total URLs mapped so far: ${this.totalUrlsMapped}`);
    }
    
    // Get existing page data from database
    const pageData = this.crawlStateService.getPage(normalizedUrl);
    
    // Skip if we're beyond the max depth (but allow if maxDepth is -1, which means no limit)
    if (this.maxDepth >= 0 && depth > this.maxDepth) {
      logger.crawl(`Skipping URL due to depth: ${normalizedUrl} (depth=${depth}, maxDepth=${this.maxDepth})`);
      return;
    }
    
    // Check if we've reached the maximum number of pages
    if (this.foundUrls.length >= this.maxPages) {
      this.activeCrawls--;
      logger.crawl(`Reached max pages limit: ${this.foundUrls.length}/${this.maxPages}`, true);
      throw new CrawlLimitReached('Crawl limit reached');
    }
    
    try {
      // Prepare headers for conditional request
      const headers = { 'User-Agent': 'site2rag-crawler' };
      
      // Add conditional headers if we have page data
      if (pageData) {
        logger.cache(`Found previous data for ${urlString}`);
        
        // Add ETag for conditional request
        if (pageData.etag) {
          logger.cache(`Using ETag: ${pageData.etag}`);
          headers['If-None-Match'] = pageData.etag;
        }
        
        // Add Last-Modified for conditional request
        if (pageData.last_modified) {
          logger.cache(`Using Last-Modified: ${pageData.last_modified}`);
          headers['If-Modified-Since'] = pageData.last_modified;
        }
      } else {
        // Initialize page data if this is the first time crawling this URL
        this.crawlStateService.upsertPage(urlString, {
          etag: null,
          last_modified: null,
          content_hash: null,
          last_crawled: new Date().toISOString(),
          status: 0,
          title: null,
          file_path: null
        });
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
        return;
      }
      
      // Skip non-OK responses
      if (!response.ok) {
        logger.error(`Error fetching ${normalizedUrl}: ${response.status} ${response.statusText}`);
        // Update status in page data
        this.crawlStateService.upsertPage(urlString, {
          status: response.status,
          last_crawled: new Date().toISOString()
        });
        return;
      }
      
      // Get HTML content from response
      const html = await response.text();
      
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
          return;
        }
      }
      
      // Update in-memory cache with new hash
      this.contentHashes.set(normalizedUrl, contentHash);
      
      // Check if content has changed using ETag, Last-Modified, and content hash
      if (pageData) {
        let contentUnchanged = false;
        
        // Check ETag if available
        const etag = response.headers.get('etag');
        if (etag && pageData.etag && pageData.etag === etag) {
          if (this.debug) {
            logger.log('DEBUG', `ETag match for ${urlString}: ${etag}`);
          }
          contentUnchanged = true;
        }
        
        // Check Last-Modified if available
        const lastModified = response.headers.get('last-modified');
        if (!contentUnchanged && lastModified && pageData.last_modified && pageData.last_modified === lastModified) {
          if (this.debug) {
            logger.log('DEBUG', `Last-Modified match for ${urlString}: ${lastModified}`);
          }
          contentUnchanged = true;
        }
        
        // Check content hash as a fallback
        if (!contentUnchanged && contentHash && pageData.content_hash && pageData.content_hash === contentHash) {
          if (this.debug) {
            logger.log('DEBUG', `Content hash match for ${urlString}: ${contentHash}`);
          }
          contentUnchanged = true;
        }
        
        if (contentUnchanged) {
          logger.cache(`Content unchanged for ${normalizedUrl}, skipping processing`);
          // Update last_crawled timestamp but keep all other data the same
          this.crawlStateService.upsertPage(urlString, {
            last_crawled: new Date().toISOString(),
            content_hash: contentHash // Update the hash in case it wasn't stored before
          });
          return;
        } else {
          logger.cache(`Content changed for ${urlString}`);
        }
      }
      
      // Process HTML content
      const { $, main, links: allLinks, removedBlocks } = await this.contentService.processHtml(html, normalizedUrl);
      
      // Filter out external URLs early to avoid processing them later
      let links = allLinks;
      if (this.options && this.options.sameDomain === true && this.startUrl) {
        try {
          // Extract base domain from the starting URL
          const startUrlObj = new URL(this.startUrl);
          const baseDomain = startUrlObj.hostname;
          
          // Filter links to only include those from the same domain
          const internalLinks = allLinks.filter(link => {
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
            logger.log('DEBUG', `Filtered out ${allLinks.length - internalLinks.length} external URLs from ${normalizedUrl}`);
          }
          
          links = internalLinks;
        } catch (e) {
          logger.warn(`Error filtering external URLs: ${e.message}`);
          // Continue with all links if there was an error
        }
      }
      
      // Extract metadata from HTML
      const { title, meta } = this.contentService.extractMetadata($);
      
      // Convert to markdown and generate frontmatter
      // Pass the normalized URL as the base URL for link resolution
      const markdown = this.markdownService.toMarkdown(main, normalizedUrl);
      
      // Ensure meta is an object to prevent undefined errors
      const metaData = meta || {};
      
      // Prepare comprehensive frontmatter with all available metadata
      const frontmatterData = {
        title: title || '',
        url: normalizedUrl,
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
      const { hostname } = new URL(normalizedUrl);
      logger.crawl(`Saving markdown for ${normalizedUrl}`);
      logger.crawl(`- Hostname: ${hostname}`);
      logger.crawl(`- Filename: ${filename}.md`);
      
      let filePath = null;
      try {
        filePath = await this.fileService.saveMarkdown(
          hostname,
          filename + '.md', 
          markdownWithFrontmatter
        );
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
      // Use upsertPage instead of updateHeaders
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      
      this.crawlStateService.upsertPage(normalizedUrl, {
        etag: etag || null,
        last_modified: lastModified || null,
        content_hash: contentHash || null,
        status: response.status,
        last_crawled: new Date().toISOString()
      });
      
      // Update page data with title and file path
      this.crawlStateService.upsertPage(normalizedUrl, {
        title: title || '',
        file_path: filePath || null
      });
      
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
      } catch (err) {
        logger.error(`Error saving links: ${err.message}`);
        // Continue with empty links if there was an error
      }
      
      // Process links recursively
      for (const link of links_to_crawl) {
        // Skip if we've reached the page limit
        if (this.foundUrls.length >= this.maxPages) {
          logger.crawl(`Reached max pages limit during link processing: ${this.foundUrls.length}/${this.maxPages}`);
          throw new CrawlLimitReached('Crawl limit reached');
          logger.info(`[CRAWL] Reached max pages limit during link processing: ${this.foundUrls.length}/${this.maxPages}`);
          throw new CrawlLimitReached();
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
  calculateContentHash(content) {
    // Simple hash function for strings
    // This is a basic implementation - for production, consider using crypto.createHash
    let hash = 0;
    if (content.length === 0) return hash.toString(16);
    
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
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
      hash = ((hash << 5) - hash) + byte;
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
        const savedPath = await this.fileService.saveBinaryFile(
          buffer,
          `${hostname}/documents`,
          filename
        );
        logger.info(`[BINARY_TRACKING] Successfully saved binary file: ${savedPath}`);
        
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
            content_hash: binaryHash  // Store the binary hash
          });
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
    // This is a placeholder implementation
    // In a real implementation, this would fetch and parse sitemap.xml files
    // and add the URLs to the queue
    
    // For now, we'll just return an empty array
    return [];
  }
}
