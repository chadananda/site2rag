import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlStateService } from '../../../src/services/crawl_state_service.js';
import { FileService } from '../../../src/services/file_service.js';
import path from 'path';

// Create mock FileService functions
const mockEnsureDir = vi.fn().mockResolvedValue(undefined);
const mockReadJson = vi.fn().mockResolvedValue({ pages: {} });
const mockWriteJson = vi.fn().mockResolvedValue(undefined);
const mockFileExists = vi.fn().mockResolvedValue(false);
const mockGetOutputPath = vi.fn().mockImplementation((domain, filename) => `./test-output/${domain}/${filename}`);

// Mock FileService
vi.mock('../../../src/services/file_service.js', () => {
  return {
    FileService: vi.fn().mockImplementation(() => ({
      ensureDir: mockEnsureDir,
      readJson: mockReadJson,
      writeJson: mockWriteJson,
      fileExists: mockFileExists,
      getOutputPath: mockGetOutputPath
    }))
  };
});

// Mock path module
vi.mock('path');

// Setup path mock implementation
const mockPathJoin = vi.fn((...args) => {
  // Always ensure paths start with './' for test compatibility
  const joined = args.join('/');
  return joined.startsWith('./') ? joined : './' + joined;
});

// Set the mock implementations
path.join = mockPathJoin;

describe('CrawlStateService', () => {
  let crawlStateService;
  let mockFileService;
  
  beforeEach(() => {
    vi.resetAllMocks();
    
    // Reset all mock functions
    mockEnsureDir.mockClear();
    mockReadJson.mockClear();
    mockWriteJson.mockClear();
    mockFileExists.mockClear();
    mockGetOutputPath.mockClear();
    
    // Create mock FileService instance
    mockFileService = {
      ensureDir: mockEnsureDir,
      readJson: mockReadJson,
      writeJson: mockWriteJson,
      fileExists: mockFileExists,
      getOutputPath: mockGetOutputPath
    };
    
    // Create service instance with the mocked FileService
    crawlStateService = new CrawlStateService({
      outputDir: './test-output',
      fileService: mockFileService
    });
  });
  
  describe('constructor', () => {
    it('should initialize with default values', () => {
      const defaultService = new CrawlStateService();
      expect(defaultService.outputDir).toBe('./output');
      expect(defaultService.stateDir).toBe('./output/.crawl_state');
      expect(defaultService.fileService).toBeInstanceOf(FileService);
      expect(defaultService.pages).toBeInstanceOf(Map);
      expect(defaultService.visited).toBeInstanceOf(Set);
      expect(defaultService.stateLoaded).toBe(false);
    });
    
    it('should initialize with provided options', () => {
      expect(crawlStateService.outputDir).toBe('./test-output');
      expect(crawlStateService.stateDir).toBe('./test-output/.crawl_state');
      expect(crawlStateService.fileService).toBe(mockFileService);
    });
  });
  
  describe('initialize', () => {
    it('should create state directory and load state', async () => {
      await crawlStateService.initialize('example.com');
      
      expect(mockEnsureDir).toHaveBeenCalledWith('./test-output/.crawl_state');
      expect(crawlStateService.stateLoaded).toBe(true);
      expect(crawlStateService.visited.size).toBe(0);
    });
  });
  
  describe('loadState', () => {
    it('should load state from file if it exists', async () => {
      // Mock file exists
      mockFileExists.mockResolvedValueOnce(true);
      
      // Mock state data
      const mockState = {
        domain: 'example.com',
        lastCrawled: '2023-01-01T00:00:00.000Z',
        pages: {
          'https://example.com': { etag: 'abc123', lastModified: 'Wed, 01 Jan 2023 00:00:00 GMT' },
          'https://example.com/page': { etag: 'def456', lastModified: 'Thu, 02 Jan 2023 00:00:00 GMT' }
        }
      };
      mockReadJson.mockResolvedValueOnce(mockState);
      
      await crawlStateService.loadState('example.com');
      
      expect(mockFileExists).toHaveBeenCalledWith('./test-output/.crawl_state/example_com.json');
      expect(mockReadJson).toHaveBeenCalledWith('./test-output/.crawl_state/example_com.json', { pages: {} });
      
      // Check that pages were loaded into Map
      expect(crawlStateService.pages.size).toBe(2);
      expect(crawlStateService.pages.get('https://example.com')).toEqual({ etag: 'abc123', lastModified: 'Wed, 01 Jan 2023 00:00:00 GMT' });
      expect(crawlStateService.pages.get('https://example.com/page')).toEqual({ etag: 'def456', lastModified: 'Thu, 02 Jan 2023 00:00:00 GMT' });
    });
    
    it('should initialize empty state if file does not exist', async () => {
      await crawlStateService.loadState('example.com');
      
      expect(mockFileExists).toHaveBeenCalled();
      expect(crawlStateService.pages).toBeInstanceOf(Map);
      expect(crawlStateService.pages.size).toBe(0);
    });
  });
  
  describe('saveState', () => {
    it('should save state to file', async () => {
      // Add some pages to state
      crawlStateService.pages.set('https://example.com/page1', { etag: 'etag1' });
      crawlStateService.pages.set('https://example.com/page2', { etag: 'etag2' });
      
      await crawlStateService.saveState('example.com');
      
      expect(mockWriteJson).toHaveBeenCalledWith(
        './test-output/.crawl_state/example_com.json',
        expect.objectContaining({
          domain: 'example.com'
        })
      );
      
      // Verify the pages data is included in the saved state
      const savedData = mockWriteJson.mock.calls[0][1];
      expect(savedData).toHaveProperty('pages');
      expect(savedData).toHaveProperty('lastCrawled');
    });
  });
  
  describe('getStateFilePath', () => {
    it('should generate correct state file path', () => {
      const filePath = crawlStateService.getStateFilePath('example.com');
      expect(filePath).toBe('./test-output/.crawl_state/example_com.json');
      
      const filePathWithSubdomain = crawlStateService.getStateFilePath('sub.example.com');
      expect(filePathWithSubdomain).toBe('./test-output/.crawl_state/sub_example_com.json');
    });
  });
  
  describe('getPage', () => {
    it('should return page data if it exists', () => {
      const pageData = { etag: 'etag1', lastModified: 'date1' };
      crawlStateService.pages.set('https://example.com/page', pageData);
      
      const result = crawlStateService.getPage('https://example.com/page');
      expect(result).toEqual(pageData);
    });
    
    it('should return null if page does not exist', () => {
      const result = crawlStateService.getPage('https://example.com/nonexistent');
      expect(result).toBeNull();
    });
  });
  
  describe('upsertPage', () => {
    it('should add new page data', () => {
      crawlStateService.upsertPage('https://example.com/page', { etag: 'etag1' });
      
      expect(crawlStateService.pages.get('https://example.com/page')).toEqual({ etag: 'etag1' });
      expect(crawlStateService.visited.has('https://example.com/page')).toBe(true);
    });
    
    it('should merge with existing page data', () => {
      // Add initial data
      crawlStateService.pages.set('https://example.com/page', { 
        etag: 'etag1', 
        lastModified: 'date1' 
      });
      
      // Update with new data
      crawlStateService.upsertPage('https://example.com/page', { 
        etag: 'etag2',
        status: 200
      });
      
      // Check merged result
      expect(crawlStateService.pages.get('https://example.com/page')).toEqual({
        etag: 'etag2',
        lastModified: 'date1',
        status: 200
      });
    });
  });
  
  describe('saveLinks', () => {
    it('should save links for a page', () => {
      const links = ['https://example.com/link1', 'https://example.com/link2'];
      
      crawlStateService.saveLinks('https://example.com/page', links);
      
      const pageData = crawlStateService.pages.get('https://example.com/page');
      expect(pageData.links).toEqual(links);
      expect(pageData.lastCrawled).toBeDefined();
    });
    
    it('should update existing page data', () => {
      // Add initial data
      crawlStateService.pages.set('https://example.com/page', { 
        etag: 'etag1'
      });
      
      const links = ['https://example.com/link1'];
      crawlStateService.saveLinks('https://example.com/page', links);
      
      const pageData = crawlStateService.pages.get('https://example.com/page');
      expect(pageData.etag).toBe('etag1');
      expect(pageData.links).toEqual(links);
    });
  });
  
  describe('hasVisited', () => {
    it('should return true for visited URLs', () => {
      crawlStateService.visited.add('https://example.com/visited');
      
      expect(crawlStateService.hasVisited('https://example.com/visited')).toBe(true);
      expect(crawlStateService.hasVisited('https://example.com/not-visited')).toBe(false);
    });
  });
  
  describe('hasChanged', () => {
    it('should return true if page has no previous data', () => {
      const response = { 
        headers: new Map([['etag', '"abc123"']]) 
      };
      
      expect(crawlStateService.hasChanged('https://example.com/new', response)).toBe(true);
    });
    
    it('should return false if ETag matches', () => {
      // Add page with ETag
      crawlStateService.pages.set('https://example.com/page', { 
        etag: '"abc123"'
      });
      
      const response = { 
        headers: new Map([['etag', '"abc123"']]) 
      };
      
      expect(crawlStateService.hasChanged('https://example.com/page', response)).toBe(false);
    });
    
    it('should return false if Last-Modified matches', () => {
      // Add page with Last-Modified
      const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';
      crawlStateService.pages.set('https://example.com/page', { 
        lastModified
      });
      
      const response = { 
        headers: new Map([['last-modified', lastModified]]) 
      };
      
      expect(crawlStateService.hasChanged('https://example.com/page', response)).toBe(false);
    });
    
    it('should return true if headers do not match', () => {
      // Add page with old ETag
      crawlStateService.pages.set('https://example.com/page', { 
        etag: '"old-etag"'
      });
      
      const response = { 
        headers: new Map([['etag', '"new-etag"']]) 
      };
      
      expect(crawlStateService.hasChanged('https://example.com/page', response)).toBe(true);
    });
  });
  
  describe('updateHeaders', () => {
    it('should update page data with response headers', () => {
      const response = { 
        headers: new Map([
          ['etag', '"abc123"'],
          ['last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT']
        ]),
        status: 200
      };
      
      crawlStateService.updateHeaders('https://example.com/page', response);
      
      const pageData = crawlStateService.pages.get('https://example.com/page');
      expect(pageData.etag).toBe('"abc123"');
      expect(pageData.lastModified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
      expect(pageData.status).toBe(200);
      expect(pageData.lastCrawled).toBeDefined();
    });
    
    it('should preserve existing data not in headers', () => {
      // Add existing data
      crawlStateService.pages.set('https://example.com/page', { 
        etag: '"old-etag"',
        customField: 'value'
      });
      
      const response = { 
        headers: new Map([['etag', '"new-etag"']]),
        status: 200
      };
      
      crawlStateService.updateHeaders('https://example.com/page', response);
      
      const pageData = crawlStateService.pages.get('https://example.com/page');
      expect(pageData.etag).toBe('"new-etag"');
      expect(pageData.customField).toBe('value');
    });
  });
  
  describe('getUrlsToCrawl', () => {
    it('should return URLs for the specified domain', () => {
      // Add pages for different domains
      crawlStateService.pages.set('https://example.com/page1', {});
      crawlStateService.pages.set('https://example.com/page2', {});
      crawlStateService.pages.set('https://other.com/page', {});
      
      const urls = crawlStateService.getUrlsToCrawl('https://example.com');
      
      expect(urls).toHaveLength(2);
      expect(urls).toContain('https://example.com/page1');
      expect(urls).toContain('https://example.com/page2');
      expect(urls).not.toContain('https://other.com/page');
    });
    
    it('should handle invalid URLs', () => {
      // Add invalid URL
      crawlStateService.pages.set('not-a-url', {});
      
      const urls = crawlStateService.getUrlsToCrawl('https://example.com');
      
      expect(urls).not.toContain('not-a-url');
    });
    
    it('should handle invalid base URL', () => {
      const urls = crawlStateService.getUrlsToCrawl('not-a-url');
      expect(urls).toEqual([]);
    });
  });
});
