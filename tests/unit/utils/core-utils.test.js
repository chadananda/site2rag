import {describe, it, expect, beforeEach, vi} from 'vitest';
import {matchGlob, safeFilename, normalizeUrl} from '../../../src/utils/site_utils.js';
import {handlePreviousCrawl, handleNotModified, updateCrawlState} from '../../../src/utils/site_helpers.js';
import {generateFullSelectorPath, analyzeSelectorPath, isLikelyFrameworkWrapper} from '../../../src/utils/dom_utils.js';

// Consolidated core utility tests
describe('Core Utils', () => {
  describe('Site Utilities', () => {
    describe('URL Pattern Matching', () => {
      it('should match universal pattern /**', () => {
        expect(matchGlob('/**', '/any/path')).toBe(true);
        expect(matchGlob('/**', '/blog/post')).toBe(true);
        expect(matchGlob('/**', '/')).toBe(true);
      });

      it('should match directory patterns with /**', () => {
        expect(matchGlob('/blog/**', '/blog')).toBe(true);
        expect(matchGlob('/blog/**', '/blog/post')).toBe(true);
        expect(matchGlob('/blog/**', '/blog/category/post')).toBe(true);
        expect(matchGlob('/blog/**', '/other')).toBe(false);
      });

      it('should match exact paths', () => {
        expect(matchGlob('/exact/path', '/exact/path')).toBe(true);
        expect(matchGlob('/exact/path', '/exact/other')).toBe(false);
      });

      it('should escape special regex characters', () => {
        expect(matchGlob('/path.with.dots', '/path.with.dots')).toBe(true);
        expect(matchGlob('/path.with.dots', '/pathXwithXdots')).toBe(false);
        expect(matchGlob('/path+with+plus', '/path+with+plus')).toBe(true);
      });
    });

    describe('Safe Filename Generation', () => {
      it('should convert root URL to index.md', () => {
        expect(safeFilename('https://example.com/')).toBe('index.md');
        expect(safeFilename('https://example.com')).toBe('index.md');
      });

      it('should convert path URLs to safe filenames', () => {
        expect(safeFilename('https://example.com/blog/post')).toBe('blog_post.md');
        expect(safeFilename('https://example.com/docs/api/v1')).toBe('docs_api_v1.md');
      });

      it('should replace invalid filename characters', () => {
        expect(safeFilename('https://example.com/path:with:colons')).toBe('path_with_colons.md');
        expect(safeFilename('https://example.com/path?query=value')).toBe('path.md');
        expect(safeFilename('https://example.com/path|with|pipes')).toBe('path_with_pipes.md');
      });

      it('should handle invalid URLs gracefully', () => {
        expect(safeFilename('not-a-valid-url')).toBe('page.md');
        expect(safeFilename('')).toBe('page.md');
        expect(safeFilename('ftp://invalid.protocol')).toBe('page.md');
      });
    });

    describe('URL Normalization', () => {
      const baseUrl = 'https://example.com';

      it('should resolve relative URLs', () => {
        expect(normalizeUrl('/path', baseUrl)).toBe('https://example.com/path');
        expect(normalizeUrl('path', baseUrl)).toBe('https://example.com/path');
        expect(normalizeUrl('./path', baseUrl)).toBe('https://example.com/path');
      });

      it('should remove hash fragments and query parameters', () => {
        expect(normalizeUrl('https://example.com/path#section', baseUrl)).toBe('https://example.com/path');
        expect(normalizeUrl('https://example.com/path?query=value', baseUrl)).toBe('https://example.com/path');
      });

      it('should remove trailing slashes except for root', () => {
        expect(normalizeUrl('https://example.com/', baseUrl)).toBe('https://example.com/');
        expect(normalizeUrl('https://example.com/path/', baseUrl)).toBe('https://example.com/path');
      });

      it('should normalize duplicate slashes in path', () => {
        expect(normalizeUrl('https://example.com//path//to//resource', baseUrl)).toBe(
          'https://example.com/path/to/resource'
        );
      });
    });
  });

  describe('Site Processing Helpers', () => {
    let mockCrawlState;
    let mockResponse;

    beforeEach(() => {
      mockCrawlState = {
        getPage: vi.fn(),
        upsertPage: vi.fn()
      };

      mockResponse = {
        headers: {
          get: vi.fn(key => {
            const headers = {
              etag: '"test-etag"',
              'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
            };
            return headers[key] || null;
          })
        }
      };
    });

    describe('Previous Crawl Handling', () => {
      it('should return empty headers when no previous data exists', async () => {
        mockCrawlState.getPage.mockReturnValue(null);

        const result = await handlePreviousCrawl(mockCrawlState, 'https://example.com/page');

        expect(result).toEqual({headers: {}});
      });

      it('should include conditional headers when previous data exists', async () => {
        mockCrawlState.getPage.mockReturnValue({
          etag: '"previous-etag"',
          lastModified: 'Tue, 20 Oct 2015 07:28:00 GMT'
        });

        const result = await handlePreviousCrawl(mockCrawlState, 'https://example.com/page');

        expect(result.headers['If-None-Match']).toBe('"previous-etag"');
        expect(result.headers['If-Modified-Since']).toBe('Tue, 20 Oct 2015 07:28:00 GMT');
      });
    });

    describe('Not Modified Response Handling', () => {
      it('should mark URL as visited and re-add unvisited links', async () => {
        const visited = new Set(['https://example.com/visited']);
        const found = [];
        const prevData = {
          links: ['https://example.com/link1', 'https://example.com/link2', 'https://example.com/visited']
        };

        await handleNotModified('https://example.com/page', prevData, visited, found);

        expect(visited.has('https://example.com/page')).toBe(true);
        expect(found).toContain('https://example.com/link1');
        expect(found).toContain('https://example.com/link2');
        expect(found).not.toContain('https://example.com/visited');
      });
    });

    describe('Crawl State Updates', () => {
      it('should update crawl state with response headers and links', async () => {
        const url = 'https://example.com/page';
        const links = ['https://example.com/link1', 'https://example.com/link2'];

        await updateCrawlState(url, mockResponse, links, mockCrawlState);

        expect(mockCrawlState.upsertPage).toHaveBeenCalledWith(url, {
          etag: '"test-etag"',
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          links,
          lastCrawled: expect.any(String)
        });
      });
    });
  });

  describe('DOM Utilities', () => {
    let mockHtml;

    beforeEach(() => {
      mockHtml = `
        <html>
          <body>
            <nav class="main-nav" id="navigation">
              <ul>
                <li><a href="/home">Home</a></li>
                <li><a href="/about">About</a></li>
              </ul>
            </nav>
            <main class="content">
              <article class="post">
                <h1>Article Title</h1>
                <p>Article content here</p>
              </article>
            </main>
            <aside class="sidebar">
              <div class="widget">Widget content</div>
            </aside>
            <footer class="site-footer">
              <p>Copyright 2024</p>
            </footer>
          </body>
        </html>
      `;
    });

    describe('CSS Selector Generation', () => {
      it('should generate full selector paths for elements', () => {
        const {load} = require('cheerio');
        const $ = load(mockHtml);

        const navElement = $('nav').first();
        const selector = generateFullSelectorPath(navElement, $);

        expect(selector).toContain('nav');
        expect(selector).toContain('main-nav');
      });

      it('should analyze selector path specificity', () => {
        const selector = 'nav.main-nav#navigation ul li a';
        const analysis = analyzeSelectorPath(selector);

        expect(analysis.specificity).toBeGreaterThan(0);
        expect(analysis.hasId).toBe(true);
        expect(analysis.hasClass).toBe(true);
        expect(analysis.depth).toBeGreaterThan(3);
      });
    });

    describe('Framework Detection', () => {
      it('should identify React framework wrappers', () => {
        expect(isLikelyFrameworkWrapper('div[data-reactroot]')).toBe(true);
        expect(isLikelyFrameworkWrapper('div.__react-wrapper')).toBe(true);
        expect(isLikelyFrameworkWrapper('div[data-react-class]')).toBe(true);
      });

      it('should identify Vue framework wrappers', () => {
        expect(isLikelyFrameworkWrapper('div[data-v-12345]')).toBe(true);
        expect(isLikelyFrameworkWrapper('div.vue-component')).toBe(true);
        expect(isLikelyFrameworkWrapper('[v-cloak]')).toBe(true);
      });

      it('should identify Next.js framework wrappers', () => {
        expect(isLikelyFrameworkWrapper('div#__next')).toBe(true);
        expect(isLikelyFrameworkWrapper('div.__next-wrapper')).toBe(true);
      });

      it('should identify Nuxt.js framework wrappers', () => {
        expect(isLikelyFrameworkWrapper('div#__nuxt')).toBe(true);
        expect(isLikelyFrameworkWrapper('div.__nuxt-wrapper')).toBe(true);
      });

      it('should identify Angular framework wrappers', () => {
        expect(isLikelyFrameworkWrapper('div[ng-app]')).toBe(true);
        expect(isLikelyFrameworkWrapper('div[data-ng-app]')).toBe(true);
        expect(isLikelyFrameworkWrapper('app-root')).toBe(true);
      });

      it('should not identify regular content as framework wrappers', () => {
        expect(isLikelyFrameworkWrapper('div.content')).toBe(false);
        expect(isLikelyFrameworkWrapper('article.post')).toBe(false);
        expect(isLikelyFrameworkWrapper('main.page-content')).toBe(false);
      });
    });
  });
});
