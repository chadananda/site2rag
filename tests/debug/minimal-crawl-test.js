#!/usr/bin/env node

/**
 * Minimal test to debug the crawl issue
 */

import 'dotenv/config';
import {CrawlService} from '../../src/services/crawl_service.js';
import {FetchService} from '../../src/services/fetch_service.js';
import {UrlService} from '../../src/services/url_service.js';
import {FileService} from '../../src/services/file_service.js';
import {ContentService} from '../../src/services/content_service.js';
import {MarkdownService} from '../../src/services/markdown_service.js';
import {getDB} from '../../src/db.js';
import {DefaultCrawlState} from '../../src/core/crawl_state.js';
import logger from '../../src/services/logger_service.js';
import fs from 'fs';

// Enable debug logging
logger.configure({debug: true});

async function testMinimalCrawl() {
  const url = 'https://bahai-education.org';
  const outputDir = './tests/debug/minimal-crawl-output';
  
  console.log('=== Testing minimal crawl ===');
  
  // Clean output directory
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }
  
  // Create services
  const fileService = new FileService({outputDir, flat: false});
  const urlService = new UrlService();
  const fetchService = new FetchService({politeDelay: 100});
  const db = getDB(`${outputDir}/.site2rag/crawl.db`);
  const crawlStateService = new DefaultCrawlState(db);
  const contentService = new ContentService({debug: true, outputDir, db});
  const markdownService = new MarkdownService();
  
  const crawlService = new CrawlService({
    domain: url,
    startUrl: url,
    maxPages: 3,
    maxDepth: 1,
    outputDir,
    urlService,
    fetchService,
    fileService,
    contentService,
    markdownService,
    crawlStateService,
    debug: true,
    test: true,
    sameDomain: true
  });
  
  try {
    console.log('\n=== Starting minimal crawl ===');
    const results = await crawlService.crawlSite(url);
    
    console.log('\n=== Results ===');
    console.log(`Found URLs: ${results.length}`);
    console.log('URLs:', results);
    
    // Check what the crawl service found
    console.log('\n=== Internal State ===');
    console.log(`Visited URLs: ${crawlService.visitedUrls.size}`);
    console.log(`Queued URLs: ${crawlService.queuedUrls.size}`);
    console.log(`Found URLs: ${crawlService.foundUrls.length}`);
    
    // Check files
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir, { recursive: true });
      console.log('\n=== Files Created ===');
      files.forEach(file => console.log(`- ${file}`));
    }
    
  } catch (error) {
    console.error('\n=== Error ===');
    console.error(error);
  } finally {
    db.finalizeSession();
  }
}

testMinimalCrawl().catch(console.error);