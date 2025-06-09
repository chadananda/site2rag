import { describe, it, expect } from 'vitest';
import { matchGlob, safeFilename, normalizeUrl, CrawlLimitReached } from '../../src/site_processor_utils.js';

describe('matchGlob', () => {
  it('should match exact paths', () => {
    expect(matchGlob('/about', '/about')).toBe(true);
    expect(matchGlob('/about', '/contact')).toBe(false);
  });

  it('should handle single asterisk wildcards', () => {
    expect(matchGlob('/blog/*', '/blog/post-1')).toBe(true);
    expect(matchGlob('/blog/*', '/blog/post-1/comments')).toBe(false);
    expect(matchGlob('/*.html', '/page.html')).toBe(true);
    expect(matchGlob('/*.html', '/page.txt')).toBe(false);
  });

  it('should handle double asterisk wildcards', () => {
    expect(matchGlob('/blog/**', '/blog/post-1')).toBe(true);
    expect(matchGlob('/blog/**', '/blog/post-1/comments')).toBe(true);
    expect(matchGlob('/blog/**', '/about')).toBe(false);
  });

  it('should handle special case for /**', () => {
    expect(matchGlob('/**', '/')).toBe(true);
    expect(matchGlob('/**', '/any/path/here')).toBe(true);
  });

  it('should escape regex special characters', () => {
    expect(matchGlob('/page.html', '/page.html')).toBe(true);
    expect(matchGlob('/page+info', '/page+info')).toBe(true);
    expect(matchGlob('/page[1]', '/page[1]')).toBe(true);
  });
});

describe('safeFilename', () => {
  it('should convert URLs to safe filenames', () => {
    expect(safeFilename('https://example.com/about')).toBe('about.md');
    expect(safeFilename('https://example.com/blog/post-1')).toBe('blog_post-1.md');
  });

  it('should handle URLs with special characters', () => {
    expect(safeFilename('https://example.com/page?id=123')).toBe('page.md');
    expect(safeFilename('https://example.com/blog/post:special')).toBe('blog_post_special.md');
  });

  it('should handle root URL', () => {
    expect(safeFilename('https://example.com/')).toBe('index.md');
    expect(safeFilename('https://example.com')).toBe('index.md');
  });

  it('should handle invalid URLs', () => {
    expect(safeFilename('not-a-url')).toBe('page.md');
  });
});

describe('normalizeUrl', () => {
  it('should normalize URLs by removing hash and search params', () => {
    expect(normalizeUrl('https://example.com/page?query=123#section')).toBe('https://example.com/page');
  });

  it('should handle trailing slashes consistently', () => {
    expect(normalizeUrl('https://example.com/about/')).toBe('https://example.com/about');
    expect(normalizeUrl('https://example.com/about')).toBe('https://example.com/about');
  });

  it('should keep root slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('should handle duplicate slashes', () => {
    expect(normalizeUrl('https://example.com//page///subpage')).toBe('https://example.com/page/subpage');
  });

  it('should handle invalid URLs', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('CrawlLimitReached', () => {
  it('should be an instance of Error', () => {
    const error = new CrawlLimitReached();
    expect(error).toBeInstanceOf(Error);
  });

  it('should have the correct name and message', () => {
    const error = new CrawlLimitReached();
    expect(error.name).toBe('CrawlLimitReached');
    expect(error.message).toBe('Crawl limit reached');
  });
});
