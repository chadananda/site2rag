import {describe, it, expect, vi, beforeEach} from 'vitest';
import {SitemapService} from '../../../src/services/sitemap_service.js';

describe('SitemapService', () => {
  let sitemapService;
  let mockFetchService;

  beforeEach(() => {
    mockFetchService = {
      fetchUrl: vi.fn()
    };
    sitemapService = new SitemapService(mockFetchService);
  });

  describe('extractSitemapsFromRobots', () => {
    it('should extract sitemap URLs from robots.txt', () => {
      const robotsContent = `User-agent: *
Disallow: /admin/
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml

# Comments
User-agent: Googlebot
Allow: /public/`;

      const sitemaps = sitemapService.extractSitemapsFromRobots(robotsContent, 'https://example.com');
      
      expect(sitemaps).toEqual([
        'https://example.com/sitemap.xml',
        'https://example.com/news-sitemap.xml'
      ]);
    });

    it('should handle relative sitemap URLs', () => {
      const robotsContent = `Sitemap: /sitemap.xml
Sitemap: sitemap-news.xml`;

      const sitemaps = sitemapService.extractSitemapsFromRobots(robotsContent, 'https://example.com');
      
      expect(sitemaps).toEqual([
        'https://example.com/sitemap.xml',
        'https://example.com/sitemap-news.xml'
      ]);
    });

    it('should handle case insensitive sitemap declarations', () => {
      const robotsContent = `SITEMAP: https://example.com/sitemap.xml
sitemap: https://example.com/other.xml`;

      const sitemaps = sitemapService.extractSitemapsFromRobots(robotsContent, 'https://example.com');
      
      expect(sitemaps).toEqual([
        'https://example.com/sitemap.xml',
        'https://example.com/other.xml'
      ]);
    });

    it('should handle relative URLs by making them absolute', () => {
      const robotsContent = `Sitemap: relative-sitemap.xml
Sitemap: https://example.com/valid.xml`;

      const sitemaps = sitemapService.extractSitemapsFromRobots(robotsContent, 'https://example.com');
      
      expect(sitemaps).toEqual([
        'https://example.com/relative-sitemap.xml',
        'https://example.com/valid.xml'
      ]);
    });
  });

  describe('discoverSitemapUrls', () => {
    it('should discover sitemaps from robots.txt and common paths', async () => {
      // Mock robots.txt response
      mockFetchService.fetchUrl
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('Sitemap: https://example.com/sitemap.xml')
        })
        // Mock HEAD requests for common paths (first one exists)
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'application/xml']])
        })
        // Rest don't exist
        .mockResolvedValue({ok: false});

      const sitemaps = await sitemapService.discoverSitemapUrls('https://example.com');
      
      expect(sitemaps).toEqual([
        'https://example.com/sitemap.xml',
        'https://example.com/sitemap_index.xml'
      ]);
    });

    it('should handle robots.txt fetch failure gracefully', async () => {
      mockFetchService.fetchUrl
        .mockRejectedValueOnce(new Error('robots.txt not found'))
        // Mock one common path exists
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/xml']])
        })
        .mockResolvedValue({ok: false});

      const sitemaps = await sitemapService.discoverSitemapUrls('https://example.com');
      
      expect(sitemaps).toEqual(['https://example.com/sitemap.xml']);
    });

    it('should skip duplicate sitemaps found in both robots.txt and common paths', async () => {
      mockFetchService.fetchUrl
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('Sitemap: https://example.com/sitemap.xml')
        })
        // Mock HEAD request for the same sitemap (should be skipped)
        .mockResolvedValue({ok: false});

      const sitemaps = await sitemapService.discoverSitemapUrls('https://example.com');
      
      expect(sitemaps).toEqual(['https://example.com/sitemap.xml']);
      // Should not make HEAD request for sitemap.xml since it was in robots.txt
      expect(mockFetchService.fetchUrl).toHaveBeenCalledTimes(6); // robots.txt + 5 other common paths
    });
  });

  describe('parseSitemap', () => {
    it('should parse regular sitemap with URLs', async () => {
      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2023-01-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
    <lastmod>2023-01-02</lastmod>
  </url>
</urlset>`;

      mockFetchService.fetchUrl.mockResolvedValue({
        ok: true,
        headers: new Map([['content-length', '500']]),
        text: () => Promise.resolve(sitemapXml)
      });

      const urls = await sitemapService.parseSitemap('https://example.com/sitemap.xml');
      
      expect(urls).toEqual([
        'https://example.com/page1',
        'https://example.com/page2'
      ]);
    });

    it('should parse sitemap index and fetch nested sitemaps', async () => {
      const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>`;

      const sitemap1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
</urlset>`;

      const sitemap2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

      mockFetchService.fetchUrl
        // First call for index
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-length', '300']]),
          text: () => Promise.resolve(indexXml)
        })
        // Calls for nested sitemaps
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-length', '200']]),
          text: () => Promise.resolve(sitemap1Xml)
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-length', '200']]),
          text: () => Promise.resolve(sitemap2Xml)
        });

      const urls = await sitemapService.parseSitemap('https://example.com/index.xml');
      
      expect(urls).toEqual([
        'https://example.com/page1',
        'https://example.com/page2'
      ]);
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetchService.fetchUrl.mockResolvedValue({
        ok: false,
        status: 404
      });

      const urls = await sitemapService.parseSitemap('https://example.com/nonexistent.xml');
      
      expect(urls).toEqual([]);
    });

    it('should skip oversized sitemaps', async () => {
      mockFetchService.fetchUrl.mockResolvedValue({
        ok: true,
        headers: new Map([['content-length', '100000000']]), // 100MB
        text: () => Promise.resolve('<xml>large content</xml>')
      });

      const urls = await sitemapService.parseSitemap('https://example.com/huge.xml');
      
      expect(urls).toEqual([]);
    });

    it('should handle malformed XML gracefully', async () => {
      mockFetchService.fetchUrl.mockResolvedValue({
        ok: true,
        headers: new Map([['content-length', '100']]),
        text: () => Promise.resolve('<invalid><xml><structure>')
      });

      const urls = await sitemapService.parseSitemap('https://example.com/bad.xml');
      
      expect(urls).toEqual([]);
    });

    it('should respect max URLs limit', async () => {
      // Create sitemap with many URLs
      const manyUrls = Array.from({length: 100}, (_, i) => 
        `  <url><loc>https://example.com/page${i}</loc></url>`
      ).join('\n');
      
      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${manyUrls}
</urlset>`;

      mockFetchService.fetchUrl.mockResolvedValue({
        ok: true,
        headers: new Map([['content-length', '5000']]),
        text: () => Promise.resolve(sitemapXml)
      });

      // Set low max for testing
      sitemapService.maxUrls = 10;
      const urls = await sitemapService.parseSitemap('https://example.com/many.xml');
      
      expect(urls).toHaveLength(10);
      expect(urls[0]).toBe('https://example.com/page0');
      expect(urls[9]).toBe('https://example.com/page9');
    });
  });

  describe('getAllSitemapUrls', () => {
    it('should return empty array when no sitemaps found', async () => {
      mockFetchService.fetchUrl.mockResolvedValue({ok: false});

      const urls = await sitemapService.getAllSitemapUrls('https://example.com');
      
      expect(urls).toEqual([]);
    });

    it('should combine URLs from multiple sitemaps and remove duplicates', async () => {
      const sitemapXml1 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

      const sitemapXml2 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page2</loc></url>
  <url><loc>https://example.com/page3</loc></url>
</urlset>`;

      mockFetchService.fetchUrl
        // robots.txt
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(`Sitemap: https://example.com/sitemap1.xml
Sitemap: https://example.com/sitemap2.xml`)
        })
        // common paths (none found) - 6 HEAD requests
        .mockResolvedValueOnce({ok: false})
        .mockResolvedValueOnce({ok: false})
        .mockResolvedValueOnce({ok: false})
        .mockResolvedValueOnce({ok: false})
        .mockResolvedValueOnce({ok: false})
        .mockResolvedValueOnce({ok: false})
        // sitemap1
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-length', '300']]),
          text: () => Promise.resolve(sitemapXml1)
        })
        // sitemap2
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-length', '300']]),
          text: () => Promise.resolve(sitemapXml2)
        });

      const urls = await sitemapService.getAllSitemapUrls('https://example.com');
      
      expect(urls).toEqual([
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page3'
      ]);
    });

    it('should filter URLs to same domain only', async () => {
      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://other-domain.com/page2</loc></url>
  <url><loc>https://example.com/page3</loc></url>
</urlset>`;

      mockFetchService.fetchUrl
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('Sitemap: https://example.com/sitemap.xml')
        })
        // common paths (first one is sitemap.xml which is already in robots.txt, so will be skipped)
        // Actually need to provide 6 HEAD requests for the 6 common paths minus sitemap.xml
        .mockResolvedValueOnce({ok: false}) // sitemap_index.xml
        .mockResolvedValueOnce({ok: false}) // sitemaps.xml  
        .mockResolvedValueOnce({ok: false}) // sitemap/sitemap.xml
        .mockResolvedValueOnce({ok: false}) // wp-sitemap.xml
        .mockResolvedValueOnce({ok: false}) // sitemap/index.xml
        // sitemap content fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-length', '400']]),
          text: () => Promise.resolve(sitemapXml)
        });

      const urls = await sitemapService.getAllSitemapUrls('https://example.com');
      
      expect(urls).toEqual([
        'https://example.com/page1',
        'https://example.com/page3'
      ]);
    });
  });
});