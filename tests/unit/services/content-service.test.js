import {describe, it, expect, vi, beforeEach} from 'vitest';
import {ContentService} from '../../../src/services/content_service.js';
import {aiServiceAvailable, classifyBlocksWithAI} from '../../../src/utils/ai_utils.js';

// Mock the AI utils functions
vi.mock('../../../src/utils/ai_utils.js', () => ({
  aiServiceAvailable: vi.fn(),
  classifyBlocksWithAI: vi.fn()
}));

describe('ContentService', () => {
  let contentService;
  const mockHtml = `
    <html>
      <head>
        <title>Test Page</title>
        <meta name="description" content="Test description">
        <meta property="og:title" content="OG Test Title">
        <link rel="canonical" href="https://example.com/canonical">
      </head>
      <body>
        <main>
          <div id="block1">Main content</div>
          <div id="block2">Important info</div>
          <div id="block3">Navigation menu</div>
          <div id="block4">Footer content</div>
          <div id="block5">Copyright notice</div>
          <a href="/relative-link">Relative Link</a>
          <a href="https://example.com/absolute-link">Absolute Link</a>
          <a href="https://external.com/external-link">External Link</a>
        </main>
      </body>
    </html>
  `;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create service instance
    contentService = new ContentService({
      aiConfig: {
        provider: 'test-provider',
        model: 'test-model'
      }
    });

    // Default mock implementations
    aiServiceAvailable.mockResolvedValue(false);
    classifyBlocksWithAI.mockResolvedValue([]);
  });

  describe('processHtml', () => {
    it('should extract main content and links', async () => {
      const result = await contentService.processHtml(mockHtml, 'https://example.com/page');

      expect(result.$).toBeDefined();
      expect(result.main).toBeDefined();
      expect(result.links).toBeInstanceOf(Array);

      // Should find 2 links from the same domain
      expect(result.links).toHaveLength(2);
      expect(result.links).toContain('https://example.com/relative-link');
      expect(result.links).toContain('https://example.com/absolute-link');
      expect(result.links).not.toContain('https://external.com/external-link');
    });

    it('should use body if no main content is found', async () => {
      const simpleHtml = '<html><body><p>Content</p></body></html>';
      const result = await contentService.processHtml(simpleHtml, 'https://example.com/page');

      expect(result.main.prop('tagName').toLowerCase()).toBe('body');
    });

    it('should apply block classification if AI is available', async () => {
      // Mock AI as available
      aiServiceAvailable.mockResolvedValue(true);

      // Mock classification to remove blocks 1 and 3 (0-indexed)
      // This corresponds to block2 and block4 in the HTML (1-indexed)
      classifyBlocksWithAI.mockResolvedValue([1, 3]);

      const result = await contentService.processHtml(mockHtml, 'https://example.com/page');

      // Verify AI functions were called
      expect(aiServiceAvailable).toHaveBeenCalledWith(contentService.aiConfig);
      expect(classifyBlocksWithAI).toHaveBeenCalled();

      // Verify blocks were removed (should have 3 left instead of 5)
      const blocks = result.main.children('div');
      expect(blocks).toHaveLength(3);

      // Verify the right blocks remain
      const remainingIds = [];
      blocks.each((_, el) => {
        remainingIds.push(result.$(el).attr('id'));
      });

      // Since we removed indices 1 and 3 (block2 and block4), we should have block1, block3, and block5 remaining
      expect(remainingIds).toContain('block1');
      expect(remainingIds).toContain('block3');
      expect(remainingIds).toContain('block5');
      expect(remainingIds).not.toContain('block2');
      expect(remainingIds).not.toContain('block4');
    });
  });

  describe('extractMetadata', () => {
    it('should extract title and meta tags', async () => {
      const {$} = await contentService.processHtml(mockHtml, 'https://example.com/page');
      const {title, meta} = contentService.extractMetadata($);

      expect(title).toBe('Test Page');
      expect(meta.description).toBe('Test description');
      expect(meta.og_title).toBe('OG Test Title');
      expect(meta.canonical).toBe('https://example.com/canonical');
    });

    it('should handle missing metadata', async () => {
      const simpleHtml = '<html><body><p>Content</p></body></html>';
      const {$} = await contentService.processHtml(simpleHtml, 'https://example.com/page');
      const {title, meta} = contentService.extractMetadata($);

      expect(title).toBeUndefined();
      expect(meta).toEqual({});
    });
  });

  describe('extractLinks', () => {
    it('should extract and normalize links', async () => {
      const {$} = await contentService.processHtml(mockHtml, 'https://example.com/page');
      const links = contentService.extractLinks($, $('main'), 'https://example.com/page');

      expect(links).toHaveLength(2);
      expect(links).toContain('https://example.com/relative-link');
      expect(links).toContain('https://example.com/absolute-link');
    });

    it('should filter out external links', async () => {
      const {$} = await contentService.processHtml(mockHtml, 'https://example.com/page');
      const links = contentService.extractLinks($, $('main'), 'https://example.com/page');

      expect(links).not.toContain('https://external.com/external-link');
    });

    it('should handle invalid links', async () => {
      const badHtml = '<html><body><a href=":::invalid:::">Bad Link</a></body></html>';
      const {$} = await contentService.processHtml(badHtml, 'https://example.com/page');
      const links = contentService.extractLinks($, $('body'), 'https://example.com/page');

      expect(links).toHaveLength(0);
    });
  });
});
