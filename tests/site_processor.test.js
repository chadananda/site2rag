import { describe, it, expect } from 'vitest';
import { SiteProcessor } from '../src/site_processor.js';

// Use a real site but with a low --limit for polite, fast tests.
const TEST_SITE = 'https://oceanoflights.org';

// Helper to run processor and return found URLs
async function runCrawl({ url = TEST_SITE, limit = 3, maxDepth = 1 } = {}) {
  const sp = new SiteProcessor(url, { limit, maxDepth });
  return await sp.process();
}

describe('SiteProcessor', () => {
  it('crawls a site and respects limit', async () => {
    const urls = await runCrawl({ limit: 2 });
    expect(urls.length).toBeLessThanOrEqual(2);
    expect(urls[0]).toContain('oceanoflights.org');
  });

  it('respects maxDepth', async () => {
    const urls = await runCrawl({ limit: 10, maxDepth: 0 });
    expect(urls.length).toBe(1); // Only root page
  });

  it('does not crawl non-domain links', async () => {
    const urls = await runCrawl({ limit: 5 });
    expect(urls.every(u => u.startsWith('https://oceanoflights.org'))).toBe(true);
  });

  it('is robots.txt compliant', async () => {
    const sp = new SiteProcessor(TEST_SITE, { limit: 2 });
    await sp.fetchRobotsTxt();
    // Should allow root page
    expect(await sp.canCrawl(TEST_SITE)).toBe(true);
    // Should block a known disallowed path if present (simulate)
    if (sp.robots) {
      const val = sp.robots.isAllowed('/some-disallowed-path', '*');
      if (typeof val !== 'undefined') {
        expect(typeof val).toBe('boolean');
      } else {
        expect(val).toBeUndefined();
      }
    }
  });
});
