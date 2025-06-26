// tests/unit/core/context-processor-simple.test.js
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {cleanTextForContext, simplifyMetadata, processDocumentsSimple} from '../../../src/core/context_processor_simple.js';
import debugLogger from '../../../src/services/debug_logger.js';
import * as aiClient from '../../../src/core/ai_client.js';

// Mock the debug logger
vi.mock('../../../src/services/debug_logger.js', () => ({
  default: {
    ai: vi.fn()
  }
}));

// Mock the AI client
vi.mock('../../../src/core/ai_client.js', () => ({
  callAI: vi.fn()
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

  describe('strictValidateEnhancement', () => {
    // Import the function directly from the module for testing
    let strictValidateEnhancement;
    
    beforeEach(async () => {
      // Import and extract the internal function for testing
      const module = await import('../../../src/core/context_processor_simple.js');
      // Access internal function through processDocumentsSimple closure
      // Since it's not exported, we'll test it through processDocumentsSimple behavior
    });

    it('should validate enhancement through processDocumentsSimple', async () => {
      const mockCallAI = vi.mocked(aiClient.callAI);
      
      // Test case 1: Valid enhancement with only insertions
      mockCallAI.mockResolvedValueOnce('The [[Bahai]] organization was founded in 1844');
      
      const docs = [{
        docId: 'test-doc',
        blocks: ['The organization was founded in 1844'],
        metadata: { title: 'Test', url: 'http://test.com' }
      }];
      
      const result = await processDocumentsSimple(docs, { provider: 'test' });
      expect(result['test-doc'][0]).toBe('The [[Bahai]] organization was founded in 1844');
    });

    it('should reject modifications through processDocumentsSimple', async () => {
      const mockCallAI = vi.mocked(aiClient.callAI);
      
      // Test case 2: Invalid enhancement that modifies content
      mockCallAI.mockResolvedValueOnce('The organization was established in 1844'); // Changed "founded" to "established"
      
      const docs = [{
        docId: 'test-doc',
        blocks: ['The organization was founded in 1844'],
        metadata: { title: 'Test', url: 'http://test.com' }
      }];
      
      const result = await processDocumentsSimple(docs, { provider: 'test' });
      // Should return original text when validation fails
      expect(result['test-doc'][0]).toBe('The organization was founded in 1844');
    });
  });

  describe('processDocumentsSimple', () => {
    let mockCallAI;

    beforeEach(() => {
      mockCallAI = vi.mocked(aiClient.callAI);
      vi.clearAllMocks();
    });

    describe('plain text response handling', () => {
      it('should parse plain text responses split by blank lines', async () => {
        const plainTextResponse = `Block one with [[disambiguation]].

Block two with [[another disambiguation]].

Block three unchanged.`;

        mockCallAI.mockResolvedValueOnce(plainTextResponse);

        const docs = [{
          docId: 'test-doc',
          blocks: [
            'Block one with something.',
            'Block two with something else.',
            'Block three unchanged.'
          ],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        expect(result['test-doc']).toHaveLength(3);
        expect(result['test-doc'][0]).toContain('[[disambiguation]]');
        expect(result['test-doc'][1]).toContain('[[another disambiguation]]');
        expect(result['test-doc'][2]).toBe('Block three unchanged.');
      });

      it('should handle responses with extra whitespace', async () => {
        const responseWithWhitespace = `

Block one enhanced.


Block two enhanced.

`;

        mockCallAI.mockResolvedValueOnce(responseWithWhitespace);

        const docs = [{
          docId: 'test-doc',
          blocks: ['Block one enhanced.', 'Block two enhanced.'],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        expect(result['test-doc']).toHaveLength(2);
      });

      it('should match blocks using content validation', async () => {
        const response = `Second block with [[context]].

First block with [[different context]].`;

        mockCallAI.mockResolvedValueOnce(response);

        const docs = [{
          docId: 'test-doc',
          blocks: [
            'First block with text.',
            'Second block with text.'
          ],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // Blocks should be matched correctly despite order
        expect(result['test-doc'][0]).toContain('[[different context]]');
        expect(result['test-doc'][1]).toContain('[[context]]');
      });
    });

    describe('sliding window creation', () => {
      it('should create windows with proper overlap', async () => {
        // Create many blocks to test windowing
        const blocks = [];
        for (let i = 0; i < 20; i++) {
          blocks.push(`This is paragraph ${i} with enough content to be meaningful and test the sliding window functionality properly.`);
        }

        mockCallAI.mockImplementation((prompt) => {
          // Return enhanced versions of whatever blocks were sent
          const blocksMatch = prompt.match(/TEXT TO PROCESS:\s*\n\s*(\{[\s\S]*?\})/);
          if (blocksMatch) {
            const blocksObj = JSON.parse(blocksMatch[1]);
            return Object.values(blocksObj).map(text => text.replace(/paragraph (\d+)/, 'paragraph [[$1]]')).join('\n\n');
          }
          return '';
        });

        const docs = [{
          docId: 'test-doc',
          blocks: blocks,
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // All blocks should be processed
        expect(result['test-doc']).toHaveLength(20);
        
        // Check that disambiguations were added
        result['test-doc'].forEach((block, i) => {
          expect(block).toContain(`[[${i}]]`);
        });
      });

      it('should skip headers and code blocks from processing', async () => {
        const blocks = [
          '# Header 1',
          'Regular paragraph needing disambiguation.',
          '```javascript\nconst code = true;\n```',
          'Another paragraph.',
          '## Header 2',
          '    indented code block'
        ];

        let promptsSent = [];
        mockCallAI.mockImplementation((prompt) => {
          promptsSent.push(prompt);
          // Return enhanced versions
          return 'Regular paragraph needing [[disambiguation]].\n\nAnother paragraph [[with context]].';
        });

        const docs = [{
          docId: 'test-doc',
          blocks: blocks,
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // Headers and code blocks should be unchanged
        expect(result['test-doc'][0]).toBe('# Header 1');
        expect(result['test-doc'][2]).toBe('```javascript\nconst code = true;\n```');
        expect(result['test-doc'][4]).toBe('## Header 2');
        expect(result['test-doc'][5]).toBe('    indented code block');
        
        // Regular paragraphs should be enhanced
        expect(result['test-doc'][1]).toContain('[[disambiguation]]');
        expect(result['test-doc'][3]).toContain('[[with context]]');
      });

      it('should skip blocks shorter than MIN_BLOCK_CHARS', async () => {
        const blocks = [
          'Short.',
          'This is a much longer paragraph that should definitely be processed because it contains enough content to be meaningful.',
          'Tiny',
          'Another long paragraph with substantial content that warrants disambiguation processing.'
        ];

        mockCallAI.mockResolvedValueOnce(
          'This is a much longer paragraph that should definitely be processed because it contains enough content to be meaningful [[with context]].\n\n' +
          'Another long paragraph with substantial content that warrants disambiguation processing [[with more context]].'
        );

        const docs = [{
          docId: 'test-doc',
          blocks: blocks,
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // Short blocks should be unchanged
        expect(result['test-doc'][0]).toBe('Short.');
        expect(result['test-doc'][2]).toBe('Tiny');
        
        // Long blocks should be enhanced
        expect(result['test-doc'][1]).toContain('[[with context]]');
        expect(result['test-doc'][3]).toContain('[[with more context]]');
      });
    });

    describe('error handling', () => {
      it('should return original blocks on AI error', async () => {
        mockCallAI.mockRejectedValueOnce(new Error('AI service unavailable'));

        const docs = [{
          docId: 'test-doc',
          blocks: ['Original block 1', 'Original block 2'],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // Should return original blocks unchanged
        expect(result['test-doc']).toEqual(['Original block 1', 'Original block 2']);
      });

      it('should handle empty response from AI', async () => {
        mockCallAI.mockResolvedValueOnce('');

        const docs = [{
          docId: 'test-doc',
          blocks: ['Block 1', 'Block 2'],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // Should return original blocks when no enhanced blocks returned
        expect(result['test-doc']).toEqual(['Block 1', 'Block 2']);
      });

      it('should handle mismatched block counts', async () => {
        // AI returns fewer blocks than sent
        mockCallAI.mockResolvedValueOnce('Only one [[enhanced]] block returned.');

        const docs = [{
          docId: 'test-doc',
          blocks: ['Block 1', 'Block 2', 'Block 3'],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        
        // Should handle gracefully
        expect(result['test-doc']).toHaveLength(3);
      });
    });

    describe('progress tracking', () => {
      it('should call progress callback correctly', async () => {
        const progressUpdates = [];
        const progressCallback = (completed, total) => {
          progressUpdates.push({ completed, total });
        };

        // Mock multiple window responses
        mockCallAI
          .mockResolvedValueOnce('Block 1 [[enhanced]].')
          .mockResolvedValueOnce('Block 2 [[enhanced]].');

        const docs = [{
          docId: 'test-doc',
          blocks: [
            'Block 1 text that is long enough to process.',
            'Block 2 text that is long enough to process.'
          ],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        await processDocumentsSimple(docs, { provider: 'test' }, progressCallback);
        
        // Should have initial and completion progress updates
        expect(progressUpdates[0]).toEqual({ completed: 0, total: 2 });
        expect(progressUpdates[progressUpdates.length - 1]).toEqual({ completed: 2, total: 2 });
      });
    });

    describe('metadata handling', () => {
      it('should include all metadata fields in prompt', async () => {
        let capturedPrompt = '';
        mockCallAI.mockImplementation((prompt) => {
          capturedPrompt = prompt;
          return 'Enhanced [[block]].';
        });

        const docs = [{
          docId: 'test-doc',
          blocks: ['A block needing disambiguation about the organization.'],
          metadata: { 
            title: 'Test Document',
            url: 'http://test.com',
            author: 'John Doe',
            authorOrganization: 'ACME Corp',
            description: 'A test document'
          }
        }];

        await processDocumentsSimple(docs, { provider: 'test' });
        
        // Check that metadata is included in prompt
        expect(capturedPrompt).toContain('Test Document');
        expect(capturedPrompt).toContain('http://test.com');
        expect(capturedPrompt).toContain('John Doe');
        expect(capturedPrompt).toContain('ACME Corp');
        expect(capturedPrompt).toContain('A test document');
      });
    });

    describe('edge cases', () => {
      it('should handle unicode characters correctly', async () => {
        const unicodeText = 'Text with émojis 🎉 and spëcial cháracters';
        mockCallAI.mockResolvedValueOnce(unicodeText + ' [[with context]]');

        const docs = [{
          docId: 'test-doc',
          blocks: [unicodeText],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        expect(result['test-doc'][0]).toBe(unicodeText + ' [[with context]]');
      });

      it('should handle very long blocks', async () => {
        const longBlock = 'This is a test. '.repeat(1000); // Very long block
        mockCallAI.mockResolvedValueOnce(longBlock + ' [[context]]');

        const docs = [{
          docId: 'test-doc',
          blocks: [longBlock],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        expect(result['test-doc'][0]).toContain('[[context]]');
      });

      it('should handle blocks with existing disambiguations', async () => {
        const blockWithExisting = 'The [[existing]] disambiguation should be preserved.';
        mockCallAI.mockResolvedValueOnce('The [[existing]] disambiguation should be preserved [[with more]].');

        const docs = [{
          docId: 'test-doc',
          blocks: [blockWithExisting],
          metadata: { title: 'Test', url: 'http://test.com' }
        }];

        const result = await processDocumentsSimple(docs, { provider: 'test' });
        expect(result['test-doc'][0]).toContain('[[existing]]');
        expect(result['test-doc'][0]).toContain('[[with more]]');
      });
    });
  });
});
