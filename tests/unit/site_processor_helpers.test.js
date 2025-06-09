import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePreviousCrawl, handleNotModified, updateCrawlState } from '../../src/site_processor_helpers.js';

describe('Site Processor Helper Functions', () => {
  let mockCrawlState;
  let visited;
  let found;
  
  beforeEach(() => {
    // Mock crawlState methods
    mockCrawlState = {
      getPage: vi.fn(),
      upsertPage: vi.fn(),
      saveLinks: vi.fn()
    };
    
    // Mock visited and found sets
    visited = new Set();
    found = [];
  });
  
  describe('handlePreviousCrawl', () => {
    it('should return empty headers if no previous crawl exists', async () => {
      mockCrawlState.getPage.mockReturnValue(null);
      const result = await handlePreviousCrawl(mockCrawlState, 'https://example.com/page');
      expect(result).toEqual({ headers: {} });
    });
    
    it('should return headers with If-None-Match if etag exists', async () => {
      mockCrawlState.getPage.mockReturnValue({ etag: '"123456"' });
      const result = await handlePreviousCrawl(mockCrawlState, 'https://example.com/page');
      expect(result).toEqual({
        headers: { 'If-None-Match': '"123456"' }
      });
    });
    
    it('should return headers with If-Modified-Since if lastModified exists', async () => {
      mockCrawlState.getPage.mockReturnValue({ lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' });
      const result = await handlePreviousCrawl(mockCrawlState, 'https://example.com/page');
      expect(result).toEqual({
        headers: { 'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT' }
      });
    });
  });
  
  describe('handleNotModified', () => {
    it('should update visited and found lists', async () => {
      const prevData = { 
        links: ['https://example.com/link1', 'https://example.com/link2']
      };
      
      await handleNotModified('https://example.com/page', prevData, visited, found);
      
      expect(visited.has('https://example.com/page')).toBe(true);
      expect(found).toContain('https://example.com/link1');
      expect(found).toContain('https://example.com/link2');
    });
    
    it('should handle missing links in prevData', async () => {
      const prevData = {};
      
      await handleNotModified('https://example.com/page', prevData, visited, found);
      
      expect(visited.has('https://example.com/page')).toBe(true);
      expect(found).toHaveLength(0);
    });
  });
  
  describe('updateCrawlState', () => {
    it('should call crawlState.upsertPage with correct parameters', async () => {
      const response = {
        headers: {
          get: (header) => {
            if (header === 'etag') return '"abc123"';
            if (header === 'last-modified') return 'Wed, 21 Oct 2015 07:28:00 GMT';
            return null;
          }
        }
      };
      
      const links = ['https://example.com/link1', 'https://example.com/link2'];
      
      await updateCrawlState('https://example.com/page', response, links, mockCrawlState);
      
      expect(mockCrawlState.upsertPage).toHaveBeenCalledWith(
        'https://example.com/page',
        expect.objectContaining({
          etag: '"abc123"',
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          links: ['https://example.com/link1', 'https://example.com/link2'],
          lastCrawled: expect.any(String)
        })
      );
    });
    
    it('should handle missing headers', async () => {
      const response = {
        headers: {
          get: () => null
        }
      };
      
      const links = [];
      
      await updateCrawlState('https://example.com/page', response, links, mockCrawlState);
      
      expect(mockCrawlState.upsertPage).toHaveBeenCalledWith(
        'https://example.com/page',
        expect.objectContaining({
          links: [],
          lastCrawled: expect.any(String)
        })
      );
    });
  });
});
