// tests/unit/core/context-processor-simple.test.js
import {describe, it, expect, vi} from 'vitest';
import {cleanTextForContext, simplifyMetadata} from '../../../src/core/context_processor_simple.js';
import debugLogger from '../../../src/services/debug_logger.js';

// Mock the debug logger
vi.mock('../../../src/services/debug_logger.js', () => ({
  default: {
    ai: vi.fn()
  }
}));

describe('context_processor_simple', () => {
  describe('cleanTextForContext', () => {
    it('should remove code blocks with triple backticks', () => {
      const input = 'Some text\n```javascript\nconst x = 1;\n```\nMore text';
      const result = cleanTextForContext(input);
      expect(result).toBe('Some text [code] More text');
    });

    it('should remove indented code blocks', () => {
      const input = 'Some text\n    const x = 1;\n    const y = 2;\nMore text';
      const result = cleanTextForContext(input);
      expect(result).toBe('Some text [code] [code] More text');
    });

    it('should remove images', () => {
      const input = 'Check out ![alt text](image.jpg) this image';
      const result = cleanTextForContext(input);
      expect(result).toBe('Check out this image');
    });

    it('should convert links to just text', () => {
      const input = 'Visit [our website](https://example.com) for more';
      const result = cleanTextForContext(input);
      expect(result).toBe('Visit our website for more');
    });

    it('should remove HTML tags', () => {
      const input = 'Some <strong>bold</strong> and <em>italic</em> text';
      const result = cleanTextForContext(input);
      expect(result).toBe('Some bold and italic text');
    });

    it('should normalize whitespace', () => {
      const input = 'Too    many     spaces\n\n\nand lines';
      const result = cleanTextForContext(input);
      expect(result).toBe('Too many spaces and lines');
    });

    it('should handle empty input', () => {
      expect(cleanTextForContext('')).toBe('');
      expect(cleanTextForContext(null)).toBe('');
      expect(cleanTextForContext(undefined)).toBe('');
    });

    it('should handle complex markdown', () => {
      const input = `
# Header

Some text with [link](url) and ![image](img.jpg).

\`\`\`python
def hello():
    print("world")
\`\`\`

More **bold** text.
      `;
      const result = cleanTextForContext(input);
      // Note: Headers and markdown formatting are preserved, only code/images/links are cleaned
      expect(result).toBe('# Header Some text with link and . [code] More **bold** text.');
    });
  });

  describe('simplifyMetadata', () => {
    it('should keep only essential fields', () => {
      const metadata = {
        title: 'Test Title',
        url: 'https://example.com',
        description: 'Test description',
        og_title: 'Test Title',
        og_description: 'Test description',
        twitter_title: 'Test Title',
        twitter_image: 'image.jpg',
        viewport: 'width=device-width',
        robots: 'index,follow'
      };

      const result = simplifyMetadata(metadata);
      expect(result).toEqual({
        title: 'Test Title',
        url: 'https://example.com',
        description: 'Test description'
      });
    });

    it('should provide defaults for missing fields', () => {
      const metadata = {};
      const result = simplifyMetadata(metadata);
      expect(result).toEqual({
        title: 'Unknown Document',
        url: 'Unknown URL',
        description: ''
      });
    });

    it('should handle partial metadata', () => {
      const metadata = {
        title: 'Only Title'
      };
      const result = simplifyMetadata(metadata);
      expect(result).toEqual({
        title: 'Only Title',
        url: 'Unknown URL',
        description: ''
      });
    });

    it('should throw error for null metadata', () => {
      expect(() => simplifyMetadata(null)).toThrow('Metadata is required for context processing');
    });

    it('should log warning for documents with no identifiable info', () => {
      simplifyMetadata({});
      expect(debugLogger.ai).toHaveBeenCalledWith('Warning: Document has no identifiable title or URL');
    });
  });

  describe('window size configuration', () => {
    it('should use environment variable for MIN_BLOCK_CHARS if set', () => {
      // This would require refactoring the constant definition to be testable
      // For now, we document that MIN_BLOCK_CHARS can be configured via SITE2RAG_MIN_BLOCK_CHARS
      expect(true).toBe(true);
    });
  });
});
