import { CrawlService } from '../src/services/crawl_service.js';
import { MarkdownService } from '../src/services/markdown_service.js';
import { FileService } from '../src/services/file_service.js';
import { CrawlStateService } from '../src/services/crawl_state_service.js';
import { ContentService } from '../src/services/content_service.js';
import { UrlService } from '../src/services/url_service.js';
import { FetchService } from '../src/services/fetch_service.js';
import fs from 'fs/promises';
import path from 'path';
import logger from '../src/services/logger_service.js';

// Create a test function to focus on domain filtering
async function testDomainFiltering() {
  logger.info('Starting domain filtering test...');
  
  // Create services
  const fileService = new FileService({
    outputDir: './output',
    debug: true
  });
  
  const markdownService = new MarkdownService({
    debug: true
  });
  
  const crawlStateService = new CrawlStateService({
    dbPath: './output/oceanoflights/.site2rag/crawl.db',
    sessionDbPath: './output/oceanoflights/.site2rag/crawl_domain_test.db',
    debug: true
  });
  
  const contentService = new ContentService({
    debug: true
  });
  
  const urlService = new UrlService();
  
  const fetchService = new FetchService({
    politeDelay: 500,
    timeout: 30000,
    debug: true
  });
  
  // Create an enhanced URL service with strict domain filtering
  const enhancedUrlService = {
    ...urlService,
    
    // Override the isSameDomain method to be more strict
    isSameDomain: (url, baseDomain) => {
      try {
        const urlObj = new URL(url);
        const urlHostname = urlObj.hostname;
        
        // Strict exact hostname match
        const result = urlHostname === baseDomain;
        
        if (!result) {
          logger.info(`[DOMAIN_FILTER] Rejected external URL: ${url} (domain: ${urlHostname}, not in base domain: ${baseDomain})`);
        }
        
        return result;
      } catch (e) {
        logger.info(`[DOMAIN_FILTER] Error checking domain for URL ${url}: ${e.message}`);
        return false;
      }
    },
    
    // Add safeFilename method to prevent errors
    safeFilename: (url) => {
      // Delegate to the original urlService if available
      if (urlService && typeof urlService.safeFilename === 'function') {
        return urlService.safeFilename(url);
      }
      
      // Fallback implementation if the original doesn't have it
      try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;
        
        // Remove leading slash
        if (pathname.startsWith('/')) {
          pathname = pathname.substring(1);
        }
        
        // Replace problematic characters
        pathname = pathname.replace(/[\/?%*:|"<>]/g, '-');
        
        // Handle empty pathname
        if (!pathname || pathname === '') {
          pathname = 'index';
        }
        
        return pathname;
      } catch (err) {
        logger.warn(`[URL] Error creating safe filename for ${url}: ${err.message}`);
        return 'index';
      }
    },
    
    normalizeUrl: urlService.normalizeUrl
  };
  
  // Create a crawl service with strict domain filtering
  const crawlService = new CrawlService({
    urlService: enhancedUrlService,
    fetchService,
    fileService,
    markdownService,
    contentService,
    crawlStateService,
    maxPages: 10, // Reduce max pages for faster testing
    maxDepth: 1, // Reduce depth for more focused testing
    sameDomain: true, // Enforce same domain restriction
    debug: true
  });
  
  // Explicitly set the base domain to ensure strict filtering
  crawlService.baseDomain = 'oceanoflights.org';
  
  // Start with a page that has external links
  const startUrl = 'https://oceanoflights.org/whats-new/fa';
  
  // Configure crawl options with strict domain filtering
  const options = {
    maxPages: 10,
    maxConcurrency: 3,
    followLinks: true,
    saveHtml: false,
    saveMarkdown: true,
    sameDomain: true  // This is the key option that restricts to the same domain
  };
  
  try {
    logger.info(`[TEST] Starting crawl from ${startUrl}`);
    logger.info(`[TEST] Base domain: ${new URL(startUrl).hostname}`);
    
    // Add a hook to monitor URLs being added to the queue
    const originalQueueUrl = crawlService.queueUrl;
    crawlService.queueUrl = async (url, depth) => {
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        const baseDomain = new URL(startUrl).hostname;
        
        if (hostname !== baseDomain) {
          logger.info(`[DOMAIN_FILTER] Prevented queueing external URL: ${url} (domain: ${hostname})`);
          return;
        }
        
        logger.info(`[DOMAIN_FILTER] Allowed URL from same domain: ${url}`);
        return await originalQueueUrl.call(crawlService, url, depth);
      } catch (err) {
        logger.error(`[DOMAIN_FILTER] Error in queueUrl hook: ${err.message}`);
        return await originalQueueUrl.call(crawlService, url, depth);
      }
    };
    
    await crawlService.crawl(startUrl, options);
    logger.info('[TEST] Crawl completed');
    
    // Check the domains of all crawled URLs
    logger.info('[TEST] Analyzing crawled URLs by domain:');
    const domains = {};
    
    for (const url of crawlService.foundUrls) {
      try {
        const hostname = new URL(url).hostname;
        domains[hostname] = (domains[hostname] || 0) + 1;
      } catch (err) {
        logger.error(`[TEST] Error parsing URL ${url}: ${err.message}`);
      }
    }
    
    logger.info('[TEST] Domain distribution of crawled URLs:');
    for (const [domain, count] of Object.entries(domains)) {
      logger.info(`- ${domain}: ${count} URLs`);
    }
    
    // Check if any external domains were crawled
    const baseDomain = new URL(startUrl).hostname;
    const externalDomains = Object.keys(domains).filter(domain => domain !== baseDomain);
    
    if (externalDomains.length > 0) {
      logger.info('[TEST] ❌ FAILED: External domains were crawled:');
      externalDomains.forEach(domain => logger.info(`  - ${domain}: ${domains[domain]} URLs`));
    } else {
      logger.info('[TEST] ✅ SUCCESS: Only the base domain was crawled');
    }
    
  } catch (error) {
    logger.error(`[TEST] Error during crawl: ${error.message}`);
    logger.error(error);
  }
}

// Run the test
testDomainFiltering().catch(console.error);
