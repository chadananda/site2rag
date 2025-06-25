import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import path from 'path';
import {SelectorDB} from '../../../src/utils/selector_db.js';
import {CrawlLimitReached, CrawlAborted, InvalidUrlError} from '../../../src/utils/errors.js';
import {ProgressService} from '../../../src/utils/progress.js';

// Mock external dependencies
vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      run: vi.fn(),
      all: vi.fn(),
      get: vi.fn()
    })),
    close: vi.fn()
  }))
}));

vi.mock('cli-progress', () => ({
  MultiBar: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn()
  })),
  SingleBar: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn()
  })),
  Presets: {
    shades_classic: {}
  }
}));

vi.mock('boxen', () => ({
  default: vi.fn(content => `[BOXED] ${content}`)
}));

vi.mock('chalk', () => ({
  default: {
    cyan: vi.fn(text => text),
    green: vi.fn(text => text),
    yellow: vi.fn(text => text)
  },
  cyan: {bold: vi.fn(text => text)},
  green: {bold: vi.fn(text => text)},
  yellow: {bold: vi.fn(text => text)},
  gray: vi.fn(text => text),
  red: vi.fn(text => text),
  blue: vi.fn(text => text),
  white: vi.fn(text => text),
  hex: vi.fn(() => vi.fn(text => text)),
  bold: vi.fn(text => text)
}));

vi.mock('figures', () => ({default: {}}));
vi.mock('figlet', () => ({default: {textSync: vi.fn(() => 'ASCII ART')}}));
vi.mock('path', () => ({default: {}}));
vi.mock('fs', () => ({default: {}}));

// Consolidated database and utility tests
describe('Database Utils', () => {
  describe('Custom Error Classes', () => {
    describe('CrawlLimitReached', () => {
      it('should create error with default message', () => {
        const error = new CrawlLimitReached();

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(CrawlLimitReached);
        expect(error.name).toBe('CrawlLimitReached');
        expect(error.message).toBe('Crawl limit reached');
      });

      it('should create error with custom message', () => {
        const customMessage = 'Maximum pages crawled (500)';
        const error = new CrawlLimitReached(customMessage);

        expect(error.message).toBe(customMessage);
        expect(error.name).toBe('CrawlLimitReached');
      });

      it('should be throwable and catchable', () => {
        expect(() => {
          throw new CrawlLimitReached('Test limit');
        }).toThrow(CrawlLimitReached);

        try {
          throw new CrawlLimitReached('Test limit');
        } catch (error) {
          expect(error).toBeInstanceOf(CrawlLimitReached);
          expect(error.message).toBe('Test limit');
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

      it('should be distinguishable from other error types', () => {
        const crawlAborted = new CrawlAborted();
        const crawlLimit = new CrawlLimitReached();

        expect(crawlAborted).toBeInstanceOf(CrawlAborted);
        expect(crawlAborted).not.toBeInstanceOf(CrawlLimitReached);
        expect(crawlLimit).not.toBeInstanceOf(CrawlAborted);
      });
    });

    describe('InvalidUrlError', () => {
      it('should create error with URL and default message', () => {
        const invalidUrl = 'not-a-valid-url';
        const error = new InvalidUrlError(invalidUrl);

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(InvalidUrlError);
        expect(error.name).toBe('InvalidUrlError');
        expect(error.message).toBe(`Invalid URL: ${invalidUrl}`);
        expect(error.url).toBe(invalidUrl);
      });

      it('should store the invalid URL for reference', () => {
        const invalidUrl = 'ftp://unsupported.protocol';
        const error = new InvalidUrlError(invalidUrl);

        expect(error.url).toBe(invalidUrl);
      });

      it('should handle empty or null URLs', () => {
        const emptyError = new InvalidUrlError('');
        const nullError = new InvalidUrlError(null);

        expect(emptyError.url).toBe('');
        expect(emptyError.message).toBe('Invalid URL: ');

        expect(nullError.url).toBe(null);
        expect(nullError.message).toBe('Invalid URL: null');
      });
    });
  });

  describe('SelectorDB', () => {
    let selectorDB;
    let mockPrepare;
    let mockRun;
    let mockAll;
    let mockGet;
    let testDbPath;

    beforeEach(() => {
      testDbPath = path.join(process.cwd(), 'tests', 'test-selectors.db');

      // Set up mock chain
      mockRun = vi.fn();
      mockAll = vi.fn();
      mockGet = vi.fn();
      mockPrepare = vi.fn(() => ({
        run: mockRun,
        all: mockAll,
        get: mockGet
      }));

      // Get the mocked Database constructor
      const Database = vi.mocked(require('better-sqlite3').default);
      const mockDb = Database();
      mockDb.prepare = mockPrepare;

      selectorDB = new SelectorDB(testDbPath);
    });

    afterEach(() => {
      if (selectorDB) {
        selectorDB.close();
      }

      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    });

    describe('record selector actions', () => {
      it('should record keep action for selector', () => {
        const selector = '.main-content';

        selectorDB.recordSelector(selector, 'keep');

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO block_selectors'));
        expect(mockRun).toHaveBeenCalledWith(selector, expect.any(String));
      });

      it('should record delete action for selector', () => {
        const selector = '.advertisement';

        selectorDB.recordSelector(selector, 'delete');

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('VALUES (?, 0, 1, ?)'));
        expect(mockRun).toHaveBeenCalledWith(selector, expect.any(String));
      });

      it('should ignore invalid actions', () => {
        selectorDB.recordSelector('.test-selector', 'invalid-action');

        expect(mockPrepare).not.toHaveBeenCalled();
      });
    });

    describe('retrieve selectors', () => {
      it('should get selectors with minimum count', () => {
        const mockResults = [
          {selector: '.main-content', keep_count: 5, delete_count: 0, last_seen: '2023-12-01T10:00:00Z'}
        ];
        mockAll.mockReturnValue(mockResults);

        const result = selectorDB.getSelectors(3);

        expect(mockAll).toHaveBeenCalledWith(3, 3);
        expect(result).toEqual(mockResults);
      });

      it('should get action recommendation for selector', () => {
        mockGet.mockReturnValue({keep_count: 18, delete_count: 2}); // 90% keep

        const result = selectorDB.getActionForSelector('.mostly-keep');

        expect(result.action).toBe('keep');
        expect(result.keep_count).toBe(18);
        expect(result.delete_count).toBe(2);
      });

      it('should return ambiguous for low count selectors', () => {
        mockGet.mockReturnValue({keep_count: 3, delete_count: 2}); // Total: 5 < 10

        const result = selectorDB.getActionForSelector('.low-count');

        expect(result.action).toBe('ambiguous');
      });

      it('should return null for non-existent selector', () => {
        mockGet.mockReturnValue(null);

        const result = selectorDB.getActionForSelector('.non-existent');

        expect(result).toBe(null);
      });
    });
  });

  describe('ProgressService', () => {
    let progressService;
    let mockConsole;

    beforeEach(() => {
      mockConsole = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        clear: vi.spyOn(console, 'clear').mockImplementation(() => {})
      };

      Object.defineProperty(process.stdout, 'columns', {
        value: 80,
        writable: true
      });

      progressService = new ProgressService();
    });

    afterEach(() => {
      if (progressService && progressService.isActive) {
        progressService.stop();
      }
      vi.restoreAllMocks();
    });

    describe('initialization', () => {
      it('should initialize with default options', () => {
        const service = new ProgressService();

        expect(service.options).toEqual({});
        expect(service.isActive).toBe(false);
        expect(service.stats.totalUrls).toBe(0);
        expect(service.stats.crawledUrls).toBe(0);
      });

      it('should initialize with custom options', () => {
        const options = {
          figletFont: 'Standard',
          updateFrequency: 1000
        };
        const service = new ProgressService(options);

        expect(service.options).toEqual(options);
        expect(service.figletOptions.font).toBe('Standard');
      });

      it('should initialize stats structure correctly', () => {
        const service = new ProgressService();

        expect(service.stats).toMatchObject({
          totalUrls: 0,
          crawledUrls: 0,
          assets: expect.objectContaining({
            total: 0,
            images: 0,
            documents: 0,
            other: 0
          }),
          errors: expect.objectContaining({
            total: 0,
            retries: 0
          })
        });
      });
    });

    describe('progress tracking', () => {
      beforeEach(() => {
        progressService.start();
      });

      it('should start progress display', () => {
        expect(progressService.isActive).toBe(true);
        expect(progressService.stats.startTime).toBeDefined();
        expect(mockConsole.clear).toHaveBeenCalled();
      });

      it('should update stats', () => {
        const newStats = {
          totalUrls: 100,
          crawledUrls: 25,
          assets: {total: 50, images: 30}
        };

        progressService.updateStats(newStats);

        expect(progressService.stats.totalUrls).toBe(100);
        expect(progressService.stats.crawledUrls).toBe(25);
        expect(progressService.stats.assets.total).toBe(50);
        expect(progressService.stats.assets.images).toBe(30);
      });

      it('should track active URLs', () => {
        const url = 'https://example.com/page1';

        progressService.addActiveUrl(url);

        expect(progressService.activeDownloads.has(url)).toBe(true);
        expect(progressService.stats.currentUrls).toContain(url);
      });

      it('should complete URLs with different statuses', () => {
        const url = 'https://example.com/page1';
        progressService.addActiveUrl(url);

        progressService.completeUrl(url, 'success');

        expect(progressService.stats.crawledUrls).toBe(1);
        expect(progressService.stats.newPages).toBe(1);
        expect(progressService.activeDownloads.has(url)).toBe(false);
      });

      it('should track AI enhancement progress', () => {
        progressService.trackAIEnhancement('https://example.com/page1', 'success');
        progressService.trackAIEnhancement('https://example.com/page2', 'rate_limited');
        progressService.trackAIEnhancement('https://example.com/page3', 'failed');

        expect(progressService.stats.aiEnhanced).toBe(1);
        expect(progressService.stats.aiRateLimited).toBe(1);
        expect(progressService.stats.aiFailed).toBe(1);
      });

      it('should calculate AI progress percentage', () => {
        progressService.stats.crawledUrls = 100;
        progressService.stats.aiEnhanced = 30;
        progressService.stats.aiRateLimited = 10;
        progressService.stats.aiFailed = 5;

        const progress = progressService.getAIProgress();

        expect(progress).toBe(45); // (30 + 10 + 5) / 100 * 100
      });
    });

    describe('URL formatting and time calculations', () => {
      it('should format URLs for display', () => {
        const formatted = progressService.formatUrl('https://example.com/path/to/page');
        expect(formatted).toBe('/path/to/page');

        const truncated = progressService.formatUrl('https://example.com/very/long/path/that/exceeds/character/limit');
        expect(truncated).toMatch(/^\.\.\..*$/);
      });

      it('should calculate elapsed time', () => {
        progressService.stats.startTime = Date.now() - 90000; // 1.5 minutes ago

        const timeInfo = progressService.calculateTimeInfo();

        expect(timeInfo.elapsed).toMatch(/1m \d+s/);
      });

      it('should estimate remaining time', () => {
        progressService.stats.startTime = Date.now() - 60000; // 1 minute ago
        progressService.stats.totalUrls = 100;
        progressService.stats.crawledUrls = 25; // 25% complete

        const timeInfo = progressService.calculateTimeInfo();

        expect(timeInfo.remaining).toMatch(/\d+m \d+s/);
      });
    });

    describe('completion and display', () => {
      it('should stop progress display', () => {
        progressService.start();
        progressService.stop();

        expect(progressService.isActive).toBe(false);
        expect(progressService.multibar).toBe(null);
      });

      it('should display completion message', () => {
        progressService.stats.crawledUrls = 50;
        progressService.displayCompletionMessage();

        expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('New crawl completed'));
      });

      it('should render summary with statistics', () => {
        progressService.stats.startTime = Date.now() - 60000;
        progressService.stats.crawledUrls = 50;
        progressService.stats.totalUrls = 100;
        progressService.stats.assets.total = 200;

        progressService.renderSummary();

        expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('[BOXED]'));
      });
    });
  });
});
