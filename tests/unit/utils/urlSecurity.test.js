// urlSecurity.test.js
import {describe, it, expect} from 'vitest';
import {
  validateUrl,
  sanitizeFilename,
  isPathSafe,
  createSafeUrlResolver,
  UrlRateLimiter
} from '../../../src/utils/urlSecurity.js';
describe('urlSecurity', () => {
  describe('validateUrl', () => {
    it('should accept valid HTTP/HTTPS URLs', () => {
      expect(validateUrl('https://example.com')).toEqual({isValid: true, reason: null});
      expect(validateUrl('http://example.com/path')).toEqual({isValid: true, reason: null});
      expect(validateUrl('https://sub.example.com:8080/path?query=1')).toEqual({isValid: true, reason: null});
    });

    it('should reject file protocol by default', () => {
      const result = validateUrl('file:///etc/passwd');
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('File protocol not allowed');
    });

    it('should reject localhost by default', () => {
      const result = validateUrl('http://localhost:3000');
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('Localhost');
    });

    it('should reject private IPs', () => {
      expect(validateUrl('http://192.168.1.1').isValid).toBe(false);
      expect(validateUrl('http://10.0.0.1').isValid).toBe(false);
      expect(validateUrl('http://172.16.0.1').isValid).toBe(false);
    });

    it('should reject path traversal patterns', () => {
      expect(validateUrl('http://example.com/../etc/passwd').isValid).toBe(false);
      expect(validateUrl('http://example.com/%2e%2e/').isValid).toBe(false);
    });

    it('should reject javascript protocol', () => {
      const result = validateUrl('javascript:alert(1)');
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('JavaScript');
    });

    it('should allow localhost when option is set', () => {
      const result = validateUrl('http://localhost:3000', {allowLocalhost: true});
      expect(result.isValid).toBe(true);
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove path separators', () => {
      expect(sanitizeFilename('../../etc/passwd')).toBe('__etc_passwd');
      expect(sanitizeFilename('path/to/file.txt')).toBe('path_to_file.txt');
      expect(sanitizeFilename('path\\to\\file.txt')).toBe('path_to_file.txt');
    });

    it('should remove dangerous characters', () => {
      expect(sanitizeFilename('file<>:"|?*.txt')).toBe('file_______.txt');
      expect(sanitizeFilename('file\x00\x1f.txt')).toBe('file__.txt');
    });

    it('should handle empty or invalid input', () => {
      expect(sanitizeFilename('')).toBe('unnamed');
      expect(sanitizeFilename(null)).toBe('unnamed');
      expect(sanitizeFilename('...')).toBe('unnamed');
    });

    it('should limit filename length', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
      expect(result.endsWith('.txt')).toBe(true);
    });
  });

  describe('isPathSafe', () => {
    it('should allow paths within base directory', () => {
      expect(isPathSafe('/base', '/base/subdir/file.txt')).toBe(true);
      expect(isPathSafe('/base', 'subdir/file.txt')).toBe(true);
      expect(isPathSafe('/base', '/base')).toBe(true);
    });

    it('should reject paths outside base directory', () => {
      expect(isPathSafe('/base', '/base/../outside')).toBe(false);
      expect(isPathSafe('/base', '/etc/passwd')).toBe(false);
      expect(isPathSafe('/base/dir', '/base/other')).toBe(false);
    });
  });

  describe('createSafeUrlResolver', () => {
    it('should resolve relative URLs safely', () => {
      const resolver = createSafeUrlResolver('https://example.com/base/');
      expect(resolver('page.html')).toBe('https://example.com/base/page.html');
      expect(resolver('/absolute/path')).toBe('https://example.com/absolute/path');
      expect(resolver('https://other.com/')).toBe('https://other.com/');
    });

    it('should reject invalid base URLs', () => {
      expect(() => {
        const resolver = createSafeUrlResolver('javascript:alert(1)');
        resolver('test');
      }).toThrow('Invalid base URL');
    });

    it('should reject resolved URLs that fail validation', () => {
      const resolver = createSafeUrlResolver('https://example.com');
      expect(() => resolver('javascript:alert(1)')).toThrow('Invalid resolved URL');
    });
  });

  describe('UrlRateLimiter', () => {
    it('should allow requests within limit', () => {
      const limiter = new UrlRateLimiter({maxRequests: 3, windowMs: 1000});
      expect(limiter.isAllowed('test')).toBe(true);
      expect(limiter.isAllowed('test')).toBe(true);
      expect(limiter.isAllowed('test')).toBe(true);
      expect(limiter.getRemaining('test')).toBe(0);
    });

    it('should block requests over limit', () => {
      const limiter = new UrlRateLimiter({maxRequests: 2, windowMs: 1000});
      expect(limiter.isAllowed('test')).toBe(true);
      expect(limiter.isAllowed('test')).toBe(true);
      expect(limiter.isAllowed('test')).toBe(false);
    });

    it('should track different identifiers separately', () => {
      const limiter = new UrlRateLimiter({maxRequests: 1, windowMs: 1000});
      expect(limiter.isAllowed('site1')).toBe(true);
      expect(limiter.isAllowed('site2')).toBe(true);
      expect(limiter.isAllowed('site1')).toBe(false);
      expect(limiter.isAllowed('site2')).toBe(false);
    });
  });
});
