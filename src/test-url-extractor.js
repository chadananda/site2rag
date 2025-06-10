/**
 * Test script for the framework-agnostic content extractor on a real URL
 */

import { load } from 'cheerio';
import { ContentService } from './services/content_service.js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create output directory if it doesn't exist
const outputDir = path.join(__dirname, '..', 'test-output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Fetch HTML content from a URL
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} - HTML content
 */
async function fetchHtml(url) {
  try {
    console.log(`Fetching URL: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    
    const html = await response.text();
    return html;
  } catch (error) {
    console.error('Error fetching URL:', error);
    throw error;
  }
}

/**
 * Save extracted content to file
 * @param {string} content - Content to save
 * @param {string} filename - Output filename
 */
function saveToFile(content, filename) {
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, content);
  console.log(`Output saved to: ${filePath}`);
}

/**
 * Test content extraction on a URL
 * @param {string} url - URL to test
 */
async function testUrlExtraction(url) {
  try {
    console.log(`\n=== Testing content extraction on ${url} ===\n`);
    
    // Fetch HTML content
    const html = await fetchHtml(url);
    
    // Create content service with debug enabled
    const contentService = new ContentService({ debug: true });
    
    // Process HTML content
    console.log('Processing HTML content...');
    const { $, main, removedBlocks } = await contentService.processHtml(html, url);
    
    // Check if content was extracted
    if (!main || main.length === 0) {
      console.error('No content extracted!');
      return;
    }
    
    // Get text length before and after extraction to calculate reduction percentage
    const originalTextLength = $('body').text().trim().length;
    const extractedTextLength = main.text().trim().length;
    const reductionPercent = ((originalTextLength - extractedTextLength) / originalTextLength * 100).toFixed(1);
    
    console.log('\n--- Results ---\n');
    console.log('Original DOM text length:', originalTextLength);
    console.log('Extracted content text length:', extractedTextLength);
    console.log('Content reduction:', reductionPercent + '%');
    
    // Generate output files
    const urlObj = new URL(url);
    const baseFilename = urlObj.hostname.replace(/\./g, '_');
    
    // Save extracted HTML
    saveToFile($.html(main), `${baseFilename}_extracted.html`);
    
    // Save original HTML for comparison
    saveToFile(html, `${baseFilename}_original.html`);
    
    // Generate a simple markdown version of the content
    const markdown = `---
title: "${$('title').text().trim()}"
url: "${url}"
extracted_at: "${new Date().toISOString()}"
---

${main.text().trim().split('\\n').filter(line => line.trim()).join('\\n\\n')}
`;
    
    saveToFile(markdown, `${baseFilename}.md`);
    
    // Generate debug report with selector decisions
    if (removedBlocks && removedBlocks.selectorDecisions) {
      let debugReport = `# Content Extraction Debug Report\n\n`;
      debugReport += `URL: ${url}\n`;
      debugReport += `Extraction Time: ${new Date().toISOString()}\n\n`;
      
      debugReport += `## Selector Decisions\n\n`;
      debugReport += `| Selector | Decision | Reason |\n`;
      debugReport += `|----------|----------|--------|\n`;
      
      removedBlocks.selectorDecisions.forEach((value, key) => {
        debugReport += `| \`${key}\` | ${value.decision} | ${value.reason} |\n`;
      });
      
      saveToFile(debugReport, `${baseFilename}_debug.md`);
    }
    
    console.log('\nExtraction test completed successfully!');
  } catch (error) {
    console.error('Error testing URL extraction:', error);
  }
}

// Main function
async function main() {
  // Get URL from command line arguments
  const url = process.argv[2];
  
  if (!url) {
    console.error('Please provide a URL to test');
    console.error('Usage: node test-url-extractor.js <url>');
    process.exit(1);
  }
  
  await testUrlExtraction(url);
}

// Run the main function
main().catch(console.error);
