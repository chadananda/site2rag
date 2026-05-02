// Sitemap stage BDD tests. Uses vi.mock to stub undici fetch — no real HTTP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-sitemap-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

// Mock undici fetch before importing sitemap.js
vi.mock('undici', () => ({
  fetch: vi.fn()
}));

import { fetch } from 'undici';
import { openDb } from '../src/db.js';
import { runSitemap } from '../src/sitemap.js';

const DOMAIN = 'sitemap.example.com';
const SITE_URL = `https://${DOMAIN}`;

const mockFetch = (responses) => {
  fetch.mockImplementation(async (url) => {
    const entry = responses[url] ?? responses['*'];
    if (!entry) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => entry };
  });
};

const robotsTxt = (sitemapUrl) => `User-agent: *\nDisallow: /private/\nSitemap: ${sitemapUrl}`;

const sitemapXml = (urls) => `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(({ url, lastmod }) => `  <url><loc>${url}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;

const sitemapIndex = (sitemaps) => `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.map(url => `  <sitemap><loc>${url}</loc></sitemap>`).join('\n')}
</sitemapindex>`;

describe('runSitemap', () => {
  let db;

  beforeEach(() => {
    db = openDb(DOMAIN);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('discovers URLs from sitemap.xml via robots.txt', async () => {
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([
        { url: `${SITE_URL}/page1`, lastmod: '2024-01-01' },
        { url: `${SITE_URL}/page2`, lastmod: '2024-01-02' },
      ]),
      '*': ''
    });

    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN });
    expect(result.added).toContain(`${SITE_URL}/page1`);
    expect(result.added).toContain(`${SITE_URL}/page2`);
    expect(result.total).toBe(2);
    expect(result.cached).toBe(false);
  });

  it('detects changed URLs by lastmod diff', async () => {
    // First run: insert pages at lastmod 2024-01-01
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([{ url: `${SITE_URL}/page`, lastmod: '2024-01-01' }]),
      '*': ''
    });
    await runSitemap(db, { url: SITE_URL, domain: DOMAIN });

    // Second run: force re-diff by clearing cached timestamp
    db.prepare("DELETE FROM site_meta WHERE key='last_sitemap_diff_at'").run();

    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([{ url: `${SITE_URL}/page`, lastmod: '2024-02-01' }]),
      '*': ''
    });

    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN });
    expect(result.changed).toContain(`${SITE_URL}/page`);
    expect(result.added).toHaveLength(0);
  });

  it('marks removed URLs when absent from new sitemap', async () => {
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([
        { url: `${SITE_URL}/page1` },
        { url: `${SITE_URL}/page2` },
      ]),
      '*': ''
    });
    await runSitemap(db, { url: SITE_URL, domain: DOMAIN });
    db.prepare("DELETE FROM site_meta WHERE key='last_sitemap_diff_at'").run();

    // Second run: page2 removed
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([{ url: `${SITE_URL}/page1` }]),
      '*': ''
    });
    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN });
    expect(result.removed).toContain(`${SITE_URL}/page2`);
  });

  it('returns cached result within diff_every_hours window', async () => {
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([{ url: `${SITE_URL}/page` }]),
      '*': ''
    });
    await runSitemap(db, { url: SITE_URL, domain: DOMAIN });

    // Second run within window — fetch should not be called again
    const callsBefore = fetch.mock.calls.length;
    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN, sitemap: { diff_every_hours: 24 } });
    expect(result.cached).toBe(true);
    expect(fetch.mock.calls.length).toBe(callsBefore); // no new fetches
  });

  it('follows sitemap index chains', async () => {
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap-index.xml`),
      [`${SITE_URL}/sitemap-index.xml`]: sitemapIndex([`${SITE_URL}/sitemap-1.xml`, `${SITE_URL}/sitemap-2.xml`]),
      [`${SITE_URL}/sitemap-1.xml`]: sitemapXml([{ url: `${SITE_URL}/a` }, { url: `${SITE_URL}/b` }]),
      [`${SITE_URL}/sitemap-2.xml`]: sitemapXml([{ url: `${SITE_URL}/c` }]),
      '*': ''
    });

    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN });
    expect(result.total).toBe(3);
    expect(result.added).toContain(`${SITE_URL}/a`);
    expect(result.added).toContain(`${SITE_URL}/c`);
  });

  it('respects exclude paths from site config', async () => {
    mockFetch({
      [`${SITE_URL}/robots.txt`]: robotsTxt(`${SITE_URL}/sitemap.xml`),
      [`${SITE_URL}/sitemap.xml`]: sitemapXml([
        { url: `${SITE_URL}/page` },
        { url: `${SITE_URL}/admin/settings` },
      ]),
      '*': ''
    });

    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN, exclude: ['/admin/'] });
    expect(result.added).toContain(`${SITE_URL}/page`);
    expect(result.added).not.toContain(`${SITE_URL}/admin/settings`);
  });

  it('handles failed sitemap fetch gracefully (returns empty)', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    const result = await runSitemap(db, { url: SITE_URL, domain: DOMAIN });
    expect(result.total).toBe(0);
    expect(result.added).toHaveLength(0);
  });
});
