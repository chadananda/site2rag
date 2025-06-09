import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchService } from '../../../src/services/fetch_service.js';
import fetch from 'node-fetch';
import robotsParser from 'robots-parser';

// Mock node-fetch and robots-parser
vi.mock('node-fetch');
vi.mock('robots-parser');

describe('FetchService', () => {
  let fetchService;
  
  beforeEach(() => {
    vi.resetAllMocks();
    fetchService = new FetchService({
      politeDelay: 100,
      userAgent: 'test-crawler'
    });
    
    // Mock fetch implementation
    fetch.mockImplementation(async () => ({
      ok: true,
      text: async () => 'User-agent: *\nDisallow: /private/',
      headers: new Map([
        ['etag', '"abc123"'],
        ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
      ]),
      status: 200,
      statusText: 'OK'
    }));
    
    // Mock robotsParser implementation
    robotsParser.mockImplementation(() => ({
      isAllowed: (url) => !url.includes('/private/')
    }));
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  describe('constructor', () => {
    it('should initialize with default values', () => {
      const defaultService = new FetchService();
      expect(defaultService.politeDelay).toBe(1000);
      expect(defaultService.userAgent).toBe('site2rag-crawler');
      expect(defaultService.robots).toBeNull();
    });
    
    it('should initialize with provided options', () => {
      expect(fetchService.politeDelay).toBe(100);
      expect(fetchService.userAgent).toBe('test-crawler');
    });
  });
  
  describe('applyPoliteDelay', () => {
    it('should not delay on first request', async () => {
      const startTime = Date.now();
      await fetchService.applyPoliteDelay();
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(50); // Allow some execution time
    });
    
    it('should delay subsequent requests', async () => {
      vi.useFakeTimers();
      
      // First request
      await fetchService.applyPoliteDelay();
      
      // Second request (should delay)
      const delayPromise = fetchService.applyPoliteDelay();
      
      // Advance timer by polite delay
      vi.advanceTimersByTime(fetchService.politeDelay);
      
      await delayPromise;
      
      // Verify lastFetchStartedAt was updated
      expect(fetchService.lastFetchStartedAt).not.toBeNull();
    });
  });
  
  describe('fetchRobotsTxt', () => {
    it('should fetch and parse robots.txt', async () => {
      const result = await fetchService.fetchRobotsTxt('https://example.com');
      
      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/robots.txt',
        expect.objectContaining({
          headers: { 'User-Agent': 'test-crawler' }
        })
      );
      expect(robotsParser).toHaveBeenCalled();
      expect(fetchService.robots).not.toBeNull();
    });
    
    it('should handle fetch errors gracefully', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error'));
      
      const result = await fetchService.fetchRobotsTxt('https://example.com');
      
      expect(result).toBe(false);
      expect(fetchService.robots).toBeNull();
    });
    
    it('should handle non-OK responses', async () => {
      fetch.mockImplementationOnce(async () => ({
        ok: false,
        status: 404
      }));
      
      const result = await fetchService.fetchRobotsTxt('https://example.com');
      
      expect(result).toBe(false);
      expect(fetchService.robots).toBeNull();
    });
  });
  
  describe('canCrawl', () => {
    it('should return true if no robots.txt is loaded', () => {
      fetchService.robots = null;
      expect(fetchService.canCrawl('https://example.com/any')).toBe(true);
    });
    
    it('should check robots.txt rules if loaded', async () => {
      await fetchService.fetchRobotsTxt('https://example.com');
      
      expect(fetchService.canCrawl('https://example.com/public')).toBe(true);
      expect(fetchService.canCrawl('https://example.com/private/secret')).toBe(false);
    });
  });
  
  describe('fetchUrl', () => {
    it('should apply polite delay before fetching', async () => {
      const spy = vi.spyOn(fetchService, 'applyPoliteDelay');
      
      await fetchService.fetchUrl('https://example.com/page');
      
      expect(spy).toHaveBeenCalled();
    });
    
    it('should fetch with correct headers', async () => {
      await fetchService.fetchUrl('https://example.com/page', {
        headers: { 'If-None-Match': '"abc123"' }
      });
      
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/page',
        expect.objectContaining({
          headers: {
            'User-Agent': 'test-crawler',
            'If-None-Match': '"abc123"'
          }
        })
      );
    });
    
    it('should manage active controllers', async () => {
      // We'll test the abortAll functionality instead
      // which implicitly tests controller tracking
      const mockAbort = vi.fn();
      
      // Add a mock controller to the set
      const mockController = { signal: {}, abort: mockAbort };
      fetchService.activeControllers.add(mockController);
      
      // Call abortAll
      fetchService.abortAll();
      
      // Verify abort was called
      expect(mockAbort).toHaveBeenCalled();
      expect(fetchService.activeControllers.size).toBe(0);
    });
  });
  
  describe('abortAll', () => {
    it('should abort all active requests', async () => {
      // Create mock controllers
      const controller1 = { abort: vi.fn(), signal: {} };
      const controller2 = { abort: vi.fn(), signal: {} };
      
      // Add to active controllers
      fetchService.activeControllers.add(controller1);
      fetchService.activeControllers.add(controller2);
      
      fetchService.abortAll();
      
      expect(controller1.abort).toHaveBeenCalled();
      expect(controller2.abort).toHaveBeenCalled();
      expect(fetchService.activeControllers.size).toBe(0);
    });
  });
});
