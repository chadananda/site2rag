import { URL } from 'url';
import { CrawlLimitReached } from '../errors.js';
import { UrlService } from './url_service.js';
import { FetchService } from './fetch_service.js';
import { ContentService } from './content_service.js';
import { MarkdownService } from './markdown_service.js';
import { FileService } from './file_service.js';
import { CrawlStateService } from './crawl_state_service.js';
import * as cheerio from 'cheerio';

/**
 * Service for crawling websites and extracting content
 */
export class CrawlService {
  /**
   * Creates a new CrawlService instance
   * @param {Object} options - Configuration options
   * @param {string} options.domain - Base domain to crawl
   * @param {string} options.startUrl - URL to start crawling from
   * @param {number} options.maxDepth - Maximum crawl depth (default: 3)
   * @param {number} options.maxPages - Maximum pages to crawl (default: 100)
   * @param {number} options.politeWaitMs - Time to wait between requests in ms (default: 1000)
   * @param {Object} options.aiConfig - AI service configuration
   * @param {UrlService} options.urlService - UrlService instance
   * @param {FetchService} options.fetchService - FetchService instance
   * @param {ContentService} options.contentService - ContentService instance
   * @param {MarkdownService} options.markdownService - MarkdownService instance
   * @param {FileService} options.fileService - FileService instance
   * @param {CrawlStateService} options.crawlStateService - CrawlStateService instance
   */
  constructor(options = {}) {
    // Core configuration
    this.domain = options.domain;
    this.startUrl = options.startUrl || this.domain;
    this.maxDepth = options.maxDepth !== undefined ? options.maxDepth : 3;
    this.maxPages = options.maxPages !== undefined ? options.maxPages : 100;
    this.politeWaitMs = options.politeWaitMs || 1000;
    this.aiConfig = options.aiConfig || {};
    
    // Services
    this.urlService = options.urlService || new UrlService();
    this.fetchService = options.fetchService || new FetchService({
      politeWaitMs: this.politeWaitMs
    });
    this.contentService = options.contentService || new ContentService({
      aiConfig: this.aiConfig
    });
    this.markdownService = options.markdownService || new MarkdownService();
    this.fileService = options.fileService || new FileService();
    this.crawlStateService = options.crawlStateService || new CrawlStateService({
      fileService: this.fileService
    });
    
    // State tracking
    this.visited = new Set();
    this.found = [];
    this.linkMap = {};
    
    // Concurrency control
    this.activeCrawls = 0;
    this.maxConcurrency = options.maxConcurrency || 5;
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
    
    // Skip if we should skip this URL
    if (this.urlService.shouldSkip(normalizedUrl, depth, this.maxDepth, this.visited)) {
      console.log(`Skipping URL: ${normalizedUrl} (depth=${depth})`);
      return;
    }
    
    console.log(`Crawling URL: ${normalizedUrl} (depth=${depth})`);
    
    // Mark as visited to prevent duplicate processing
    this.visited.add(normalizedUrl);
    
    // Add to found list
    if (!this.found.includes(normalizedUrl)) {
      this.found.push(normalizedUrl);
      console.log(`[CRAWL] Added URL to found list: ${normalizedUrl} (${this.found.length}/${this.maxPages})`);
    }
    
    try {
      // Initialize page data
      this.crawlStateService.upsertPage(normalizedUrl, {
        etag: null,
        last_modified: null,
        content_hash: null,
        last_crawled: new Date().toISOString(),
        status: 0,
        title: null,
        file_path: null
      });
      
      // Fetch the URL
      const headers = {};
      
      // Add conditional headers if we have them
      const pageData = this.crawlStateService.getPage(normalizedUrl);
      if (pageData) {
        if (pageData.etag) {
          headers['If-None-Match'] = pageData.etag;
        }
        if (pageData.last_modified) {
          headers['If-Modified-Since'] = pageData.last_modified;
        }
      }
      
      // Fetch the URL
      const response = await this.fetchService.fetchUrl(normalizedUrl, headers);
      
      // Handle 304 Not Modified
      if (response.status === 304) {
        console.log(`Not modified: ${normalizedUrl}`);
        return;
      }
      
      // Skip non-OK responses
      if (!response.ok) {
        console.error(`Error fetching ${normalizedUrl}: ${response.status} ${response.statusText}`);
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
      
      // Process HTML content
      const { $, main, links } = await this.contentService.processHtml(html, normalizedUrl);
      
      // Extract metadata from HTML
      const { title, meta } = this.contentService.extractMetadata($);
      
      // Convert to markdown and generate frontmatter
      const markdown = this.markdownService.toMarkdown(main);
      const markdownWithFrontmatter = this.markdownService.addFrontmatter(markdown, {
        title,
        url: normalizedUrl,
        crawled_at: new Date().toISOString(),
        ...meta
      });
      
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
      } catch (err) {
        console.error(`Error saving markdown file: ${err.message}`);
        console.error(err.stack);
      }
      
      // Update crawl state with new information
      try {
        // Make sure we have all required fields to avoid "Missing named parameter" errors
        const pageData = {
          title,
          file_path: filePath,
          last_crawled: new Date().toISOString(),
          status: 1, // Mark as successfully crawled
          etag: response.headers.get('etag') || null,
          last_modified: response.headers.get('last-modified') || null,
          content_hash: null
        };
        
        this.crawlStateService.upsertPage(normalizedUrl, pageData);
        
        // No need to call updateHeaders separately as we've included the headers in the upsert
      } catch (err) {
        console.error(`Error updating crawl state: ${err.message}`);
        // Continue despite errors in database operations
      }
      
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
      
      // Schedule links for crawling if not at max depth and we haven't reached the page limit
      if ((this.maxDepth < 0 || depth < this.maxDepth) && this.found.length < this.maxPages) {
        // Don't process links from sitemap files
        if (!normalizedUrl.endsWith('/sitemap.xml') && !normalizedUrl.endsWith('/sitemap_index.xml')) {
          const nextDepth = depth + 1;
          const batchSize = 3; // Process 3 links at a time
          console.log(`[CRAWL] Processing ${links_to_crawl.length} links in batches of ${batchSize}`);
          
          for (let i = 0; i < links_to_crawl.length; i += batchSize) {
            const batch = links_to_crawl.slice(i, i + batchSize);
            console.log(`[CRAWL] Processing batch ${Math.floor(i/batchSize) + 1}: ${batch.join(', ')}`);
            
            try {
              // Only crawl new links if we haven't reached the limit
              if (this.found.length < this.maxPages) {
                await Promise.all(batch.map(link => this.crawl(link, nextDepth)));
              } else {
                console.log(`[CRAWL] Skipping batch processing, reached max pages limit: ${this.found.length}/${this.maxPages}`);
                break;
              }
            } catch (err) {
              console.error(`Error crawling batch: ${err.message}`);
              // Continue with next batch despite errors
            }
          }
        }
      } else if (this.found.length >= this.maxPages) {
        console.log(`[CRAWL] Not scheduling more links, reached max pages limit: ${this.found.length}/${this.maxPages}`);
      }
    } catch (e) {
      console.error(`Error processing ${normalizedUrl}:`, e.message);
      // Don't rethrow CrawlLimitReached, just log it and continue
      // This allows all found pages to be processed
    }
  }

  /**
   * Processes sitemaps to extract URLs
   * @param {string} domain - Domain to crawl
   * @returns {Promise<string[]>} - Array of URLs found in sitemaps
   */
  async processSitemaps(domain) {
    const urls = [];
    
    try {
      // Try to fetch the sitemap.xml
      const sitemapUrl = new URL('/sitemap.xml', domain).toString();
      console.log(`FetchService.fetchUrl: Fetching ${sitemapUrl}`);
      const response = await this.fetchService.fetchUrl(sitemapUrl);
      
      if (response.ok) {
        const sitemapXml = await response.text();
        const $ = cheerio.load(sitemapXml, { xmlMode: true });
        
        // Extract URLs from sitemap
        $('url > loc').each((_, el) => {
          const url = $(el).text().trim();
          if (url && !urls.includes(url)) {
            urls.push(url);
          }
        });
        
        // Check for sitemap index
        $('sitemap > loc').each((_, el) => {
          const url = $(el).text().trim();
          if (url && !urls.includes(url)) {
            urls.push(url);
          }
        });
      }
      
      // Also try sitemap_index.xml
      const sitemapIndexUrl = new URL('/sitemap_index.xml', domain).toString();
      console.log(`FetchService.fetchUrl: Fetching ${sitemapIndexUrl}`);
      const indexResponse = await this.fetchService.fetchUrl(sitemapIndexUrl);
      
      if (indexResponse.ok) {
        const indexXml = await indexResponse.text();
        const $ = cheerio.load(indexXml, { xmlMode: true });
        
        // Extract URLs from sitemap index
        $('sitemap > loc').each((_, el) => {
          const url = $(el).text().trim();
          if (url && !urls.includes(url)) {
            urls.push(url);
          }
        });
      }
    } catch (err) {
      console.warn(`Error processing sitemaps: ${err.message}`);
    }
    
    return urls;
  }
  
  /**
   * Checks if a content type is a binary file (PDF, DOCX, etc.)
   * @param {string} contentType - Content-Type header value
   * @returns {boolean} - Whether the content is a binary file
   */
  isBinaryFile(contentType) {
    const binaryTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
      'application/msword', // DOC
      'application/vnd.ms-excel', // XLS
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // XLSX
      'application/vnd.ms-powerpoint', // PPT
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', // PPTX
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ];
    
    return binaryTypes.some(type => contentType.toLowerCase().includes(type));
  }
  
  /**
   * Handles binary files like PDFs and DOCXs
   * @param {string} url - URL of the binary file
   * @param {Response} response - Fetch response
   * @param {string} contentType - Content-Type header value
   * @returns {Promise<void>}
   */
  async handleBinaryFile(url, response, contentType) {
    try {
      console.log(`[CRAWL] Handling binary file: ${url} (${contentType})`);
      
      // Get file extension from content type
      const extension = this.getFileExtension(contentType, url);
      
      // Get binary data
      const buffer = await response.arrayBuffer();
      
      // Generate safe filename with proper extension
      const filename = this.urlService.safeFilename(url);
      const filenameWithExt = `${filename}.${extension}`;
      
      // Get hostname for output directory
      const { hostname } = new URL(url);
      console.log(`Saving binary file for ${url}`);
      console.log(`- Hostname: ${hostname}`);
      console.log(`- Filename: ${filenameWithExt}`);
      
      // Save binary file
      let filePath = null;
      try {
        filePath = await this.fileService.saveBinaryFile(
          hostname,
          filenameWithExt,
          Buffer.from(buffer)
        );
        console.log(`- Saved to: ${filePath}`);
      } catch (err) {
        console.error(`Error saving binary file: ${err.message}`);
        console.error(err.stack);
      }
      
      // Update crawl state with file information
      try {
        const pageData = {
          title: filenameWithExt,
          file_path: filePath,
          last_crawled: new Date().toISOString(),
          status: 1, // Mark as successfully crawled
          etag: response.headers.get('etag') || null,
          last_modified: response.headers.get('last-modified') || null,
          content_hash: null,
          is_binary: 1,
          content_type: contentType
        };
        
        this.crawlStateService.upsertPage(url, pageData);
      } catch (err) {
        console.error(`Error updating crawl state for binary file: ${err.message}`);
      }
    } catch (e) {
      console.error(`Error handling binary file ${url}: ${e.message}`);
    }
  }
  
  /**
   * Gets file extension from content type or URL
   * @param {string} contentType - Content-Type header value
   * @param {string} url - URL of the file
   * @returns {string} - File extension
   */
  getFileExtension(contentType, url) {
    // Map content types to file extensions
    const contentTypeMap = {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/zip': 'zip',
      'application/x-zip-compressed': 'zip',
      'application/octet-stream': 'bin'
    };
    
    // Try to get extension from content type
    for (const [type, ext] of Object.entries(contentTypeMap)) {
      if (contentType.toLowerCase().includes(type)) {
        return ext;
      }
    }
    
    // Fallback: try to extract extension from URL
    try {
      const { pathname } = new URL(url);
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/); // Match file extension
      if (match && match[1]) {
        return match[1].toLowerCase();
      }
    } catch (e) {}
    
    // Default fallback
    return 'bin';
  }
}
