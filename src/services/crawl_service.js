import path from 'path';
import fs from 'fs';
import { URL } from 'url';
import { CrawlLimitReached } from '../errors.js';

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
    this.domain = options.domain;
    this.startUrl = options.startUrl || this.domain;
    this.maxPages = options.maxPages || 100;
    this.maxDepth = options.maxDepth || 3;
    this.urlService = options.urlService;
    this.fetchService = options.fetchService;
    this.fileService = options.fileService;
    this.contentService = options.contentService;
    this.markdownService = options.markdownService;
    this.crawlStateService = options.crawlStateService;
    this.visited = new Set();
    this.found = [];
    this.linkMap = {};
    this.activeCrawls = 0;
    this.maxConcurrency = options.maxConcurrency || 5;
    this.debug = options.debug === true; // Ensure it's a boolean
    
    console.log(`[CRAWL] Debug mode is ${this.debug ? 'enabled' : 'disabled'}`);
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
        console.warn('Warning: No domain provided for CrawlService.initialize');
      }
    } catch (err) {
      hostname = this.domain?.split('/')?.pop() || 'unknown';
      console.warn(`Warning: '${this.domain}' is not a valid URL in CrawlService.initialize. Using '${hostname}' as hostname.`);
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
        console.warn(`Warning: Could not fetch robots.txt for '${this.domain}': ${err.message}`);
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
    console.log(`CrawlService.crawlSite: Starting crawl from ${url}`);
    console.log(`Max pages: ${this.maxPages}, Max depth: ${this.maxDepth}`);
    
    try {
      console.log('Initializing crawl...');
      await this.initialize();
      console.log('Starting recursive crawl...');
      await this.crawl(url, 0);
      console.log(`Crawl completed with ${this.found.length} URLs found`);
      return this.found;
    } catch (err) {
      if (err instanceof CrawlLimitReached) {
        console.log(`Crawl limit reached after ${this.found.length} URLs`);
        // This is an expected condition, not an error
        return this.found;
      }
      console.error('Error during crawl:', err);
      throw err;
    } finally {
      // Abort any pending requests
      this.fetchService.abortAll();
    }
  }

  /**
   * Crawls a URL and processes its content
   * @param {string} url - URL to crawl
   * @param {number} depth - Current crawl depth
   */
  async crawl(url, depth = 0) {
    // Normalize URL
    const normalizedUrl = this.urlService.normalizeUrl(url);
    
    // Skip if we've already visited this URL in the current session
    if (this.visited.has(normalizedUrl)) {
      console.log(`[CRAWL] Skipping already visited URL: ${normalizedUrl}`);
      return;
    }
    
    // Mark as visited in the current session to prevent duplicate processing
    this.visited.add(normalizedUrl);
    
    // Extract hostname from the URL for domain checking
    let urlObj;
    try {
      urlObj = new URL(normalizedUrl);
      
      // Skip URLs that are not from the same domain as the starting domain
      // Only apply this check to links beyond the start URL (depth > 0)
      if (depth > 0) {
        const urlHostname = urlObj.hostname;
        const domainObj = new URL(this.startUrl);
        const baseDomain = domainObj.hostname;
        
        if (!this.urlService.isSameDomain(normalizedUrl, baseDomain)) {
          console.log(`[CRAWL] Skipping external URL: ${normalizedUrl} (not in domain ${baseDomain})`);
          return;
        }
      }
    } catch (e) {
      console.error(`Error parsing URL ${normalizedUrl}: ${e.message}`);
      return;
    }
    
    // Get existing page data from database
    const pageData = this.crawlStateService.getPage(normalizedUrl);
    
    // Skip if we're beyond the max depth (but allow if maxDepth is -1, which means no limit)
    if (this.maxDepth >= 0 && depth > this.maxDepth) {
      console.log(`Skipping URL due to depth: ${normalizedUrl} (depth=${depth}, maxDepth=${this.maxDepth})`);
      return;
    }
    
    console.log(`Crawling URL: ${normalizedUrl} (depth=${depth})`);
    
    // Ensure URL is a string, not an object
    const urlString = typeof normalizedUrl === 'object' ? normalizedUrl.href : normalizedUrl;
    
    // Add URL to found list if not already there
    if (!this.found.includes(urlString)) {
      this.found.push(urlString);
      console.log(`[CRAWL] Added URL to found list: ${urlString} (${this.found.length}/${this.maxPages})`);
    }
    
    try {
      // Prepare headers for conditional request
      const headers = { 'User-Agent': 'site2rag-crawler' };
      
      // Add conditional headers if we have page data
      if (pageData) {
        console.log(`[CACHE] Found previous data for ${urlString}`);
        
        // Add ETag for conditional request
        if (pageData.etag) {
          console.log(`[CACHE] Using ETag: ${pageData.etag}`);
          headers['If-None-Match'] = pageData.etag;
        }
        
        // Add Last-Modified for conditional request
        if (pageData.last_modified) {
          console.log(`[CACHE] Using Last-Modified: ${pageData.last_modified}`);
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
      console.log(`FetchService.fetchUrl: Fetching ${normalizedUrl}`);
      console.log(`Fetch headers:`, headers);
      const response = await this.fetchService.fetchUrl(normalizedUrl, headers);
      
      // Handle 304 Not Modified
      if (response.status === 304) {
        console.log(`[CACHE] Not modified: ${normalizedUrl}`);
        // Update last_crawled timestamp but keep all other data the same
        this.crawlStateService.upsertPage(urlString, {
          last_crawled: new Date().toISOString()
        });
        return;
      }
      
      // Skip non-OK responses
      if (!response.ok) {
        console.error(`Error fetching ${normalizedUrl}: ${response.status} ${response.statusText}`);
        // Update status in page data
        this.crawlStateService.upsertPage(urlString, {
          status: response.status,
          last_crawled: new Date().toISOString()
        });
        return;
      }
      
      // Check content type to handle binary files (PDF, DOCX, etc.)
      const contentType = response.headers.get('content-type') || '';
      console.log(`Content-Type for ${normalizedUrl}: ${contentType}`);
      
      // Handle binary files (PDF, DOCX, etc.)
      if (this.isBinaryFile(contentType)) {
        await this.handleBinaryFile(normalizedUrl, response, contentType);
        return;
      }
      
      const html = await response.text();
      
      // Calculate content hash for change detection
      const contentHash = this.calculateContentHash(html);
      console.log(`[CACHE] Content hash for ${normalizedUrl}: ${contentHash}`);
      
      // Check if content has changed using ETag, Last-Modified, and content hash
      if (pageData) {
        let contentUnchanged = false;
        
        // Check ETag if available
        const etag = response.headers.get('etag');
        if (etag && pageData.etag && pageData.etag === etag) {
          console.log(`[CACHE] ETag match for ${urlString}: ${etag}`);
          contentUnchanged = true;
        }
        
        // Check Last-Modified if available
        const lastModified = response.headers.get('last-modified');
        if (!contentUnchanged && lastModified && pageData.last_modified && pageData.last_modified === lastModified) {
          console.log(`[CACHE] Last-Modified match for ${urlString}: ${lastModified}`);
          contentUnchanged = true;
        }
        
        // Check content hash as a fallback
        if (!contentUnchanged && contentHash && pageData.content_hash && pageData.content_hash === contentHash) {
          console.log(`[CACHE] Content hash match for ${urlString}: ${contentHash}`);
          contentUnchanged = true;
        }
        
        if (contentUnchanged) {
          console.log(`[CACHE] Content unchanged for ${normalizedUrl}, skipping processing`);
          // Update last_crawled timestamp but keep all other data the same
          this.crawlStateService.upsertPage(urlString, {
            last_crawled: new Date().toISOString(),
            content_hash: contentHash // Update the hash in case it wasn't stored before
          });
          return;
        } else {
          console.log(`[CACHE] Content changed for ${urlString}`);
        }
      }
      
      // Process HTML content
      const { $, main, links, removedBlocks } = await this.contentService.processHtml(html, normalizedUrl);
      
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
      console.log(`Saving markdown for ${normalizedUrl}`);
      console.log(`- Hostname: ${hostname}`);
      console.log(`- Filename: ${filename}.md`);
      
      let filePath = null;
      try {
        filePath = await this.fileService.saveMarkdown(
          hostname,
          filename + '.md', 
          markdownWithFrontmatter
        );
        console.log(`- Saved to: ${filePath}`);
        
        // Save debug markdown if debug mode is enabled and we have removedBlocks
        console.log(`[DEBUG FLAG] Debug mode is ${this.debug ? 'enabled' : 'disabled'}`);
        console.log(`[DEBUG FLAG] removedBlocks is ${removedBlocks ? 'available' : 'not available'}`);
        
        if (this.debug && removedBlocks) {
          try {
            // Generate debug markdown content using our enhanced method
            const debugMarkdown = this.contentService.generateDebugMarkdown($, main, removedBlocks, normalizedUrl);
            console.log(`[DEBUG FLAG] Generated debug markdown: ${debugMarkdown ? 'yes' : 'no'}`);
            
            if (debugMarkdown) {
              // Get the base output directory
              const outputBaseDir = this.fileService.outputDir;
              
              // Save debug markdown
              await this.contentService.saveDebugInfo(normalizedUrl, debugMarkdown, filename);
            }
          } catch (err) {
            console.error(`Error generating debug markdown for ${normalizedUrl}:`, err);
          }
        }
      } catch (err) {
        console.error(`Error saving markdown file: ${err.message}`);
        console.error(err.stack);
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
        
        // Only call saveLinks if it exists
        if (typeof this.crawlStateService.saveLinks === 'function') {
          this.crawlStateService.saveLinks(normalizedUrl, links);
        }
        
        links_to_crawl = links;
      } catch (err) {
        console.error(`Error saving links: ${err.message}`);
        // Continue with empty links if there was an error
      }
      
      // Check if we've reached the page limit before processing more links
      if (this.found.length >= this.maxPages) {
        console.log(`[CRAWL] Reached max pages limit: ${this.found.length}/${this.maxPages}`);
        throw new CrawlLimitReached();
      }
      
      // Process links recursively
      for (const link of links_to_crawl) {
        // Skip if we've reached the page limit
        if (this.found.length >= this.maxPages) {
          console.log(`[CRAWL] Reached max pages limit during link processing: ${this.found.length}/${this.maxPages}`);
          throw new CrawlLimitReached();
        }
        
        // Skip if we've already visited this URL
        if (this.visited.has(link)) {
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
      console.error(`Error crawling ${normalizedUrl}: ${err.message}`);
      console.error(err.stack);
    }
  }

  /**
   * Checks if a content type represents a binary file
   * @param {string} contentType - Content type to check
   * @returns {boolean} - Whether the content type represents a binary file
   * @private
   */
  isBinaryFile(contentType) {
    const binaryTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream',
      'image/',
      'audio/',
      'video/',
    ];
    
    return binaryTypes.some(type => contentType.includes(type));
  }

  /**
   * Calculates a hash of the content for change detection
   * @param {string} content - Content to hash
   * @returns {string} - Hash of the content
   * @private
   */
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
   * Handles a binary file
   * @param {string} url - URL
   * @param {Response} response - Fetch response
   * @param {string} contentType - Content type
   * @returns {Promise<void>}
   */
  async handleBinaryFile(url, response, contentType) {
    console.log(`Handling binary file: ${url} (${contentType})`);
    
    // TODO: Implement binary file handling
    // This could involve downloading the file to the assets directory
    // and creating a reference to it in the markdown
  }
  
  /**
   * Process sitemaps for a domain
   * @param {string} domain - Domain to process sitemaps for
   * @returns {Promise<string[]>} - Array of URLs found in sitemaps
   */
  async processSitemaps(domain) {
    console.log(`Processing sitemaps for ${domain}`);
    // This is a placeholder implementation
    // In a real implementation, this would fetch and parse sitemap.xml files
    // and add the URLs to the queue
    
    // For now, we'll just return an empty array
    return [];
  }
}
