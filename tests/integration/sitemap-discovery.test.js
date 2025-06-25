import {describe, it, expect, beforeEach} from 'vitest';
import {SitemapService} from '../../src/services/sitemap_service.js';
import {FetchService} from '../../src/services/fetch_service.js';

describe('Real Site Sitemap Discovery', () => {
  let sitemapService;
  let fetchService;

  beforeEach(() => {
    fetchService = new FetchService({politeWaitMs: 1000});
    sitemapService = new SitemapService(fetchService);
  });

  const testSites = [
    {
      name: 'bahai-education.org',
      url: 'https://bahai-education.org',
      expectSitemap: true,
      description: 'Educational site - likely has sitemap'
    },
    {
      name: 'oceanlibrary.com',
      url: 'https://oceanlibrary.com',
      expectSitemap: true,
      description: 'Library site - likely has sitemap'
    },
    {
      name: 'oceanoflights.org',
      url: 'https://oceanoflights.org',
      expectSitemap: true,
      description: 'Content site - likely has sitemap'
    },
    {
      name: 'deenbahai.org',
      url: 'https://deenbahai.org',
      expectSitemap: false,
      description: 'Site with bad home page - testing fallback behavior'
    }
  ];

  testSites.forEach(site => {
    it(`should discover sitemaps for ${site.name}`, async () => {
      console.log(`\n=== Testing ${site.name} (${site.description}) ===`);

      try {
        // Test sitemap discovery
        const sitemapUrls = await sitemapService.discoverSitemapUrls(site.url);
        console.log(`Discovered ${sitemapUrls.length} sitemap files for ${site.name}:`);
        sitemapUrls.forEach(url => console.log(`  - ${url}`));

        if (site.expectSitemap) {
          expect(sitemapUrls.length).toBeGreaterThan(0);
        }

        // Test URL extraction from sitemaps
        const allUrls = await sitemapService.getAllSitemapUrls(site.url);
        console.log(`Extracted ${allUrls.length} URLs from sitemaps for ${site.name}`);

        if (allUrls.length > 0) {
          console.log(`Sample URLs from ${site.name}:`);
          allUrls.slice(0, 5).forEach(url => console.log(`  - ${url}`));
          if (allUrls.length > 5) {
            console.log(`  ... and ${allUrls.length - 5} more URLs`);
          }
        }

        // Verify URLs are from same domain
        if (allUrls.length > 0) {
          const siteHostname = new URL(site.url).hostname;
          const allSameDomain = allUrls.every(url => {
            try {
              return new URL(url).hostname === siteHostname;
            } catch {
              return false;
            }
          });
          expect(allSameDomain).toBe(true);
        }

        // For sites expected to have sitemaps, verify we got URLs
        if (site.expectSitemap && sitemapUrls.length > 0) {
          expect(allUrls.length).toBeGreaterThan(0);
        }

        console.log(`✓ ${site.name} sitemap discovery completed`);
      } catch (error) {
        console.error(`Error testing ${site.name}: ${error.message}`);

        // For sites not expected to have sitemaps, errors are acceptable
        if (!site.expectSitemap) {
          console.log(`Expected behavior for ${site.name} - no sitemap found`);
        } else {
          throw error;
        }
      }
    }, 30000); // 30 second timeout for network requests
  });

  it('should handle robots.txt sitemap declarations correctly', async () => {
    console.log('\n=== Testing robots.txt sitemap extraction ===');

    // Test a site known to have sitemap declarations in robots.txt
    const testUrl = 'https://bahai-education.org';

    try {
      const robotsUrl = `${testUrl}/robots.txt`;
      const response = await fetchService.fetchWithRetry(robotsUrl);

      if (response.ok) {
        const robotsText = await response.text();
        console.log('robots.txt content preview:');
        console.log(robotsText.split('\n').slice(0, 10).join('\n'));

        const sitemaps = sitemapService.extractSitemapsFromRobots(robotsText, testUrl);
        console.log(`Found ${sitemaps.length} sitemap declarations in robots.txt:`);
        sitemaps.forEach(sitemap => console.log(`  - ${sitemap}`));

        // Verify extracted sitemaps are valid URLs
        sitemaps.forEach(sitemap => {
          expect(() => new URL(sitemap)).not.toThrow();
        });
      } else {
        console.log('robots.txt not accessible or not found');
      }
    } catch (error) {
      console.log(`robots.txt test failed: ${error.message}`);
    }
  }, 15000);
});
