import {describe, it, expect} from 'vitest';
import {UrlService, normalizeUrl, safeFilename, matchGlob} from '../../../src/services/url_service.js';

describe('UrlService', () => {
  const urlService = new UrlService();

  describe('normalizeUrl', () => {
    it('should remove hash and query parameters', () => {
      expect(urlService.normalizeUrl('https://example.com/page?query=123#section')).toBe('https://example.com/page');
    });

    it('should handle trailing slashes consistently', () => {
      expect(urlService.normalizeUrl('https://example.com/about/')).toBe('https://example.com/about');
      expect(urlService.normalizeUrl('https://example.com/about')).toBe('https://example.com/about');
    });

    it('should keep root slash', () => {
      expect(urlService.normalizeUrl('https://example.com/')).toBe('https://example.com/');
    });

    it('should handle duplicate slashes', () => {
      expect(urlService.normalizeUrl('https://example.com//page///subpage')).toBe('https://example.com/page/subpage');
    });

    it('should handle invalid URLs', () => {
      expect(urlService.normalizeUrl('not-a-url')).toBe('not-a-url');
    });

    it('should match standalone function', () => {
      const url = 'https://example.com/page?query=123#section';
      expect(normalizeUrl(url)).toBe(urlService.normalizeUrl(url));
    });
  });

  describe('safeFilename', () => {
    it('should convert URLs to safe filenames', () => {
      expect(urlService.safeFilename('https://example.com/about')).toBe('about.md');
      expect(urlService.safeFilename('https://example.com/blog/post-1')).toBe('blog_post-1.md');
    });

    it('should handle URLs with special characters', () => {
      expect(urlService.safeFilename('https://example.com/page?id=123')).toBe('page.md');
      expect(urlService.safeFilename('https://example.com/blog/post:special')).toBe('blog_post_special.md');
    });

    it('should handle root URL', () => {
      expect(urlService.safeFilename('https://example.com/')).toBe('index.md');
      expect(urlService.safeFilename('https://example.com')).toBe('index.md');
    });

    it('should handle invalid URLs', () => {
      expect(urlService.safeFilename('not-a-url')).toBe('page.md');
    });

    it('should match standalone function', () => {
      const url = 'https://example.com/blog/post-1';
      expect(safeFilename(url)).toBe(urlService.safeFilename(url));
    });
  });

  describe('matchGlob', () => {
    it('should match exact paths', () => {
      expect(urlService.matchGlob('/about', '/about')).toBe(true);
      expect(urlService.matchGlob('/about', '/contact')).toBe(false);
    });

    it('should handle single asterisk wildcards', () => {
      expect(urlService.matchGlob('/blog/*', '/blog/post-1')).toBe(true);
      expect(urlService.matchGlob('/blog/*', '/blog/post-1/comments')).toBe(false);
      expect(urlService.matchGlob('/*.html', '/page.html')).toBe(true);
      expect(urlService.matchGlob('/*.html', '/page.txt')).toBe(false);
    });

    it('should handle double asterisk wildcards', () => {
      expect(urlService.matchGlob('/blog/**', '/blog/post-1')).toBe(true);
      expect(urlService.matchGlob('/blog/**', '/blog/post-1/comments')).toBe(true);
      expect(urlService.matchGlob('/blog/**', '/about')).toBe(false);
    });

    it('should handle special case for /**', () => {
      expect(urlService.matchGlob('/**', '/')).toBe(true);
      expect(urlService.matchGlob('/**', '/any/path/here')).toBe(true);
    });

    it('should escape regex special characters', () => {
      expect(urlService.matchGlob('/page.html', '/page.html')).toBe(true);
      expect(urlService.matchGlob('/page+info', '/page+info')).toBe(true);
      expect(urlService.matchGlob('/page[1]', '/page[1]')).toBe(true);
    });

    it('should match standalone function', () => {
      const pattern = '/blog/**';
      const path = '/blog/post-1/comments';
      expect(matchGlob(pattern, path)).toBe(urlService.matchGlob(pattern, path));
    });
  });

  describe('matchesPatterns', () => {
    it('should match included patterns', () => {
      const patterns = ['/*', '/blog/**', '/docs/*'];
      expect(urlService.matchesPatterns('https://example.com/about', patterns)).toBe(true);
      expect(urlService.matchesPatterns('https://example.com/blog/post-1/comments', patterns)).toBe(true);
      expect(urlService.matchesPatterns('https://example.com/docs/guide', patterns)).toBe(true);
    });

    it('should exclude negated patterns', () => {
      const patterns = ['/*', '/blog/**', '!/blog/private/**'];
      expect(urlService.matchesPatterns('https://example.com/blog/public', patterns)).toBe(true);
      expect(urlService.matchesPatterns('https://example.com/blog/private/secret', patterns)).toBe(false);
    });

    it('should handle empty patterns array', () => {
      expect(urlService.matchesPatterns('https://example.com/about', [])).toBe(true);
      expect(urlService.matchesPatterns('https://example.com/about', null)).toBe(true);
    });

    it('should handle invalid URLs', () => {
      const patterns = ['/*'];
      expect(urlService.matchesPatterns('not-a-url', patterns)).toBe(false);
    });
  });

  describe('shouldSkip', () => {
    it('should skip visited URLs', () => {
      const visited = new Set(['https://example.com/visited']);
      expect(urlService.shouldSkip('https://example.com/visited', 1, 3, visited)).toBe(true);
      expect(urlService.shouldSkip('https://example.com/new', 1, 3, visited)).toBe(false);
    });

    it('should skip URLs beyond max depth', () => {
      const visited = new Set();
      expect(urlService.shouldSkip('https://example.com/deep', 4, 3, visited)).toBe(true);
      expect(urlService.shouldSkip('https://example.com/shallow', 2, 3, visited)).toBe(false);
    });
  });
});
