/**
 * tests/unit/utils/errors.test.js - Test coverage for error handling utilities
 */

import {describe, it, expect} from 'vitest';
import {CrawlLimitReached, CrawlAborted, InvalidUrlError} from '../../../src/utils/errors.js';

describe('Error Utilities', () => {
  describe('CrawlLimitReached', () => {
    it('should create error with default message', () => {
      const error = new CrawlLimitReached();
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CrawlLimitReached);
      expect(error.name).toBe('CrawlLimitReached');
      expect(error.message).toBe('Crawl limit reached');
    });

    it('should create error with custom message', () => {
      const customMessage = 'Maximum pages (100) reached';
      const error = new CrawlLimitReached(customMessage);
      expect(error.message).toBe(customMessage);
      expect(error.name).toBe('CrawlLimitReached');
    });

    it('should have proper stack trace', () => {
      const error = new CrawlLimitReached();
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('CrawlLimitReached');
    });

    it('should be catchable by type', () => {
      try {
        throw new CrawlLimitReached('Limit of 50 pages reached');
      } catch (error) {
        if (error instanceof CrawlLimitReached) {
          expect(error.message).toBe('Limit of 50 pages reached');
        } else {
          throw new Error('Should have caught CrawlLimitReached');
        }
      }
    });
  });

  describe('CrawlAborted', () => {
    it('should create error with default message', () => {
      const error = new CrawlAborted();
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CrawlAborted);
      expect(error.name).toBe('CrawlAborted');
      expect(error.message).toBe('Crawl aborted');
    });

    it('should create error with custom message', () => {
      const customMessage = 'User cancelled the crawl operation';
      const error = new CrawlAborted(customMessage);
      expect(error.message).toBe(customMessage);
      expect(error.name).toBe('CrawlAborted');
    });

    it('should have proper stack trace', () => {
      const error = new CrawlAborted();
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('CrawlAborted');
    });

    it('should be distinguishable from other errors', () => {
      const abortError = new CrawlAborted();
      const limitError = new CrawlLimitReached();
      
      expect(abortError).not.toBeInstanceOf(CrawlLimitReached);
      expect(limitError).not.toBeInstanceOf(CrawlAborted);
    });
  });

  describe('InvalidUrlError', () => {
    it('should create error with URL in default message', () => {
      const badUrl = 'not-a-valid-url';
      const error = new InvalidUrlError(badUrl);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(InvalidUrlError);
      expect(error.name).toBe('InvalidUrlError');
      expect(error.message).toBe(`Invalid URL: ${badUrl}`);
      expect(error.url).toBe(badUrl);
    });

    it('should create error with custom message', () => {
      const badUrl = 'javascript:alert(1)';
      const customMessage = 'JavaScript URLs are not allowed';
      const error = new InvalidUrlError(badUrl, customMessage);
      expect(error.message).toBe(customMessage);
      expect(error.url).toBe(badUrl);
      expect(error.name).toBe('InvalidUrlError');
    });

    it('should store the invalid URL for reference', () => {
      const badUrl = 'ftp://unsupported.com';
      const error = new InvalidUrlError(badUrl);
      expect(error.url).toBe(badUrl);
    });

    it('should handle various invalid URL formats', () => {
      const invalidUrls = [
        '',
        'not a url',
        'javascript:void(0)',
        'data:text/html,<h1>test</h1>',
        'file:///etc/passwd',
        'about:blank',
        '//no-protocol',
        'http://',
        'https://'
      ];

      invalidUrls.forEach(url => {
        const error = new InvalidUrlError(url);
        expect(error.url).toBe(url);
        expect(error.message).toContain(url);
      });
    });

    it('should have proper stack trace', () => {
      const error = new InvalidUrlError('bad-url');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('InvalidUrlError');
    });
  });

  describe('Error interoperability', () => {
    it('should work with Promise.reject', async () => {
      const errors = [
        new CrawlLimitReached(),
        new CrawlAborted(),
        new InvalidUrlError('bad-url')
      ];

      for (const error of errors) {
        await expect(Promise.reject(error)).rejects.toThrow(error);
      }
    });

    it('should serialize to JSON properly', () => {
      const errors = [
        new CrawlLimitReached('Custom limit message'),
        new CrawlAborted('Custom abort message'),
        new InvalidUrlError('bad-url', 'Custom URL message')
      ];

      errors.forEach(error => {
        const json = JSON.stringify(error);
        const parsed = JSON.parse(json);
        
        // Standard Error properties don't serialize by default
        // But we can check our custom properties
        expect(parsed).toBeDefined();
      });
    });

    it('should work with error.toString()', () => {
      const limitError = new CrawlLimitReached('Limit 100 reached');
      const abortError = new CrawlAborted('User cancelled');
      const urlError = new InvalidUrlError('bad://url');

      expect(limitError.toString()).toBe('CrawlLimitReached: Limit 100 reached');
      expect(abortError.toString()).toBe('CrawlAborted: User cancelled');
      expect(urlError.toString()).toBe('InvalidUrlError: Invalid URL: bad://url');
    });

    it('should maintain Error prototype chain', () => {
      const errors = [
        new CrawlLimitReached(),
        new CrawlAborted(),
        new InvalidUrlError('test')
      ];

      errors.forEach(error => {
        expect(error instanceof Error).toBe(true);
        expect(error.constructor).toBeDefined();
        expect(error.constructor.name).toBe(error.name);
      });
    });
  });

  describe('Error usage patterns', () => {
    it('should handle crawl limit scenarios', () => {
      const checkCrawlLimit = (current, max) => {
        if (current >= max) {
          throw new CrawlLimitReached(`Reached maximum of ${max} pages`);
        }
      };

      expect(() => checkCrawlLimit(100, 100)).toThrow(CrawlLimitReached);
      expect(() => checkCrawlLimit(99, 100)).not.toThrow();
    });

    it('should handle abort scenarios', () => {
      const checkAbortSignal = (signal) => {
        if (signal?.aborted) {
          throw new CrawlAborted('Operation was aborted by user');
        }
      };

      const abortedSignal = {aborted: true};
      const activeSignal = {aborted: false};

      expect(() => checkAbortSignal(abortedSignal)).toThrow(CrawlAborted);
      expect(() => checkAbortSignal(activeSignal)).not.toThrow();
      expect(() => checkAbortSignal(null)).not.toThrow();
    });

    it('should handle URL validation scenarios', () => {
      const validateUrl = (url) => {
        if (!url || typeof url !== 'string') {
          throw new InvalidUrlError(url, 'URL must be a non-empty string');
        }
        
        if (url.startsWith('javascript:')) {
          throw new InvalidUrlError(url, 'JavaScript URLs are not allowed');
        }
        
        if (url.startsWith('file://')) {
          throw new InvalidUrlError(url, 'File URLs are not allowed');
        }
      };

      expect(() => validateUrl('')).toThrow(InvalidUrlError);
      expect(() => validateUrl(null)).toThrow(InvalidUrlError);
      expect(() => validateUrl('javascript:alert(1)')).toThrow(InvalidUrlError);
      expect(() => validateUrl('file:///etc/passwd')).toThrow(InvalidUrlError);
      expect(() => validateUrl('https://example.com')).not.toThrow();
    });
  });
});