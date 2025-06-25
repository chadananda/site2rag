import {describe, it, expect, vi, beforeEach} from 'vitest';
import {CrawlService} from '../../../src/services/crawl_service.js';

describe('CrawlService Sitemap Integration', () => {
  let crawlService;
  let mockFetchService;
  let mockUrlService;
  let mockFileService;
  let mockContentService;
  let mockMarkdownService;
  let mockCrawlStateService;

  beforeEach(() => {
    mockFetchService = {
      fetchUrl: vi.fn()
    };
    mockUrlService = {};
    mockFileService = {};
    mockContentService = {};
    mockMarkdownService = {};
    mockCrawlStateService = {};

    crawlService = new CrawlService({
      domain: 'https://example.com',
      fetchService: mockFetchService,
      urlService: mockUrlService,
      fileService: mockFileService,
      contentService: mockContentService,
      markdownService: mockMarkdownService,
      crawlStateService: mockCrawlStateService
    });
  });

  it('should discover and queue sitemap URLs', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

    // Mock sitemap discovery chain
    mockFetchService.fetchUrl
      // robots.txt
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('Sitemap: https://example.com/sitemap.xml')
      })
      // common paths (none found) - 5 HEAD requests for remaining paths
      .mockResolvedValueOnce({ok: false}) // sitemap_index.xml
      .mockResolvedValueOnce({ok: false}) // sitemaps.xml
      .mockResolvedValueOnce({ok: false}) // sitemap/sitemap.xml
      .mockResolvedValueOnce({ok: false}) // wp-sitemap.xml
      .mockResolvedValueOnce({ok: false}) // sitemap/index.xml
      // sitemap content
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', '300']]),
        text: () => Promise.resolve(sitemapXml)
      });

    const sitemapUrls = await crawlService.processSitemaps('https://example.com');

    expect(sitemapUrls).toEqual(['https://example.com/page1', 'https://example.com/page2']);

    // Verify URLs were added to queue
    expect(crawlService.queuedUrls.has('https://example.com/page1')).toBe(true);
    expect(crawlService.queuedUrls.has('https://example.com/page2')).toBe(true);
  });

  it('should handle sitemap discovery errors gracefully', async () => {
    mockFetchService.fetchUrl.mockRejectedValue(new Error('Network error'));

    const sitemapUrls = await crawlService.processSitemaps('https://example.com');

    expect(sitemapUrls).toEqual([]);
    expect(crawlService.queuedUrls.size).toBe(0);
  });

  it('should not duplicate URLs already in queue', async () => {
    // Pre-add a URL to the queue
    crawlService.queuedUrls.add('https://example.com/page1');

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

    mockFetchService.fetchUrl
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('Sitemap: https://example.com/sitemap.xml')
      })
      .mockResolvedValueOnce({ok: false})
      .mockResolvedValueOnce({ok: false})
      .mockResolvedValueOnce({ok: false})
      .mockResolvedValueOnce({ok: false})
      .mockResolvedValueOnce({ok: false})
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', '300']]),
        text: () => Promise.resolve(sitemapXml)
      });

    await crawlService.processSitemaps('https://example.com');

    // Should only have 2 URLs in queue (no duplicates)
    expect(crawlService.queuedUrls.size).toBe(2);
    expect(crawlService.queuedUrls.has('https://example.com/page1')).toBe(true);
    expect(crawlService.queuedUrls.has('https://example.com/page2')).toBe(true);
  });
});
