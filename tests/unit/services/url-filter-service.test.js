import {describe, it, expect, beforeEach} from 'vitest';
import {UrlFilterService} from '../../../src/services/url_filter_service.js';

describe('UrlFilterService', () => {
  let filterService;

  describe('Path Filtering', () => {
    beforeEach(() => {
      filterService = new UrlFilterService({
        excludePaths: ['/terms', '/privacy', '/blog']
      });
    });

    it('should exclude exact path matches', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/terms')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/privacy')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/blog')).toBe(false);
    });

    it('should exclude subdirectories of excluded paths', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/terms/service')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/privacy/policy')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/blog/post-1')).toBe(false);
    });

    it('should allow URLs not matching excluded paths', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/')).toBe(true);
      expect(filterService.shouldCrawlUrl('https://example.com/about')).toBe(true);
      expect(filterService.shouldCrawlUrl('https://example.com/contact')).toBe(true);
    });

    it('should handle URLs with query parameters', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/terms?lang=en')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/about?lang=en')).toBe(true);
    });

    it('should handle invalid URLs gracefully', () => {
      expect(filterService.shouldCrawlUrl('not-a-url')).toBe(true);
      expect(filterService.shouldCrawlUrl('')).toBe(true);
    });
  });

  describe('Pattern Filtering', () => {
    beforeEach(() => {
      filterService = new UrlFilterService({
        excludePatterns: ['\\.(pdf|doc|zip)$', '/admin/'],
        includePatterns: ['/articles/', '/docs/']
      });
    });

    it('should exclude URLs matching exclude patterns', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/file.pdf')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/document.doc')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/archive.zip')).toBe(false);
      expect(filterService.shouldCrawlUrl('https://example.com/admin/users')).toBe(false);
    });

    it('should include only URLs matching include patterns when specified', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/articles/news')).toBe(true);
      expect(filterService.shouldCrawlUrl('https://example.com/docs/guide')).toBe(true);
      expect(filterService.shouldCrawlUrl('https://example.com/about')).toBe(false);
    });

    it('should apply exclude patterns even with include patterns', () => {
      expect(filterService.shouldCrawlUrl('https://example.com/articles/file.pdf')).toBe(false);
    });

    it('should handle invalid regex patterns gracefully', () => {
      filterService = new UrlFilterService({
        excludePatterns: ['[invalid regex']
      });
      expect(filterService.shouldCrawlUrl('https://example.com/test')).toBe(true);
    });
  });

  describe('Language Filtering', () => {
    beforeEach(() => {
      filterService = new UrlFilterService({
        includeLanguage: 'en'
      });
    });

    it('should allow content with target language', () => {
      const html = '<html lang="en"><head><title>Test</title></head></html>';
      expect(filterService.shouldProcessContent(html, 'https://example.com/test')).toBe(true);
    });

    it('should reject content with different language', () => {
      const html = '<html lang="fr"><head><title>Test</title></head></html>';
      expect(filterService.shouldProcessContent(html, 'https://example.com/test')).toBe(false);
    });

    it('should reject content with no language when target specified', () => {
      const html = '<html><head><title>Test</title></head></html>';
      expect(filterService.shouldProcessContent(html, 'https://example.com/test')).toBe(false);
    });

    it('should allow all content when no language filter specified', () => {
      filterService = new UrlFilterService({});
      const html = '<html lang="fr"><head><title>Test</title></head></html>';
      expect(filterService.shouldProcessContent(html, 'https://example.com/test')).toBe(true);
    });
  });

  describe('Combined Filtering', () => {
    beforeEach(() => {
      filterService = new UrlFilterService({
        excludePaths: ['/admin'],
        excludePatterns: ['\\.(pdf|zip)$'],
        includeLanguage: 'en',
        includePatterns: ['/docs/']
      });
    });

    it('should apply all URL filters correctly', () => {
      // Should be excluded by path
      expect(filterService.shouldCrawlUrl('https://example.com/admin/test')).toBe(false);
      
      // Should be excluded by pattern
      expect(filterService.shouldCrawlUrl('https://example.com/docs/file.pdf')).toBe(false);
      
      // Should be excluded by include pattern
      expect(filterService.shouldCrawlUrl('https://example.com/about')).toBe(false);
      
      // Should be allowed
      expect(filterService.shouldCrawlUrl('https://example.com/docs/guide')).toBe(true);
    });

    it('should apply content filters after URL filters', () => {
      const englishHtml = '<html lang="en"><head><title>Test</title></head></html>';
      const frenchHtml = '<html lang="fr"><head><title>Test</title></head></html>';
      
      expect(filterService.shouldProcessContent(englishHtml, 'https://example.com/docs/test')).toBe(true);
      expect(filterService.shouldProcessContent(frenchHtml, 'https://example.com/docs/test')).toBe(false);
    });
  });

  describe('Configuration', () => {
    it('should handle empty configuration', () => {
      filterService = new UrlFilterService({});
      expect(filterService.shouldCrawlUrl('https://example.com/anything')).toBe(true);
      
      const html = '<html><head><title>Test</title></head></html>';
      expect(filterService.shouldProcessContent(html, 'https://example.com/test')).toBe(true);
    });

    it('should handle undefined configuration', () => {
      filterService = new UrlFilterService();
      expect(filterService.shouldCrawlUrl('https://example.com/anything')).toBe(true);
    });

    it('should expose filter configuration', () => {
      const config = {
        excludePaths: ['/test'],
        excludePatterns: ['pattern'],
        includeLanguage: 'en',
        includePatterns: ['include']
      };
      filterService = new UrlFilterService(config);
      
      const returned = filterService.getFilterConfig();
      expect(returned.excludePaths).toEqual(['/test']);
      expect(returned.excludePatterns).toEqual(['pattern']);
      expect(returned.includeLanguage).toBe('en');
      expect(returned.includePatterns).toEqual(['include']);
    });
  });
});