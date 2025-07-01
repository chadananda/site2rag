/**
 * tests/unit/utils/progress-display.test.js - Test coverage for progress bar display fixes
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {ProgressService} from '../../../src/utils/progress.js';
import cliProgress from 'cli-progress';

// Mock cli-progress
vi.mock('cli-progress', () => {
  const mockBar = {
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(),
    setTotal: vi.fn(),
    increment: vi.fn(),
    value: 0,
    total: 0
  };

  const mockMultiBar = {
    start: vi.fn(),
    stop: vi.fn(),
    create: vi.fn(() => mockBar),
    update: vi.fn(),
    setTotal: vi.fn(),
    remove: vi.fn()
  };

  return {
    default: {
      MultiBar: vi.fn(() => mockMultiBar),
      SingleBar: vi.fn(() => mockBar),
      Presets: {
        shades_classic: {}
      }
    }
  };
});

// Mock other dependencies
vi.mock('boxen', () => ({
  default: vi.fn(content => content)
}));

vi.mock('figlet', () => ({
  default: {
    textSync: vi.fn(text => text)
  }
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({version: '1.0.0'}))
}));

describe('Progress Bar Display', () => {
  let progressService;
  let originalIsTTY;
  let mockMultiBar;
  let mockCrawlBar;
  let mockAiBar;

  beforeEach(() => {
    // Save original TTY state
    originalIsTTY = process.stdout.isTTY;
    
    // Create fresh mocks
    mockCrawlBar = {
      start: vi.fn(),
      stop: vi.fn(),
      update: vi.fn(),
      setTotal: vi.fn(),
      increment: vi.fn(),
      value: 0,
      total: 0
    };
    
    mockAiBar = {
      start: vi.fn(),
      stop: vi.fn(),
      update: vi.fn(),
      setTotal: vi.fn(),
      increment: vi.fn(),
      value: 0,
      total: 0
    };
    
    mockMultiBar = {
      start: vi.fn(),
      stop: vi.fn(),
      create: vi.fn((total, start, payload) => {
        if (payload?.name === 'AI Processing') {
          return mockAiBar;
        }
        return mockCrawlBar;
      }),
      remove: vi.fn()
    };
    
    vi.mocked(cliProgress.MultiBar).mockReturnValue(mockMultiBar);
    
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore TTY state
    process.stdout.isTTY = originalIsTTY;
    vi.restoreAllMocks();
  });

  describe('TTY Detection', () => {
    it('should detect TTY environment correctly', () => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
      expect(progressService.isTTY).toBe(true);
    });

    it('should detect non-TTY environment correctly', () => {
      process.stdout.isTTY = false;
      progressService = new ProgressService();
      expect(progressService.isTTY).toBe(false);
    });

    it('should not display progress bars in non-TTY environment', () => {
      process.stdout.isTTY = false;
      progressService = new ProgressService();
      
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      expect(mockMultiBar.create).not.toHaveBeenCalled();
    });

    it('should display progress bars in TTY environment', () => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
      
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      expect(mockMultiBar.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('Dual Progress Bars', () => {
    beforeEach(() => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
    });

    it('should create separate crawl and AI progress bars', () => {
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      expect(mockMultiBar.create).toHaveBeenCalledTimes(2);
      
      // Check crawl bar creation
      expect(mockMultiBar.create).toHaveBeenCalledWith(
        100,
        0,
        expect.objectContaining({
          name: 'Crawling'
        })
      );
      
      // Check AI bar creation
      expect(mockMultiBar.create).toHaveBeenCalledWith(
        50,
        0,
        expect.objectContaining({
          name: 'AI Processing'
        })
      );
    });

    it('should update crawl and AI bars independently', () => {
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      progressService.updateCrawl(25);
      progressService.updateAI(10);
      
      expect(mockCrawlBar.update).toHaveBeenCalledWith(25);
      expect(mockAiBar.update).toHaveBeenCalledWith(10);
    });

    it('should display correct value/total counts', () => {
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      // Update progress
      progressService.updateCrawl(25);
      progressService.updateAI(10);
      
      // Check payload updates include value/total
      expect(mockCrawlBar.update).toHaveBeenCalledWith(
        25,
        expect.objectContaining({
          value: 25,
          total: 100
        })
      );
      
      expect(mockAiBar.update).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          value: 10,
          total: 50
        })
      );
    });

    it('should handle dynamic total updates', () => {
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      // Update totals
      progressService.setTotal('crawl', 150);
      progressService.setTotal('ai', 75);
      
      expect(mockCrawlBar.setTotal).toHaveBeenCalledWith(150);
      expect(mockAiBar.setTotal).toHaveBeenCalledWith(75);
    });
  });

  describe('Progress Bar Lifecycle', () => {
    beforeEach(() => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
    });

    it('should start progress bars with correct initial values', () => {
      progressService.startCrawl(100);
      
      expect(mockCrawlBar.start).toHaveBeenCalledWith(100, 0);
    });

    it('should stop all progress bars when finished', () => {
      progressService.startCrawl(100);
      progressService.startAI(50);
      
      progressService.stop();
      
      expect(mockMultiBar.stop).toHaveBeenCalled();
    });

    it('should handle incremental updates', () => {
      progressService.startCrawl(100);
      
      progressService.incrementCrawl();
      progressService.incrementCrawl();
      progressService.incrementCrawl();
      
      expect(mockCrawlBar.increment).toHaveBeenCalledTimes(3);
    });

    it('should prevent updates after stop', () => {
      progressService.startCrawl(100);
      progressService.stop();
      
      progressService.updateCrawl(50);
      
      // Should not update after stop
      expect(mockCrawlBar.update).not.toHaveBeenCalled();
    });
  });

  describe('Progress Bar Formatting', () => {
    beforeEach(() => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
    });

    it('should format crawl progress with URL info', () => {
      progressService.startCrawl(100);
      progressService.updateCrawl(25, {
        currentUrl: 'https://example.com/page1'
      });
      
      expect(mockCrawlBar.update).toHaveBeenCalledWith(
        25,
        expect.objectContaining({
          currentUrl: 'https://example.com/page1'
        })
      );
    });

    it('should format AI progress with file info', () => {
      progressService.startAI(50);
      progressService.updateAI(10, {
        currentFile: 'page1.md'
      });
      
      expect(mockAiBar.update).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          currentFile: 'page1.md'
        })
      );
    });

    it('should show completion percentage', () => {
      progressService.startCrawl(100);
      progressService.updateCrawl(75);
      
      expect(mockCrawlBar.update).toHaveBeenCalledWith(
        75,
        expect.objectContaining({
          percentage: 75
        })
      );
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
    });

    it('should handle bar creation failures gracefully', () => {
      mockMultiBar.create.mockImplementation(() => {
        throw new Error('Bar creation failed');
      });
      
      expect(() => {
        progressService.startCrawl(100);
      }).not.toThrow();
    });

    it('should handle update failures gracefully', () => {
      progressService.startCrawl(100);
      
      mockCrawlBar.update.mockImplementation(() => {
        throw new Error('Update failed');
      });
      
      expect(() => {
        progressService.updateCrawl(50);
      }).not.toThrow();
    });

    it('should continue working after errors', () => {
      progressService.startCrawl(100);
      
      // Force an error
      mockCrawlBar.update.mockImplementationOnce(() => {
        throw new Error('Update failed');
      });
      
      progressService.updateCrawl(25);
      
      // Reset mock
      mockCrawlBar.update.mockImplementation(() => {});
      
      // Should still work
      progressService.updateCrawl(50);
      expect(mockCrawlBar.update).toHaveBeenLastCalledWith(50);
    });
  });

  describe('Integration with Crawl Process', () => {
    beforeEach(() => {
      process.stdout.isTTY = true;
      progressService = new ProgressService();
    });

    it('should track crawl progress accurately', () => {
      const urls = ['url1', 'url2', 'url3', 'url4', 'url5'];
      progressService.startCrawl(urls.length);
      
      urls.forEach((url, index) => {
        progressService.updateCrawl(index + 1, {currentUrl: url});
      });
      
      expect(mockCrawlBar.update).toHaveBeenCalledTimes(5);
      expect(mockCrawlBar.update).toHaveBeenLastCalledWith(
        5,
        expect.objectContaining({
          value: 5,
          total: 5,
          currentUrl: 'url5'
        })
      );
    });

    it('should track AI processing progress accurately', () => {
      const files = ['file1.md', 'file2.md', 'file3.md'];
      progressService.startAI(files.length);
      
      files.forEach((file, index) => {
        progressService.updateAI(index + 1, {currentFile: file});
      });
      
      expect(mockAiBar.update).toHaveBeenCalledTimes(3);
      expect(mockAiBar.update).toHaveBeenLastCalledWith(
        3,
        expect.objectContaining({
          value: 3,
          total: 3,
          currentFile: 'file3.md'
        })
      );
    });
  });
});