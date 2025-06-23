import {describe, it} from 'vitest';
import {SitemapService} from '../../src/services/sitemap_service.js';
import {FetchService} from '../../src/services/fetch_service.js';

describe('Sitemap Discovery Debug', () => {
  it('should debug sitemap discovery for test sites', async () => {
    const fetchService = new FetchService({politeWaitMs: 500});
    const sitemapService = new SitemapService(fetchService);
    
    const testUrls = [
      'https://bahai-education.org',
      'https://oceanoflights.org', 
      'https://deenbahai.org'
    ];

    for (const testUrl of testUrls) {
      console.log(`\n=== Debugging ${testUrl} ===`);
      
      try {
        // Test robots.txt first
        const robotsUrl = `${testUrl}/robots.txt`;
        console.log(`Checking robots.txt at: ${robotsUrl}`);
        
        const robotsResponse = await fetchService.fetchUrl(robotsUrl);
        console.log(`robots.txt status: ${robotsResponse.status}`);
        
        if (robotsResponse.ok) {
          const robotsText = await robotsResponse.text();
          console.log(`robots.txt length: ${robotsText.length} chars`);
          console.log('robots.txt preview:');
          console.log(robotsText.substring(0, 500));
          
          const robotsSitemaps = sitemapService.extractSitemapsFromRobots(robotsText, testUrl);
          console.log(`Sitemaps found in robots.txt: ${robotsSitemaps.length}`);
          robotsSitemaps.forEach(sitemap => console.log(`  - ${sitemap}`));
        } else {
          console.log('robots.txt not found or inaccessible');
        }
        
        // Test common sitemap paths
        const commonPaths = [
          '/sitemap.xml',
          '/sitemap_index.xml', 
          '/sitemaps.xml',
          '/sitemap/sitemap.xml',
          '/wp-sitemap.xml'
        ];
        
        console.log('\nTesting common sitemap paths:');
        for (const path of commonPaths) {
          const sitemapUrl = `${testUrl}${path}`;
          try {
            const response = await fetchService.fetchUrl(sitemapUrl, {method: 'HEAD'});
            console.log(`${path}: ${response.status} ${response.ok ? '✓' : '✗'}`);
            if (response.ok) {
              const contentType = response.headers.get('content-type') || 'unknown';
              console.log(`  Content-Type: ${contentType}`);
            }
          } catch (error) {
            console.log(`${path}: ERROR - ${error.message}`);
          }
        }
        
      } catch (error) {
        console.error(`Error testing ${testUrl}: ${error.message}`);
      }
    }
  }, 60000);
});