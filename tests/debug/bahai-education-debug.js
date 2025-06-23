#!/usr/bin/env node

/**
 * Debug script for bahai-education.org crawling issues
 */

import 'dotenv/config';
import {SiteProcessor} from '../../src/site_processor.js';
import logger from '../../src/services/logger_service.js';
import fs from 'fs';
import path from 'path';

// Enable debug logging
logger.configure({debug: true});

async function debugBahaiEducation() {
  const url = 'https://bahai-education.org';
  const outputDir = './tests/debug/bahai-education-output';
  
  console.log('=== Debugging bahai-education.org crawl ===');
  console.log(`URL: ${url}`);
  console.log(`Output: ${outputDir}`);
  
  // Clean output directory
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }
  
  try {
    const processor = new SiteProcessor(url, {
      outputDir,
      limit: 5, // Small limit for debugging
      debug: true,
      test: true, // Enable test mode for detailed logging
      enhancement: false, // Disable AI for debugging
      politeDelay: 100 // Faster for debugging
    });
    
    console.log('\n=== Starting crawl ===');
    const results = await processor.process();
    
    console.log('\n=== Crawl Results ===');
    console.log(`Total URLs found: ${results.length}`);
    console.log('URLs:', results);
    
    // Check what files were created
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir, { recursive: true });
      console.log('\n=== Files Created ===');
      files.forEach(file => console.log(`- ${file}`));
    } else {
      console.log('\n=== No output directory created ===');
    }
    
  } catch (error) {
    console.error('\n=== Error ===');
    console.error(error);
  }
}

debugBahaiEducation().catch(console.error);