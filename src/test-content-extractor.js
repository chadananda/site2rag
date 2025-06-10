/**
 * Test script for the framework-agnostic content extractor
 */

import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import { 
  extractMainContent,
  scoreContentElement,
  isLikelyNavigationOrBoilerplate,
  cleanupContent,
  generateConsistentSelector
} from './services/content_extractor.js';

// Sample HTML files to test
const testFiles = [
  // Add your test HTML files here
  // For example: path.join(process.cwd(), 'test-data', 'sample1.html')
];

// If no test files specified, use a sample HTML string
const sampleHTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
</head>
<body>
  <header>
    <nav>
      <ul>
        <li><a href="#">Home</a></li>
        <li><a href="#">About</a></li>
        <li><a href="#">Contact</a></li>
      </ul>
    </nav>
  </header>
  
  <div class="container">
    <aside class="sidebar">
      <div class="widget">
        <h3>Categories</h3>
        <ul>
          <li><a href="#">Category 1</a></li>
          <li><a href="#">Category 2</a></li>
          <li><a href="#">Category 3</a></li>
        </ul>
      </div>
    </aside>
    
    <main class="content">
      <article>
        <h1>Main Article Title</h1>
        <p>This is the first paragraph of the main content. It contains some text that should be considered as the main content of the page.</p>
        <p>This is another paragraph with more content. The content extractor should identify this area as the main content.</p>
        
        <h2>Section Title</h2>
        <p>This is a section of the article with more detailed information.</p>
        <ul>
          <li>List item 1</li>
          <li>List item 2</li>
          <li>List item 3</li>
        </ul>
        
        <figure>
          <img src="example.jpg" alt="Example image with descriptive alt text">
          <figcaption>This is a figure caption for the image</figcaption>
        </figure>
      </article>
    </main>
    
    <div class="related-posts">
      <h3>Related Posts</h3>
      <ul>
        <li><a href="#">Related Post 1</a></li>
        <li><a href="#">Related Post 2</a></li>
        <li><a href="#">Related Post 3</a></li>
      </ul>
    </div>
  </div>
  
  <footer>
    <div class="footer-links">
      <ul>
        <li><a href="#">Privacy Policy</a></li>
        <li><a href="#">Terms of Service</a></li>
        <li><a href="#">Contact</a></li>
      </ul>
    </div>
    <p>&copy; 2025 Test Site</p>
  </footer>
</body>
</html>
`;

/**
 * Test the content extractor on a given HTML string
 * @param {String} html - HTML string to test
 * @param {String} source - Source identifier for logging
 */
function testContentExtractor(html, source) {
  console.log(`\n=== Testing content extractor on ${source} ===\n`);
  
  // Load HTML with cheerio
  const $ = load(html);
  
  // Track removed blocks and selector decisions for debugging
  const removedBlocks = [];
  const selectorDecisions = {};
  
  // Setup options
  const options = {
    debug: true,
    removedBlocks,
    trackSelectorDecision: (selector, decision, blocks, reason) => {
      if (!selectorDecisions[selector]) {
        selectorDecisions[selector] = { decision, reason };
      }
      console.log(`[DECISION] ${selector}: ${decision} (${reason})`);
    }
  };
  
  // Extract main content
  console.log('Extracting main content...');
  const mainContent = extractMainContent($, $('body'), options);
  
  // Log results
  console.log('\n--- Results ---\n');
  console.log('Main content found:', mainContent.length > 0);
  
  if (mainContent.length > 0) {
    const contentSelector = generateConsistentSelector($, mainContent);
    console.log('Content selector:', contentSelector);
    
    // Get text length before and after extraction to calculate reduction percentage
    const originalTextLength = $('body').text().trim().length;
    const extractedTextLength = mainContent.text().trim().length;
    const reductionPercent = ((originalTextLength - extractedTextLength) / originalTextLength * 100).toFixed(1);
    
    console.log('Original DOM text length:', originalTextLength);
    console.log('Extracted content text length:', extractedTextLength);
    console.log('Content reduction:', reductionPercent + '%');
    
    // Log content preview
    const contentPreview = mainContent.text().trim().substring(0, 150) + '...';
    console.log('\nContent preview:', contentPreview);
    
    // Log HTML structure
    console.log('\nExtracted HTML structure:');
    console.log(mainContent.html().substring(0, 500) + (mainContent.html().length > 500 ? '...' : ''));
  }
  
  // Log selector decisions summary
  console.log('\n--- Selector Decisions ---\n');
  Object.entries(selectorDecisions).forEach(([selector, { decision, reason }]) => {
    console.log(`${selector}: ${decision} (${reason})`);
  });
}

// Main test function
async function runTests() {
  console.log('=== Content Extractor Test ===\n');
  
  // Test with sample HTML
  testContentExtractor(sampleHTML, 'sample HTML');
  
  // Test with files if provided
  for (const file of testFiles) {
    try {
      const html = fs.readFileSync(file, 'utf-8');
      testContentExtractor(html, path.basename(file));
    } catch (error) {
      console.error(`Error testing file ${file}:`, error);
    }
  }
}

// Run the tests
runTests().catch(console.error);
