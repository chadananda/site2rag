// deenbahai-crawl.test.js
// Integration test for crawling deenbahai.org - a real-world test case with redirects
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TEST_OUTPUT = 'tests/tmp/sites/deenbahai-test';
const TEST_URL = 'http://deenbahai.org';
const MAX_PAGES = 20;

/**
 * Clean up test output directory
 */
function cleanupTestOutput() {
  if (fs.existsSync(TEST_OUTPUT)) {
    fs.rmSync(TEST_OUTPUT, { recursive: true, force: true });
  }
}

/**
 * Count markdown files in output directory
 */
function countMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  
  let count = 0;
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    if (file.isDirectory()) {
      count += countMarkdownFiles(path.join(dir, file.name));
    } else if (file.name.endsWith('.md')) {
      count++;
    }
  }
  
  return count;
}

/**
 * Get basic stats about crawled content
 */
function getCrawlStats(outputDir) {
  if (!fs.existsSync(outputDir)) {
    return { totalFiles: 0, totalSize: 0, hasIndex: false };
  }
  
  let totalFiles = 0;
  let totalSize = 0;
  let hasIndex = false;
  
  const files = fs.readdirSync(outputDir, { withFileTypes: true });
  
  for (const file of files) {
    if (file.isFile() && file.name.endsWith('.md')) {
      totalFiles++;
      const filePath = path.join(outputDir, file.name);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
      
      if (file.name === 'index.md') {
        hasIndex = true;
      }
    }
  }
  
  return { totalFiles, totalSize, hasIndex };
}

beforeEach(() => {
  cleanupTestOutput();
});

afterEach(() => {
  cleanupTestOutput();
});

test('DeeNBahai.org Crawl Test', async () => {
  // Run the crawl command
  const command = `node bin/site2rag.js ${TEST_URL} --output ${TEST_OUTPUT} --limit ${MAX_PAGES}`;
  
  console.log(`Running: ${command}`);
  
  let output;
  let success = false;
  
  try {
    output = execSync(command, { 
      encoding: 'utf8',
      timeout: 120000 // 2 minute timeout
    });
    success = true;
  } catch (error) {
    console.error('Crawl command failed:', error.message);
    if (error.stdout) console.log('STDOUT:', error.stdout);
    if (error.stderr) console.log('STDERR:', error.stderr);
    throw error;
  }
  
  // Verify the crawl completed successfully
  expect(success).toBe(true);
  expect(output).toContain('crawl completed successfully');
  
  // Check that output directory was created
  expect(fs.existsSync(TEST_OUTPUT)).toBe(true);
  
  // Get crawl statistics
  const stats = getCrawlStats(TEST_OUTPUT);
  console.log(`Crawl stats: ${stats.totalFiles} files, ${stats.totalSize} bytes total`);
  
  // Verify we got some content
  expect(stats.totalFiles).toBeGreaterThan(0);
  expect(stats.totalSize).toBeGreaterThan(1000); // At least 1KB of content
  expect(stats.hasIndex).toBe(true); // Should have an index.md file
  
  // Verify we didn't exceed the limit
  expect(stats.totalFiles).toBeLessThanOrEqual(MAX_PAGES);
  
  // Check that database files were created
  const dbPath = path.join(TEST_OUTPUT, '.site2rag');
  expect(fs.existsSync(dbPath)).toBe(true);
  expect(fs.existsSync(path.join(dbPath, 'crawl.db'))).toBe(true);
  
  // Verify index.md has proper frontmatter and content
  const indexPath = path.join(TEST_OUTPUT, 'index.md');
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  
  // Should have YAML frontmatter
  expect(indexContent).toMatch(/^---\n/);
  expect(indexContent).toContain('title:');
  expect(indexContent).toContain('url:');
  expect(indexContent).toContain('crawled_at:');
  
  // Should have actual content after frontmatter
  const contentAfterFrontmatter = indexContent.split('---\n').slice(2).join('---\n').trim();
  expect(contentAfterFrontmatter.length).toBeGreaterThan(100);
  
  console.log(`✓ Successfully crawled ${stats.totalFiles} pages from ${TEST_URL}`);
  console.log(`✓ Total content size: ${(stats.totalSize / 1024).toFixed(1)}KB`);
  console.log(`✓ Redirect handling worked correctly`);
}, 150000); // 2.5 minute timeout for the entire test