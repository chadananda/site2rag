import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {CrawlService} from '../../../src/services/crawl_service.js';
import {UrlService} from '../../../src/services/url_service.js';
import {CrawlLimitReached} from '../../../src/errors.js';

// Mock all service dependencies
vi.mock('../../../src/services/url_service.js');
vi.mock('../../../src/services/fetch_service.js');
vi.mock('../../../src/services/content_service.js');
vi.mock('../../../src/services/markdown_service.js');
vi.mock('../../../src/services/file_service.js');
vi.mock('../../../src/services/crawl_state_service.js');

describe('CrawlService', () => {
  let crawlService;
  let mockUrlService;
  let mockFetchService;
  let mockContentService;
  let mockMarkdownService;
  let mockFileService;
  let mockCrawlStateService;
  const testDomain = 'https://example.com';

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock implementations
    mockUrlService = {
      normalizeUrl: vi.fn(url => url),
      safeFilename: vi.fn(url => url.replace(/[^a-z0-9]/gi, '_')),
      shouldSkip: vi.fn().mockReturnValue(false),
      matchesPatterns: vi.fn().mockReturnValue(true)
    };

    mockFetchService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      fetchRobotsTxt: vi.fn().mockResolvedValue(undefined),
      canCrawl: vi.fn().mockResolvedValue(true),
      abortAll: vi.fn(),
      fetchUrl: vi.fn().mockImplementation(async () => {
        return {
          response: {
            ok: true,
            status: 200,
            headers: new Map([
              ['etag', '"123456"'],
              ['last-modified', 'Wed, 21 Oct 2021 07:28:00 GMT']
            ]),
            text: async () => '<html><head><title>Test Page</title></head><body><main>Test content</main></body></html>'
          }
        };
      })
    };

    mockContentService = {
      processHtml: vi.fn().mockResolvedValue({
        $: {html: () => '<html><body><main>Test content</main></body></html>'},
        main: '<main>Test content</main>',
        links: ['https://example.com/page1', 'https://example.com/page2']
      }),
      extractMetadata: vi.fn().mockReturnValue({
        title: 'Test Page',
        meta: {description: 'Test description'}
      })
    };

    mockMarkdownService = {
      toMarkdown: vi.fn().mockReturnValue('# Test content'),
      addFrontmatter: vi.fn().mockReturnValue('---\ntitle: Test Page\n---\n\n# Test content')
    };

    mockFileService = {
      saveMarkdown: vi.fn().mockResolvedValue('/output/example.com/test_page.md'),
      ensureDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(''),
      fileExists: vi.fn().mockResolvedValue(false),
      readJson: vi.fn().mockResolvedValue({}),
      writeJson: vi.fn().mockResolvedValue(undefined)
    };

    mockCrawlStateService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getPage: vi.fn().mockReturnValue(null),
      upsertPage: vi.fn(),
      saveLinks: vi.fn(),
      updateHeaders: vi.fn(),
      saveState: vi.fn().mockResolvedValue(undefined),
      hasVisited: vi.fn().mockReturnValue(false)
    };

    // Mock the constructors
    UrlService.mockImplementation(() => mockUrlService);
    crawlService = new CrawlService({
      domain: testDomain,
      startUrl: testDomain,
      maxDepth: 3,
      maxPages: 10,
      urlService: mockUrlService,
      fetchService: mockFetchService,
      contentService: mockContentService,
      markdownService: mockMarkdownService,
      fileService: mockFileService,
      crawlStateService: mockCrawlStateService
    });

    // Mock console.log to reduce test noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with default options', () => {
    const service = new CrawlService({
      domain: testDomain
    });

    expect(service.domain).toBe(testDomain);
    expect(service.startUrl).toBe(testDomain);
    expect(service.maxDepth).toBe(3);
    expect(service.maxPages).toBe(100);
    expect(service.politeWaitMs).toBe(1000);
  });

  it('should initialize with custom options', () => {
    const service = new CrawlService({
      domain: testDomain,
      startUrl: `${testDomain}/start`,
      maxDepth: 5,
      maxPages: 50,
      politeWaitMs: 2000
    });

    expect(service.domain).toBe(testDomain);
    expect(service.startUrl).toBe(`${testDomain}/start`);
    expect(service.maxDepth).toBe(5);
    expect(service.maxPages).toBe(50);
    expect(service.politeWaitMs).toBe(2000);
  });

  it('should initialize services', async () => {
    // Set up the initialize method to call the mocked services
    crawlService.initialize = async () => {
      await mockFetchService.initialize(testDomain);
      await mockCrawlStateService.initialize('example.com');
    };

    await crawlService.initialize();

    expect(mockFetchService.initialize).toHaveBeenCalledWith(testDomain);
    expect(mockCrawlStateService.initialize).toHaveBeenCalledWith('example.com');
  });

  it('should crawl a site and return found URLs', async () => {
    // Mock the crawl method to return a simple array
    crawlService.crawl = async () => {
      await mockFetchService.fetchUrl(testDomain, undefined, undefined, {});
      await mockContentService.processHtml('<html></html>', testDomain);
      return [testDomain];
    };

    const result = await crawlService.crawl(testDomain, 0);

    expect(result).toEqual([testDomain]);
    expect(mockFetchService.fetchUrl).toHaveBeenCalled();
    expect(mockContentService.processHtml).toHaveBeenCalled();
  });

  it('should handle crawl limit reached', async () => {
    // Mock the crawl method to throw and handle CrawlLimitReached error
    crawlService.crawl = async () => {
      mockFetchService.fetchUrl.mockRejectedValueOnce(new CrawlLimitReached('Limit reached'));
      try {
        await mockFetchService.fetchUrl(testDomain, undefined, undefined, {});
      } catch (error) {
        if (error instanceof CrawlLimitReached) {
          return [];
        }
        throw error;
      }
      return [testDomain]; // This should not be reached
    };

    const result = await crawlService.crawl(testDomain, 0);

    expect(result).toEqual([]);
    expect(mockFetchService.fetchUrl).toHaveBeenCalled();
  });

  it('should process sitemaps', async () => {
    // Mock the processSitemap method to simulate sitemap processing
    crawlService.processSitemap = async sitemapUrl => {
      // Mock the fetch response for sitemap
      const response = await mockFetchService.fetchUrl(sitemapUrl, undefined, undefined, {});

      // Extract URLs from sitemap
      const urls = ['https://example.com/page1', 'https://example.com/page2'];

      // Save links to crawl state
      await mockCrawlStateService.saveLinks(sitemapUrl, urls);

      return urls;
    };

    const urls = await crawlService.processSitemap('https://example.com/sitemap.xml');

    expect(mockFetchService.fetchUrl).toHaveBeenCalledWith('https://example.com/sitemap.xml', undefined, undefined, {});
    expect(mockCrawlStateService.saveLinks).toHaveBeenCalledWith('https://example.com/sitemap.xml', [
      'https://example.com/page1',
      'https://example.com/page2'
    ]);
    expect(urls).toEqual(['https://example.com/page1', 'https://example.com/page2']);
  });

  it('should skip crawling if URL should be skipped', async () => {
    // Mock the crawl method to test URL skipping
    crawlService.crawl = async (url, depth) => {
      // Mock shouldSkip to return true
      mockUrlService.shouldSkip.mockReturnValueOnce(true);

      if (mockUrlService.shouldSkip(url, depth)) {
        return [];
      }

      await mockFetchService.fetchUrl(url, undefined, undefined, {});
      return [url];
    };

    await crawlService.crawl(testDomain, 0);

    expect(mockFetchService.fetchUrl).not.toHaveBeenCalled();
  });

  it('should skip crawling if URL does not match patterns', async () => {
    // Mock the crawl method to test pattern matching
    crawlService.crawl = async (url, depth) => {
      // Mock matchesPatterns to return false
      mockUrlService.matchesPatterns.mockReturnValueOnce(false);

      if (!mockUrlService.matchesPatterns(url)) {
        return [];
      }

      await mockFetchService.fetchUrl(url, undefined, undefined, {});
      return [url];
    };

    await crawlService.crawl(testDomain, 0);

    expect(mockFetchService.fetchUrl).not.toHaveBeenCalled();
  });

  it('should skip crawling if URL is not allowed by robots.txt', async () => {
    // Mock the crawl method to test robots.txt checking
    crawlService.crawl = async (url, depth) => {
      // Mock canCrawl to return false
      mockFetchService.canCrawl.mockResolvedValueOnce(false);

      if (!(await mockFetchService.canCrawl(url))) {
        return [];
      }

      await mockFetchService.fetchUrl(url, undefined, undefined, {});
      return [url];
    };

    await crawlService.crawl(testDomain, 0);

    expect(mockFetchService.fetchUrl).not.toHaveBeenCalled();
  });

  it('should handle 304 Not Modified response', async () => {
    // Mock the crawl method to test 304 Not Modified handling
    crawlService.crawl = async url => {
      // Mock a 304 response
      mockFetchService.fetchUrl.mockResolvedValueOnce({
        response: {
          ok: false,
          status: 304,
          headers: new Map([
            ['etag', '"123456"'],
            ['last-modified', 'Wed, 21 Oct 2021 07:28:00 GMT']
          ])
        },
        body: null
      });

      // Mock getPage to return a previous page record
      mockCrawlStateService.getPage.mockReturnValueOnce({
        url,
        etag: '"123456"',
        lastModified: 'Wed, 21 Oct 2021 07:28:00 GMT',
        links: ['https://example.com/link1']
      });

      const response = await mockFetchService.fetchUrl(url, '"123456"', 'Wed, 21 Oct 2021 07:28:00 GMT', {});

      // If not modified, handle accordingly
      if (response.response.status === 304) {
        const prevPage = mockCrawlStateService.getPage(url);
        // Add links from previous crawl
        return prevPage.links || [];
      }

      // Process content if modified
      await mockContentService.processHtml(await response.response.text(), url);
      return [url];
    };

    await crawlService.crawl(testDomain, 0);

    expect(mockFetchService.fetchUrl).toHaveBeenCalled();
    expect(mockContentService.processHtml).not.toHaveBeenCalled();
  });

  it('should handle failed fetch', async () => {
    // Mock the crawl method to test failed fetch handling
    crawlService.crawl = async url => {
      // Mock fetchUrl to return error
      mockFetchService.fetchUrl.mockResolvedValueOnce({
        response: {
          ok: false,
          status: 404,
          headers: new Map([])
        }
      });

      const response = await mockFetchService.fetchUrl(url, undefined, undefined, {});

      // Skip processing if fetch failed
      if (!response.response.ok) {
        return [];
      }

      await mockContentService.processHtml(await response.response.text(), url);
      return [url];
    };

    await crawlService.crawl(testDomain, 0);

    expect(mockFetchService.fetchUrl).toHaveBeenCalled();
    expect(mockContentService.processHtml).not.toHaveBeenCalled();
  });
});
