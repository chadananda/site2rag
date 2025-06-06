import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import TurndownService from 'turndown';
vi.mock('node-fetch', () => ({
  default: async () => ({ ok: true, status: 200, text: async () => FAKE_HTML })
}));
import { SiteProcessor } from '../../src/site_processor.js';

const TEST_OUTPUT = path.resolve('./tests/tmp/md_unit');
const TEST_URL = 'https://example.com/test';
const FAKE_HTML = '<h1>Hello World</h1><p>This is a test.</p>';

function cleanup() {
  if (fs.existsSync(TEST_OUTPUT)) fs.rmSync(TEST_OUTPUT, { recursive: true, force: true });
}

describe('Markdown Output (Unit)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('converts HTML to Markdown and writes to correct file', async () => {
    // Minimal crawlState stub
    const crawlState = { getPage: () => null, upsertPage: () => {} };

    const processor = new SiteProcessor(TEST_URL, {
      crawlState,
      outputDir: TEST_OUTPUT,
      limit: 1,
      concurrency: 1
    });
    await processor.process();
    // Debug: print files in output dir
    const files = fs.readdirSync(TEST_OUTPUT);
    console.log('Files in output dir:', files);
    // Check that .md file exists
    const expectedFile = path.join(TEST_OUTPUT, '_test.md');
    expect(fs.existsSync(expectedFile)).toBe(true);
    const md = fs.readFileSync(expectedFile, 'utf8');
    expect(md).toMatch(/Hello World(\n=+|\n#|#\s*Hello World)/);
    expect(md).toMatch(/This is a test/);

  });
});
