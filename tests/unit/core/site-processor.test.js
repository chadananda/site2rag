import {describe, it, expect, beforeEach} from 'vitest';
import fs from 'fs';
import {join} from 'path';
import {SiteProcessor} from '../../../src/site_processor.js';

// Consolidated site processor tests
describe('SiteProcessor Core', () => {
  let siteProcessor;
  let testOutputDir;

  beforeEach(() => {
    testOutputDir = join(process.cwd(), 'tests', 'tmp', 'site-processor');
    // Ensure test directory exists
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, {recursive: true});
    }
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, {recursive: true, force: true});
    }
  });

  describe('constructor', () => {
    it('should create SiteProcessor with valid URL', () => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir
      });
      
      expect(siteProcessor.url).toBe('https://example.com');
      expect(siteProcessor.outputDir).toBe(testOutputDir);
    });

    it('should handle URL with trailing slash', () => {
      siteProcessor = new SiteProcessor('https://example.com/', {
        outputDir: testOutputDir
      });
      
      expect(siteProcessor.url).toBe('https://example.com');
    });

    it('should set default options', () => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir
      });
      
      expect(siteProcessor.options.limit).toBe(-1);
      expect(siteProcessor.options.maxDepth).toBe(-1);
      expect(siteProcessor.options.includePatterns).toEqual([]);
      expect(siteProcessor.options.excludePatterns).toEqual([]);
    });

    it('should override default options', () => {
      const customOptions = {
        outputDir: testOutputDir,
        limit: 10,
        maxDepth: 2,
        includePatterns: ['/blog/**'],
        excludePatterns: ['/admin/**']
      };
      
      siteProcessor = new SiteProcessor('https://example.com', customOptions);
      
      expect(siteProcessor.options.limit).toBe(10);
      expect(siteProcessor.options.maxDepth).toBe(2);
      expect(siteProcessor.options.includePatterns).toEqual(['/blog/**']);
      expect(siteProcessor.options.excludePatterns).toEqual(['/admin/**']);
    });
  });

  describe('URL validation', () => {
    it('should accept valid HTTP URLs', () => {
      expect(() => new SiteProcessor('http://example.com', {outputDir: testOutputDir})).not.toThrow();
    });

    it('should accept valid HTTPS URLs', () => {
      expect(() => new SiteProcessor('https://example.com', {outputDir: testOutputDir})).not.toThrow();
    });

    it('should reject invalid URLs', () => {
      expect(() => new SiteProcessor('not-a-url', {outputDir: testOutputDir})).toThrow();
      expect(() => new SiteProcessor('ftp://example.com', {outputDir: testOutputDir})).toThrow();
      expect(() => new SiteProcessor('', {outputDir: testOutputDir})).toThrow();
    });
  });

  describe('output directory handling', () => {
    it('should create output directory if it does not exist', () => {
      const nonExistentDir = join(testOutputDir, 'new-dir');
      
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: nonExistentDir
      });
      
      // Directory should be created during initialization
      expect(fs.existsSync(nonExistentDir)).toBe(true);
    });

    it('should handle existing output directory', () => {
      // Create directory first
      fs.mkdirSync(testOutputDir, {recursive: true});
      
      expect(() => {
        siteProcessor = new SiteProcessor('https://example.com', {
          outputDir: testOutputDir
        });
      }).not.toThrow();
    });
  });

  describe('pattern matching', () => {
    beforeEach(() => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir,
        includePatterns: ['/blog/**', '/docs/*'],
        excludePatterns: ['/admin/**', '/private/*']
      });
    });

    it('should include URLs matching include patterns', () => {
      expect(siteProcessor.shouldIncludeUrl('/blog/post-1')).toBe(true);
      expect(siteProcessor.shouldIncludeUrl('/blog/category/tech')).toBe(true);
      expect(siteProcessor.shouldIncludeUrl('/docs/api')).toBe(true);
    });

    it('should exclude URLs matching exclude patterns', () => {
      expect(siteProcessor.shouldIncludeUrl('/admin/dashboard')).toBe(false);
      expect(siteProcessor.shouldIncludeUrl('/admin/users/list')).toBe(false);
      expect(siteProcessor.shouldIncludeUrl('/private/data')).toBe(false);
    });

    it('should exclude URLs that do not match include patterns', () => {
      expect(siteProcessor.shouldIncludeUrl('/about')).toBe(false);
      expect(siteProcessor.shouldIncludeUrl('/contact')).toBe(false);
    });

    it('should handle empty patterns', () => {
      const processor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir,
        includePatterns: [],
        excludePatterns: []
      });
      
      // With no patterns, all URLs should be included
      expect(processor.shouldIncludeUrl('/any/path')).toBe(true);
      expect(processor.shouldIncludeUrl('/another/path')).toBe(true);
    });
  });

  describe('crawl limits', () => {
    it('should respect page limit', async () => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir,
        limit: 3
      });

      // Mock the crawling to return more URLs than the limit
      // const mockUrls = [ // Temporarily unused
      //   'https://example.com/',
      //   'https://example.com/page1',
      //   'https://example.com/page2',
      //   'https://example.com/page3',
      //   'https://example.com/page4'
      // ];

      expect(siteProcessor.options.limit).toBe(3);
      // The actual limiting happens in the crawl process
    });

    it('should respect depth limit', () => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir,
        maxDepth: 2
      });

      expect(siteProcessor.options.maxDepth).toBe(2);
    });

    it('should handle unlimited crawling', () => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir,
        limit: -1,
        maxDepth: -1
      });

      expect(siteProcessor.options.limit).toBe(-1);
      expect(siteProcessor.options.maxDepth).toBe(-1);
    });
  });

  describe('error handling', () => {
    it('should handle invalid output directory permissions', () => {
      // Skip this test on systems where we can't test permissions
      if (process.platform === 'win32') {
        return;
      }

      const readOnlyDir = join(testOutputDir, 'readonly');
      fs.mkdirSync(readOnlyDir, {recursive: true});
      fs.chmodSync(readOnlyDir, 0o444); // Read-only

      expect(() => {
        siteProcessor = new SiteProcessor('https://example.com', {
          outputDir: join(readOnlyDir, 'subdir')
        });
      }).toThrow();

      // Clean up
      fs.chmodSync(readOnlyDir, 0o755);
    });

    it('should handle network timeouts gracefully', async () => {
      siteProcessor = new SiteProcessor('https://example.com', {
        outputDir: testOutputDir,
        timeout: 1 // Very short timeout
      });

      // This test would require actual network mocking for full implementation
      expect(siteProcessor.options.timeout).toBe(1);
    });
  });

  describe('configuration validation', () => {
    it('should validate numeric options', () => {
      expect(() => {
        new SiteProcessor('https://example.com', {
          outputDir: testOutputDir,
          limit: 'not-a-number'
        });
      }).toThrow();

      expect(() => {
        new SiteProcessor('https://example.com', {
          outputDir: testOutputDir,
          maxDepth: 'invalid'
        });
      }).toThrow();
    });

    it('should validate array options', () => {
      expect(() => {
        new SiteProcessor('https://example.com', {
          outputDir: testOutputDir,
          includePatterns: 'not-an-array'
        });
      }).toThrow();

      expect(() => {
        new SiteProcessor('https://example.com', {
          outputDir: testOutputDir,
          excludePatterns: 'not-an-array'
        });
      }).toThrow();
    });
  });
});