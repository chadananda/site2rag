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

      // Links now include all links found on the page (including external)
      expect(result.links).toHaveLength(3);
      expect(result.links).toContain('https://example.com/relative-link');
      expect(result.links).toContain('https://example.com/absolute-link');
      expect(result.links).toContain('https://external.com/external-link');
    });

    it('should use body if no main content is found', async () => {
      const simpleHtml = '<html><body><p>Content</p></body></html>';
      const result = await contentService.processHtml(simpleHtml, 'https://example.com/page');

      expect(result.main.prop('tagName').toLowerCase()).toBe('body');
    });

    // AI classification is now handled by context processors, not content service
    it.skip('should apply block classification if AI is available', async () => {
      // This functionality has been moved to context processors
    });
  });

  describe('extractMetadata', () => {
    it('should extract title and meta tags', async () => {
      const {$} = await contentService.processHtml(mockHtml, 'https://example.com/page');
      const metadata = contentService.extractMetadata($);

      expect(metadata.title).toBe('Test Page');
      expect(metadata.description).toBe('Test description');
      // Note: og_title becomes title, canonical becomes url in new implementation
      expect(metadata.url).toBe('https://example.com/canonical');
    });

    it('should handle missing metadata', async () => {
      const simpleHtml = '<html><body><p>Content</p></body></html>';
      const {$} = await contentService.processHtml(simpleHtml, 'https://example.com/page');
      const metadata = contentService.extractMetadata($);

      // New implementation returns an object with empty fields removed
      expect(metadata.title).toBeUndefined();
      expect(Object.keys(metadata).length).toBeGreaterThan(0); // Has language field at minimum
    });
  });

  describe('extractLinks', () => {
    it('should extract and normalize links', async () => {
      const {$} = await contentService.processHtml(mockHtml, 'https://example.com/page');
      const links = contentService.extractLinks($, $('main'), 'https://example.com/page');

      expect(links).toHaveLength(3); // Now includes external links
      expect(links).toContain('https://example.com/relative-link');
      expect(links).toContain('https://example.com/absolute-link');
      expect(links).toContain('https://external.com/external-link');
    });

    it('should include external links', async () => {
      const {$} = await contentService.processHtml(mockHtml, 'https://example.com/page');
      const links = contentService.extractLinks($, $('main'), 'https://example.com/page');

      // External links are now included in the extraction
      expect(links).toContain('https://external.com/external-link');
    });

    it('should handle invalid links', async () => {
      const badHtml = '<html><body><a href=":::invalid:::">Bad Link</a></body></html>';
      const {$} = await contentService.processHtml(badHtml, 'https://example.com/page');
      const links = contentService.extractLinks($, $('body'), 'https://example.com/page');

      // Invalid links are now resolved as absolute URLs
      expect(links).toHaveLength(1);
      expect(links[0]).toBe('https://example.com/:::invalid:::');
    });
  });
});
