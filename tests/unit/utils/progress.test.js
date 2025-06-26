/**
 * tests/unit/utils/progress.test.js - Test coverage for progress bar functionality
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {ProgressService} from '../../../src/utils/progress.js';
import chalk from 'chalk';

// Mock external dependencies
vi.mock('cli-progress', () => {
  const mockSingleBar = {
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(),
    setTotal: vi.fn(),
    total: 0
  };
  
  const mockMultiBar = {
    start: vi.fn(),
    stop: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setTotal: vi.fn()
  };
  
  return {
    default: {
      MultiBar: vi.fn(() => mockMultiBar),
      SingleBar: vi.fn(() => mockSingleBar),
      Presets: {
        shades_classic: {}
      }
    }
  };
});

vi.mock('boxen', () => ({
  default: vi.fn((content) => content)
}));

vi.mock('figlet', () => ({
  default: {
    textSync: vi.fn((text) => text)
  }
}));

// Mock fs and path modules
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({version: '1.0.0'}))
}));

vi.mock('path', () => ({
  join: vi.fn((...args) => args.join('/')),
  dirname: vi.fn((path) => path)
}));

vi.mock('url', () => ({
  fileURLToPath: vi.fn((url) => url)
}));

describe('ProgressService', () => {
  let progressService;
  let consoleLogSpy;
  let consoleClearSpy;
  let processStdoutSpy;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    
    // Mock console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleClearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {});
    
    // Mock process.stdout
    processStdoutSpy = {
      columns: 80,
      isTTY: true,
      clearLine: vi.fn(),
      cursorTo: vi.fn(),
      write: vi.fn()
    };
    Object.defineProperty(process, 'stdout', {
      value: processStdoutSpy,
      writable: true
    });
    
    progressService = new ProgressService();
  });

  afterEach(() => {
    // Clean up
    if (progressService && progressService.isActive) {
      progressService.stop();
    }
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      expect(progressService.options).toEqual({});
      expect(progressService.version).toBe('1.0.0');
      expect(progressService.isActive).toBe(false);
      expect(progressService.stats).toMatchObject({
        totalUrls: 0,
        crawledUrls: 0,
        queuedUrls: 0,
        activeUrls: 0,
        assets: {
          total: 0,
          images: 0,
          documents: 0,
          other: 0
        },
        errors: {
          total: 0,
          retries: 0
        },
        newPages: 0,
        updatedPages: 0,
        unchangedPages: 0,
        aiEnhanced: 0,
        aiPending: 0,
        aiRateLimited: 0,
        aiFailed: 0
      });
    });

    it('should accept custom options', () => {
      const customOptions = {
        updateFrequency: 200,
        figletFont: 'Standard'
      };
      const service = new ProgressService(customOptions);
      expect(service.options).toEqual(customOptions);
      expect(service.updateFrequency).toBe(200);
      expect(service.figletOptions.font).toBe('Standard');
    });
  });

  describe('maxPages handling', () => {
    it('should cap progress bar total at maxPages when set', () => {
      progressService.start({maxPages: 10, totalUrls: 1});
      
      // Simulate discovering more URLs than the limit
      progressService.updateStats({
        crawledUrls: 5,
        queuedUrls: 10 // Total would be 15
      });
      
      // Wait for update interval
      vi.advanceTimersByTime(100);
      
      // Should be capped at maxPages
      expect(progressService.multibar.setTotal).toHaveBeenCalledWith(10);
    });

    it('should handle maxPages = 0 gracefully', () => {
      progressService.start({maxPages: 0, totalUrls: 1});
      expect(progressService.maxPages).toBe(0);
      
      // Should not crash when updating
      progressService.updateStats({crawledUrls: 5});
      expect(() => progressService.render()).not.toThrow();
    });

    it('should handle maxPages = null (unlimited)', () => {
      progressService.start({maxPages: null, totalUrls: 1});
      expect(progressService.maxPages).toBe(null);
      
      // Should allow unlimited URLs
      progressService.updateStats({
        crawledUrls: 100,
        queuedUrls: 500
      });
      
      vi.advanceTimersByTime(100);
      
      // Should update to discovered total
      expect(progressService.multibar.setTotal).toHaveBeenCalledWith(600);
    });

    it('should handle negative maxPages by treating as unlimited', () => {
      progressService.start({maxPages: -1, totalUrls: 1});
      
      progressService.updateStats({
        crawledUrls: 50,
        queuedUrls: 50
      });
      
      vi.advanceTimersByTime(100);
      
      // Should not cap the total
      expect(progressService.multibar.setTotal).toHaveBeenCalledWith(100);
    });

    it('should handle undefined maxPages', () => {
      progressService.start({totalUrls: 1});
      expect(progressService.maxPages).toBe(null);
      
      // Should work normally without limit
      progressService.updateStats({crawledUrls: 10});
      expect(() => progressService.render()).not.toThrow();
    });
  });

  describe('start', () => {
    it('should initialize progress display', () => {
      progressService.start({siteUrl: 'https://example.com', totalUrls: 10});
      
      expect(progressService.isActive).toBe(true);
      expect(progressService.stats.totalUrls).toBe(10);
      expect(consoleClearSpy).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Downloading site:'));
      expect(progressService.multibar).toBeDefined();
      expect(progressService.multibar.start).toHaveBeenCalledWith(10, 0);
    });

    it('should handle re-crawl mode', () => {
      progressService.start({
        siteUrl: 'https://example.com',
        isReCrawl: true,
        totalUrls: 5
      });
      
      expect(progressService.isReCrawl).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Updating site download:'));
    });

    it('should stop existing progress before starting new one', () => {
      progressService.start({totalUrls: 5});
      const firstMultibar = progressService.multibar;
      
      progressService.start({totalUrls: 10});
      
      expect(firstMultibar.stop).toHaveBeenCalled();
      expect(progressService.multibar).not.toBe(firstMultibar);
    });
  });

  describe('updateStats', () => {
    beforeEach(() => {
      progressService.start({totalUrls: 10});
    });

    it('should update crawl statistics', () => {
      progressService.updateStats({
        crawledUrls: 5,
        queuedUrls: 3,
        activeUrls: 2
      });
      
      expect(progressService.stats.crawledUrls).toBe(5);
      expect(progressService.stats.queuedUrls).toBe(3);
      expect(progressService.stats.activeUrls).toBe(2);
    });

    it('should update asset statistics', () => {
      progressService.updateStats({
        assets: {
          total: 10,
          images: 5,
          documents: 3,
          other: 2
        }
      });
      
      expect(progressService.stats.assets).toEqual({
        total: 10,
        images: 5,
        documents: 3,
        other: 2
      });
    });

    it('should update error statistics', () => {
      progressService.updateStats({
        errors: {
          total: 2,
          retries: 1
        }
      });
      
      expect(progressService.stats.errors.total).toBe(2);
      expect(progressService.stats.errors.retries).toBe(1);
    });

    it('should update AI enhancement statistics', () => {
      progressService.updateStats({
        aiEnhanced: 3,
        aiPending: 2,
        aiRateLimited: 1,
        aiFailed: 0
      });
      
      expect(progressService.stats.aiEnhanced).toBe(3);
      expect(progressService.stats.aiPending).toBe(2);
      expect(progressService.stats.aiRateLimited).toBe(1);
      expect(progressService.stats.aiFailed).toBe(0);
    });

    it('should update re-crawl statistics when in re-crawl mode', () => {
      progressService.isReCrawl = true;
      progressService.updateStats({
        newPages: 2,
        updatedPages: 3,
        unchangedPages: 5
      });
      
      expect(progressService.stats.newPages).toBe(2);
      expect(progressService.stats.updatedPages).toBe(3);
      expect(progressService.stats.unchangedPages).toBe(5);
    });

    it('should handle partial updates without affecting other stats', () => {
      progressService.stats.crawledUrls = 5;
      progressService.stats.errors.total = 2;
      
      progressService.updateStats({
        queuedUrls: 10
      });
      
      expect(progressService.stats.crawledUrls).toBe(5);
      expect(progressService.stats.queuedUrls).toBe(10);
      expect(progressService.stats.errors.total).toBe(2);
    });
  });

  describe('concurrent update safety', () => {
    it('should handle rapid concurrent updates', async () => {
      progressService.start({totalUrls: 100});
      
      // Simulate concurrent updates
      const updates = [];
      for (let i = 0; i < 50; i++) {
        updates.push(
          progressService.updateStats({
            crawledUrls: i + 1,
            queuedUrls: 100 - i - 1
          })
        );
      }
      
      await Promise.all(updates);
      
      expect(progressService.stats.crawledUrls).toBe(50);
      expect(progressService.stats.queuedUrls).toBe(50);
    });

    it('should handle concurrent URL completions', () => {
      progressService.start({totalUrls: 10});
      
      // Add multiple URLs
      for (let i = 0; i < 5; i++) {
        progressService.addActiveUrl(`https://example.com/page${i}`);
      }
      
      // Complete them concurrently
      for (let i = 0; i < 5; i++) {
        progressService.completeUrl(`https://example.com/page${i}`, 'success');
      }
      
      expect(progressService.stats.crawledUrls).toBe(5);
      expect(progressService.activeDownloads.size).toBe(0);
    });
  });

  describe('stop', () => {
    it('should clean up resources and display completion message', () => {
      progressService.start({totalUrls: 10});
      progressService.updateStats({crawledUrls: 10});
      
      progressService.stop();
      
      expect(progressService.isActive).toBe(false);
      expect(progressService.updateInterval).toBe(null);
      expect(progressService.multibar.stop).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Download completed successfully!'));
    });

    it('should display re-crawl completion message when in re-crawl mode', () => {
      progressService.start({isReCrawl: true, totalUrls: 10});
      progressService.isReCrawl = true;
      progressService.updateStats({
        newPages: 2,
        updatedPages: 3,
        unchangedPages: 5
      });
      
      progressService.stop();
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Re-crawl completed successfully!')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('2 new, 3 updated, 5 unchanged')
      );
    });

    it('should handle stop when already inactive', () => {
      expect(() => progressService.stop()).not.toThrow();
    });

    it('should update final progress to 100% on stop', () => {
      progressService.start({totalUrls: 10});
      progressService.updateStats({crawledUrls: 8});
      
      progressService.stop();
      
      // Should update to final count
      expect(progressService.multibar.update).toHaveBeenCalledWith(8);
    });
  });

  describe('AI processing phase', () => {
    it('should start AI processing with provider info', () => {
      const aiConfig = {
        provider: 'openai',
        model: 'gpt-4'
      };
      
      progressService.startProcessing(100, aiConfig);
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('AI enhancement using')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('openai')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('gpt-4')
      );
    });

    it('should update processing progress', () => {
      progressService.startProcessing(50);
      
      progressService.updateProcessing(25, 50);
      
      expect(progressService.multibar.update).toHaveBeenCalledWith(25);
    });

    it('should handle dynamic total updates during processing', () => {
      progressService.startProcessing(50);
      
      // Total increases during processing
      progressService.updateProcessing(25, 75);
      
      expect(progressService.multibar.setTotal).toHaveBeenCalledWith(75);
      expect(progressService.multibar.update).toHaveBeenCalledWith(25);
    });

    it('should complete processing phase', () => {
      progressService.startProcessing(10);
      
      progressService.completeProcessing();
      
      expect(progressService.multibar.stop).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('AI processing completed successfully!')
      );
    });
  });

  describe('URL tracking', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      progressService.start({totalUrls: 10});
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should add and track active URLs', () => {
      progressService.addActiveUrl('https://example.com/page1');
      
      expect(progressService.activeDownloads.has('https://example.com/page1')).toBe(true);
      expect(progressService.stats.currentUrls).toContain('https://example.com/page1');
    });

    it('should limit current URLs list to 5 most recent', () => {
      for (let i = 1; i <= 7; i++) {
        progressService.addActiveUrl(`https://example.com/page${i}`);
      }
      
      expect(progressService.stats.currentUrls.length).toBe(5);
      expect(progressService.stats.currentUrls).not.toContain('https://example.com/page1');
      expect(progressService.stats.currentUrls).toContain('https://example.com/page7');
    });

    it('should complete URL with different statuses', () => {
      progressService.addActiveUrl('https://example.com/test');
      
      progressService.completeUrl('https://example.com/test', 'success');
      
      expect(progressService.activeDownloads.has('https://example.com/test')).toBe(false);
      expect(progressService.stats.crawledUrls).toBe(1);
      expect(progressService.stats.newPages).toBe(1);
    });

    it('should track different completion statuses correctly', () => {
      const urls = [
        {url: 'https://example.com/1', status: 'success'},
        {url: 'https://example.com/2', status: 'cached'},
        {url: 'https://example.com/3', status: 'error'},
        {url: 'https://example.com/4', status: 'unchanged'},
        {url: 'https://example.com/5', status: 'updated'}
      ];
      
      urls.forEach(({url, status}) => {
        progressService.addActiveUrl(url);
        progressService.completeUrl(url, status);
      });
      
      expect(progressService.stats.crawledUrls).toBe(5);
      expect(progressService.stats.newPages).toBe(1);
      expect(progressService.stats.errors).toBe(1);
      expect(progressService.stats.unchangedPages).toBe(1);
      expect(progressService.stats.updatedPages).toBe(1);
    });
  });

  describe('AI enhancement tracking', () => {
    beforeEach(() => {
      progressService.start({totalUrls: 10});
    });

    it('should track AI enhancement statuses', () => {
      progressService.trackAIEnhancement('url1', 'pending');
      expect(progressService.stats.aiPending).toBe(1);
      
      progressService.trackAIEnhancement('url1', 'success');
      expect(progressService.stats.aiEnhanced).toBe(1);
      expect(progressService.stats.aiPending).toBe(0);
    });

    it('should track rate limiting', () => {
      progressService.trackAIEnhancement('url1', 'pending');
      progressService.trackAIEnhancement('url1', 'rate_limited');
      
      expect(progressService.stats.aiRateLimited).toBe(1);
      expect(progressService.stats.aiPending).toBe(0);
    });

    it('should track failures', () => {
      progressService.trackAIEnhancement('url1', 'pending');
      progressService.trackAIEnhancement('url1', 'failed');
      
      expect(progressService.stats.aiFailed).toBe(1);
      expect(progressService.stats.aiPending).toBe(0);
    });

    it('should calculate AI progress percentage', () => {
      progressService.updateStats({crawledUrls: 10});
      progressService.stats.aiEnhanced = 3;
      progressService.stats.aiRateLimited = 2;
      progressService.stats.aiFailed = 1;
      
      expect(progressService.getAIProgress()).toBe(60); // 6 out of 10 = 60%
    });

    it('should handle zero crawled URLs in AI progress', () => {
      expect(progressService.getAIProgress()).toBe(0);
    });
  });

  describe('time calculations', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01 12:00:00'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should calculate elapsed time correctly', () => {
      progressService.start({totalUrls: 10});
      
      // Advance time by 2 minutes and 30 seconds
      vi.advanceTimersByTime(150000);
      
      const timeInfo = progressService.calculateTimeInfo();
      expect(timeInfo.elapsed).toBe('2m 30s');
    });

    it('should estimate remaining time', () => {
      progressService.start({totalUrls: 100});
      progressService.updateStats({crawledUrls: 25}); // 25% complete
      
      // Advance time by 1 minute
      vi.advanceTimersByTime(60000);
      
      const timeInfo = progressService.calculateTimeInfo();
      expect(timeInfo.elapsed).toBe('1m 0s');
      expect(timeInfo.remaining).toBe('3m 0s'); // 3 more minutes for remaining 75%
    });

    it('should handle zero progress in time estimation', () => {
      progressService.start({totalUrls: 10});
      
      const timeInfo = progressService.calculateTimeInfo();
      expect(timeInfo.remaining).toBe('calculating...');
    });
  });

  describe('error handling', () => {
    it('should handle invalid URLs in formatUrl', () => {
      const result = progressService.formatUrl('not-a-valid-url');
      expect(result).toBe('not-a-valid-url');
    });

    it('should handle missing package.json gracefully', () => {
      // Create a new ProgressService class with mocked fs that throws
      vi.doMock('fs', () => ({
        readFileSync: vi.fn(() => {
          throw new Error('File not found');
        })
      }));
      
      // Clear module cache to force re-import with new mock
      vi.resetModules();
      
      // Re-import ProgressService with the throwing mock
      return import('../../../src/utils/progress.js').then(module => {
        const service = new module.ProgressService();
        expect(service.version).toBe('0.4.0'); // fallback version
        
        // Restore original mocks
        vi.resetModules();
        vi.clearAllMocks();
      });
    });

    it('should handle progress bar errors during stop', () => {
      progressService.start({totalUrls: 10});
      progressService.multibar.stop = vi.fn(() => {
        throw new Error('Stop failed');
      });
      
      process.env.DEBUG = 'true';
      
      expect(() => progressService.stop()).not.toThrow();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Error stopping progress bar'));
      
      delete process.env.DEBUG;
    });
  });

  describe('display formatting', () => {
    it('should format URLs for display', () => {
      const tests = [
        {
          input: 'https://example.com/very/long/path/that/exceeds/forty/characters',
          expected: expect.stringContaining('...')
        },
        {
          input: 'https://example.com/short',
          expected: '/short'
        },
        {
          input: 'https://example.com/',
          expected: '/'
        }
      ];
      
      tests.forEach(({input, expected}) => {
        expect(progressService.formatUrl(input)).toEqual(expected);
      });
    });

    it('should render summary with correct statistics', () => {
      progressService.start({totalUrls: 100});
      progressService.stats = {
        ...progressService.stats,
        crawledUrls: 90,
        totalUrls: 100,
        assets: {total: 50, images: 30, documents: 20, other: 0},
        errors: {total: 5, retries: 2},
        aiEnhanced: 80,
        startTime: Date.now() - 120000 // 2 minutes ago
      };
      
      progressService.renderSummary();
      
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('CRAWL COMPLETE'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('90 of 100'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('50 total'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('80 of 90'));
    });
  });
});