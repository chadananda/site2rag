import { CrawlService } from '../src/services/crawl_service.js';
import { FileService } from '../src/services/file_service.js';
import { UrlService } from '../src/services/url_service.js';
import { FetchService } from '../src/services/fetch_service.js';
import { ContentService } from '../src/services/content_service.js';
import { MarkdownService } from '../src/services/markdown_service.js';
import { CrawlStateService } from '../src/services/crawl_state_service.js';
import fs from 'fs';
import path from 'path';
import http from 'http';
import logger from '../src/services/logger_service.js';

// Clean output directory
const outputDir = './output/binary-test';
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
fs.mkdirSync(outputDir, { recursive: true });

// Create a simple HTTP server to serve test files
const server = http.createServer((req, res) => {
  logger.info(`Request received: ${req.url}`);
  
  if (req.url === '/test.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream('./test/pdf/test.pdf').pipe(res);
  } 
  else if (req.url === '/documents/report.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream('./test/pdf/test.pdf').pipe(res);
  }
  else if (req.url === '/files/document.docx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    fs.createReadStream('./test/pdf/test.pdf').pipe(res); // Using PDF file as mock DOCX
  }
  else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

// Start the server
const PORT = 3456;
server.listen(PORT, async () => {
  logger.info(`Test server running on http://localhost:${PORT}`);
  
  try {
    // Initialize services
    const fileService = new FileService({ outputDir });
    const urlService = new UrlService();
    const fetchService = new FetchService();
    const contentService = new ContentService();
    const markdownService = new MarkdownService();
    const crawlStateService = new CrawlStateService({ fileService });
    
    // Create crawl service
    const crawlService = new CrawlService({
      domain: `http://localhost:${PORT}`,
      maxPages: 10,
      fileService,
      urlService,
      fetchService,
      contentService,
      markdownService,
      crawlStateService
    });
    
    // Initialize crawl service
    await crawlService.initialize();
    
    logger.info('\n--- Testing PDF file download ---');
    // Test PDF file
    await crawlService.crawl(`http://localhost:${PORT}/test.pdf`);
    
    logger.info('\n--- Testing PDF file in nested directory ---');
    // Test PDF file in nested directory
    await crawlService.crawl(`http://localhost:${PORT}/documents/report.pdf`);
    
    logger.info('\n--- Testing DOCX file in nested directory ---');
    // Test DOCX file in nested directory
    await crawlService.crawl(`http://localhost:${PORT}/files/document.docx`);
    
    logger.info('\n--- Test completed ---');
    
    // Check if files were saved correctly
    logger.info('\nChecking saved files:');
    const checkFile = (filePath) => {
      const exists = fs.existsSync(filePath);
      logger.info(`${filePath}: ${exists ? 'EXISTS' : 'MISSING'}`);
      return exists;
    };
    
    const rootPdfPath = path.join(outputDir, 'localhost_3456', 'test.pdf');
    const nestedPdfPath = path.join(outputDir, 'localhost_3456', 'documents', 'report.pdf');
    const nestedDocxPath = path.join(outputDir, 'localhost_3456', 'files', 'document.docx');
    
    const allFilesExist = 
      checkFile(rootPdfPath) && 
      checkFile(nestedPdfPath) && 
      checkFile(nestedDocxPath);
      
    logger.info(`\nTest result: ${allFilesExist ? 'SUCCESS' : 'FAILURE'}`);
  } catch (error) {
    logger.error('Test failed with error:', error);
  } finally {
    // Close the server
    server.close(() => {
      logger.info('Test server closed');
      process.exit(0);
    });
  }
});
