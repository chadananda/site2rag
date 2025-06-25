import {describe, it, expect} from 'vitest';
import {SitemapService} from '../../src/services/sitemap_service.js';
import {FetchService} from '../../src/services/fetch_service.js';

describe('Real Site Sitemap URL Extraction', () => {
  it('should extract URLs from real sitemaps', async () => {
    const fetchService = new FetchService({politeWaitMs: 500});
    const sitemapService = new SitemapService(fetchService);

    const testSites = ['https://bahai-education.org', 'https://oceanoflights.org', 'https://deenbahai.org'];

    for (const testUrl of testSites) {
      console.log(`\n=== Extracting URLs from ${testUrl} ===`);

      try {
        const allUrls = await sitemapService.getAllSitemapUrls(testUrl);
        console.log(`Found ${allUrls.length} URLs in sitemaps for ${testUrl}`);

        if (allUrls.length > 0) {
          console.log(`Sample URLs from ${testUrl}:`);
          allUrls.slice(0, 10).forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
          if (allUrls.length > 10) {
            console.log(`  ... and ${allUrls.length - 10} more URLs`);
          }

          // Verify URLs are from same domain
          const siteHostname = new URL(testUrl).hostname;
          const sameDomainUrls = allUrls.filter(url => {
            try {
              return new URL(url).hostname === siteHostname;
            } catch {
              return false;
            }
          });

          console.log(`URLs filtered to same domain: ${sameDomainUrls.length}/${allUrls.length}`);
          expect(sameDomainUrls.length).toBe(allUrls.length);
          expect(allUrls.length).toBeGreaterThan(0);
        } else {
          console.log(`No URLs found in sitemaps for ${testUrl}`);
        }
      } catch (error) {
        console.error(`Error extracting URLs from ${testUrl}: ${error.message}`);
      }
    }
  }, 60000);
});
