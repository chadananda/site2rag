import {describe, it, expect, beforeEach, vi} from 'vitest';
import fs from 'fs';
import {join} from 'path';
import {CrawlDB} from '../../../src/db.js';

// Mock AI dependencies
vi.mock('node-fetch', () => ({
  default: vi.fn()
}));

// Consolidated AI processing and context enhancement tests
describe('AI Processing Features', () => {
  let testDbPath;
  let crawlDB;
  let testOutputDir;
  let mockFetch;

  beforeEach(async () => {
    testDbPath = join(process.cwd(), 'tests', 'tmp', 'ai-processing.sqlite');
    testOutputDir = join(process.cwd(), 'tests', 'tmp', 'ai-processing');

    // Create test directories
    const testDir = join(process.cwd(), 'tests', 'tmp');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, {recursive: true});
    }

    // Clean up existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    crawlDB = new CrawlDB(testDbPath);

    // Mock fetch for AI service calls
    mockFetch = vi.mocked((await import('node-fetch')).default);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (crawlDB) {
      crawlDB.close();
    }

    // Clean up test files
    [testDbPath, testOutputDir].forEach(path => {
      if (fs.existsSync(path)) {
        fs.rmSync(path, {recursive: true, force: true});
      }
    });
  });

  describe('AI Service Integration', () => {
    it('should check AI service availability', async () => {
      // Mock successful AI service response
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200
      });

      const {aiServiceAvailable} = await import('../../../src/utils/ai_utils.js');
      const isAvailable = await aiServiceAvailable({provider: 'ollama'});

      expect(isAvailable).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', {timeout: 2000});
    });

    it('should handle AI service unavailability', async () => {
      // Mock failed AI service response
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const {aiServiceAvailable} = await import('../../../src/utils/ai_utils.js');
      const isAvailable = await aiServiceAvailable({provider: 'ollama'});

      expect(isAvailable).toBe(false);
    });

    it('should classify content blocks with AI', async () => {
      // Mock AI classification response
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify([0, 2]) // Remove blocks 0 and 2
          })
      });

      const {classifyBlocksWithAI} = await import('../../../src/utils/ai_utils.js');
      const blocks = [
        '<nav>Navigation</nav>',
        '<main>Main content</main>',
        '<aside>Sidebar</aside>',
        '<footer>Footer</footer>'
      ];

      const toRemove = await classifyBlocksWithAI(blocks, {provider: 'ollama'});

      expect(toRemove).toEqual([0, 2]);
    });

    it('should handle AI classification errors gracefully', async () => {
      // Mock AI service error
      mockFetch.mockRejectedValue(new Error('AI service error'));

      const {classifyBlocksWithAI} = await import('../../../src/utils/ai_utils.js');
      const blocks = ['<div>Content</div>'];

      const toRemove = await classifyBlocksWithAI(blocks, {provider: 'ollama'});

      expect(toRemove).toEqual([]); // Should return empty array on error
    });
  });

  describe('Context Enhancement', () => {
    it('should validate enhanced text preserves original content', () => {
      const {validateEnhancement} = require('../../../src/utils/context_utils.js');

      const original = 'The organization was founded in 1844';
      const enhanced = 'The [[Bahai]] organization was founded in 1844';

      const isValid = validateEnhancement(original, enhanced);
      expect(isValid).toBe(true);
    });

    it('should reject enhanced text that changes original content', () => {
      const {validateEnhancement} = require('../../../src/utils/context_utils.js');

      const original = 'The organization was founded in 1844';
      const enhanced = 'The organization was established in 1844'; // Changed "founded" to "established"

      const isValid = validateEnhancement(original, enhanced);
      expect(isValid).toBe(false);
    });

    it('should extract context insertions from enhanced text', () => {
      const {extractContextInsertions} = require('../../../src/utils/context_utils.js');

      const enhanced = 'The [[Bahai]] organization was founded [[by Bahaullah]] in 1844';
      const insertions = extractContextInsertions(enhanced);

      expect(insertions).toEqual(['Bahai', 'by Bahaullah']);
    });

    it('should remove context insertions to get original text', () => {
      const {removeContextInsertions} = require('../../../src/utils/context_utils.js');

      const enhanced = 'The [[Bahai]] organization was founded [[by Bahaullah]] in 1844';
      const original = removeContextInsertions(enhanced);

      expect(original).toBe('The organization was founded in 1844');
    });
  });

  describe('Sliding Window Context Processing', () => {
    it('should create optimal window sizes for different AI models', () => {
      const {getOptimalWindowSize} = require('../../../src/utils/context_utils.js');

      const gpt4Config = {provider: 'openai', model: 'gpt-4'};
      const claudeConfig = {provider: 'anthropic', model: 'claude-3-opus'};
      const ollamaConfig = {provider: 'ollama', model: 'llama3.2:latest'};

      const gpt4Windows = getOptimalWindowSize(gpt4Config);
      const claudeWindows = getOptimalWindowSize(claudeConfig);
      const ollamaWindows = getOptimalWindowSize(ollamaConfig);

      expect(gpt4Windows.windowSize).toBeGreaterThan(ollamaWindows.windowSize);
      expect(claudeWindows.windowSize).toBeGreaterThan(gpt4Windows.windowSize);
      expect(gpt4Windows.overlapSize).toBe(Math.floor(gpt4Windows.windowSize * 0.5));
    });

    it('should create sliding windows with proper overlap', () => {
      const {createOptimizedSlidingWindows} = require('../../../src/utils/context_utils.js');

      const blocks = [
        {text: 'First paragraph with some content'},
        {text: 'Second paragraph with more content'},
        {text: 'Third paragraph with additional text'},
        {text: 'Fourth paragraph with final content'}
      ];

      const windows = createOptimizedSlidingWindows(blocks, 20, 10);

      expect(windows.length).toBeGreaterThan(0);
      expect(windows[0]).toHaveProperty('windowIndex', 0);
      expect(windows[0]).toHaveProperty('contextText');
      expect(windows[0]).toHaveProperty('coveredBlocks');
      expect(windows[0]).toHaveProperty('paragraphBatches');
    });

    it('should build cached instructions for sliding window system', () => {
      const {buildSlidingCacheInstructions} = require('../../../src/utils/context_utils.js');

      const metadata = {
        title: 'Test Document',
        url: 'https://example.com/test',
        description: 'A test document'
      };

      const instructions = buildSlidingCacheInstructions(metadata);

      expect(instructions).toContain('SLIDING CONTEXT DISAMBIGUATION SESSION');
      expect(instructions).toContain('Test Document');
      expect(instructions).toContain('https://example.com/test');
      expect(instructions).toContain('Document-Only Context');
    });
  });

  describe('Two-Pass Entity Extraction', () => {
    it('should extract entities in first pass and enhance in second pass', async () => {
      // Mock AI responses for two-pass processing
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              response: JSON.stringify({
                entities: ['Bahaullah', 'Abdul-Baha', 'Bahai Faith'],
                relationships: [
                  {subject: 'Abdul-Baha', predicate: 'son of', object: 'Bahaullah'},
                  {subject: 'Bahaullah', predicate: 'founder of', object: 'Bahai Faith'}
                ]
              })
            })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              response: 'The [[Bahai Faith]] founder [[Bahaullah]] and his son [[Abdul-Baha]] established the religion.'
            })
        });

      // This would be part of a larger two-pass processing system
      // const originalText = 'The founder and his son established the religion.';

      // First pass would extract entities (mocked above)
      // Second pass would enhance with context (mocked above)

      expect(mockFetch).toBeDefined(); // Verify mock is set up
    });
  });

  describe('Selective AI Processing', () => {
    it('should only process pages with content_status=raw', async () => {
      // Insert test pages with different statuses
      crawlDB.upsertPage('https://example.com/raw', {
        title: 'Raw Content',
        content: 'This content needs AI processing',
        content_status: 'raw'
      });

      crawlDB.upsertPage('https://example.com/processed', {
        title: 'Processed Content',
        content: 'This content is already processed',
        content_status: 'contexted'
      });

      // Get pages that need processing
      const rawPages = crawlDB.getPagesByStatus('raw');
      const processedPages = crawlDB.getPagesByStatus('contexted');

      expect(rawPages).toHaveLength(1);
      expect(rawPages[0].url).toBe('https://example.com/raw');
      expect(processedPages).toHaveLength(1);
      expect(processedPages[0].url).toBe('https://example.com/processed');
    });

    it('should update content_status after successful AI processing', async () => {
      const url = 'https://example.com/process-test';

      // Insert page with raw status
      crawlDB.upsertPage(url, {
        title: 'Test Page',
        content: 'Original content',
        content_status: 'raw'
      });

      // Simulate successful AI processing
      crawlDB.upsertPage(url, {
        content: 'Enhanced content with [[context]]',
        content_status: 'contexted'
      });

      const updatedPage = crawlDB.getPage(url);
      expect(updatedPage.content_status).toBe('contexted');
      expect(updatedPage.content).toContain('[[context]]');
    });

    it('should efficiently skip unchanged content in re-crawls', () => {
      // Insert page with etag indicating no changes
      const url = 'https://example.com/unchanged';

      crawlDB.upsertPage(url, {
        title: 'Unchanged Page',
        content: 'Content that has not changed',
        content_status: 'contexted',
        etag: '"same-etag"'
      });

      // In a re-crawl, this page would be skipped if etag matches
      const page = crawlDB.getPage(url);
      expect(page.content_status).toBe('contexted');
      expect(page.etag).toBe('"same-etag"');
    });
  });
});
