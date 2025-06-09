import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import TurndownService from 'turndown';
vi.mock('node-fetch', () => ({
  default: async () => ({ ok: true, status: 200, text: async () => FAKE_HTML })
}));
import { ContentService } from '../../src/services/content_service.js';
import { MarkdownService } from '../../src/services/markdown_service.js';
import { FileService } from '../../src/services/file_service.js';
import { getDB } from '../../src/db.js';
// All DB access must use getDB() from src/db.js. Never instantiate CrawlDB directly.
// Use the shared getDB() utility to ensure DB is always initialized with correct schema.

const TEST_OUTPUT = path.resolve('./tests/tmp/md_unit');
const TEST_URL = 'https://example.com/test';
const FAKE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Test Title</title>
  <meta name="description" content="Test description here.">
  <meta name="keywords" content="foo, bar, baz">
  <meta property="og:title" content="OG Test Title">
  <meta property="og:description" content="OG Description">
  <meta property="twitter:title" content="Twitter Test Title">
  <link rel="canonical" href="https://example.com/canonical">
</head>
<body>
  <main>
    <h1>Hello World</h1>
    <p>This is a test.</p>
  </main>
</body>
</html>`;

function cleanup() {
  if (fs.existsSync(TEST_OUTPUT)) fs.rmSync(TEST_OUTPUT, { recursive: true, force: true });
}

describe('Markdown Output (Unit)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('converts HTML to Markdown and writes to correct file', async () => {
    // Test timeout increased for slow environments
    // Clean up all DB files before test to guarantee fresh schema
    const dbPath = path.join(TEST_OUTPUT, 'test.db');
    const dbNewPath = path.join(TEST_OUTPUT, 'test_new.db');
    const dbPrevPath = path.join(TEST_OUTPUT, 'test_prev.db');
    [dbPath, dbNewPath, dbPrevPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    if (!fs.existsSync(TEST_OUTPUT)) fs.mkdirSync(TEST_OUTPUT, { recursive: true });
    
    // Create services
    const fileService = new FileService({ outputDir: TEST_OUTPUT });
    const contentService = new ContentService({ aiConfig: { dbPath } });
    const markdownService = new MarkdownService();
    
    // Process HTML content
    const { html, metadata } = await contentService.processHtml(FAKE_HTML, TEST_URL);
    const markdown = markdownService.toMarkdown(html);
    const markdownWithFrontmatter = markdownService.addFrontmatter(markdown, metadata);
    
    // Save markdown to file - use 'example.com' as domain
    await fileService.saveMarkdown('example.com', '_test.md', markdownWithFrontmatter);
    // Debug: print files in output dir
    const files = fs.readdirSync(TEST_OUTPUT);
    console.log('Files in output dir:', files);
    // Check that .md file exists in domain subdirectory
    const expectedFile = path.join(TEST_OUTPUT, 'example.com', '_test.md');
    expect(fs.existsSync(expectedFile)).toBe(true);
    const md = fs.readFileSync(expectedFile, 'utf8');
    console.log('Actual markdown content:', md);
    expect(md).toMatch(/# Hello World/);
    expect(md).toMatch(/This is a test/);
    // Check YAML frontmatter for meta fields
    expect(md).toMatch(/title: Test Title/);
    expect(md).toMatch(/description: Test description here\./);
    expect(md).toMatch(/keywords: foo, bar, baz/);
    expect(md).toMatch(/og_title: OG Test Title/);
    expect(md).toMatch(/og_description: OG Description/);
    expect(md).toMatch(/twitter_title: Twitter Test Title/);
    expect(md).toMatch(/canonical: "https:\/\/example.com\/canonical"/);
  });
});
