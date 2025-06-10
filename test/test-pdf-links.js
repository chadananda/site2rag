import { CrawlService } from '../src/services/crawl_service.js';
import { MarkdownService } from '../src/services/markdown_service.js';
import { FileService } from '../src/services/file_service.js';
import { CrawlStateService } from '../src/services/crawl_state_service.js';
import { ContentService } from '../src/services/content_service.js';
import { UrlService } from '../src/services/url_service.js';
import { FetchService } from '../src/services/fetch_service.js';
import logger from '../src/services/logger_service.js';

// Create a test function to focus on PDF links
async function testPdfLinks() {
  logger.info('Starting PDF links test...');
  
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
    sessionDbPath: './output/oceanoflights/.site2rag/crawl_pdf_test.db',
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
  
  // Create crawl service with all dependencies
  const crawlService = new CrawlService({
    fetchService,
    urlService,
    contentService,
    markdownService,
    fileService,
    crawlStateService,
    outputDir: './output/oceanoflights',
    debug: true
  });
  
  // Start with a page that has PDF links
  const startUrl = 'https://oceanoflights.org/whats-new/fa';
  
  // Configure crawl options
  const options = {
    maxPages: 20,
    maxConcurrency: 3,
    followLinks: true,
    saveHtml: false,
    saveMarkdown: true,
    sameDomain: true,  // This is the key option that restricts to the same domain
    allowedDomains: ['oceanoflights.org'],
    includeSubdomains: true
  };
  
  try {
    logger.info(`[TEST] Starting crawl from ${startUrl}`);
    await crawlService.crawl(startUrl, options);
    logger.info('[TEST] Crawl completed');
    
    // Check if any PDF files were downloaded
    logger.info('[TEST] Checking for downloaded PDF files...');
    
    // Use fs to list files instead of a non-existent method
    const fs = await import('fs/promises');
    const path = await import('path');
    
    try {
      const documentsDir = './output/oceanoflights/documents';
      
      // Check if directory exists first
      try {
        await fs.access(documentsDir);
      } catch (err) {
        logger.info(`[TEST] Documents directory does not exist: ${documentsDir}`);
        logger.info('[TEST] No PDF files were downloaded');
        return;
      }
      
      // List all files in the directory
      const files = await fs.readdir(documentsDir, { recursive: true });
      
      // Filter for PDF files
      const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
      
      logger.info(`[TEST] Found ${pdfFiles.length} PDF files`);
      
      if (pdfFiles.length > 0) {
        logger.info('[TEST] PDF files found:');
        pdfFiles.forEach(file => logger.info(`- ${path.join(documentsDir, file)}`));
      } else {
        logger.info('[TEST] No PDF files were downloaded');
      }
    } catch (error) {
      logger.error(`[TEST] Error checking for PDF files: ${error.message}`);
    }
    
  } catch (error) {
    logger.error(`[TEST] Error during crawl: ${error.message}`);
    logger.error(error);
  } finally {
    // Clean up
    if (crawlStateService && typeof crawlStateService.close === 'function') {
      await crawlStateService.close();
    }
  }
}

// Run the test
testPdfLinks().catch(console.error);
