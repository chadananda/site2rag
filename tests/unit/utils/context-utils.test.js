import {describe, it, expect, beforeEach} from 'vitest';
import {
  getOptimalWindowSize,
  buildSlidingCacheInstructions,
  createBatchProcessingPrompt,
  createOptimizedSlidingWindows,
  createParagraphBatches,
  findBlocksInWindowRange,
  validateEnhancement,
  removeContextInsertions,
  extractContextInsertions
} from '../../../src/utils/context_utils.js';

// Mock console.log to avoid test output clutter
vi.mock('console', () => ({
  log: vi.fn()
}));

describe('Context Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOptimalWindowSize', () => {
    it('should return default window size for unknown models', () => {
      const aiConfig = {provider: 'unknown', model: 'unknown-model'};
      const result = getOptimalWindowSize(aiConfig);
      
      expect(result.windowSize).toBe(2457); // 4096 * 0.75 * 0.8
      expect(result.overlapSize).toBe(1228); // 50% of window size
    });

    it('should return GPT-4 window size', () => {
      const aiConfig = {provider: 'openai', model: 'gpt-4'};
      const result = getOptimalWindowSize(aiConfig);
      
      expect(result.windowSize).toBe(4800); // 8000 * 0.75 * 0.8
      expect(result.overlapSize).toBe(2400); // 50% of window size
    });

    it('should return Claude window size', () => {
      const aiConfig = {provider: 'anthropic', model: 'claude-3-opus'};
      const result = getOptimalWindowSize(aiConfig);
      
      expect(result.windowSize).toBe(18000); // Capped at 18000
      expect(result.overlapSize).toBe(9000); // 50% of window size
    });

    it('should handle Ollama models', () => {
      const aiConfig = {provider: 'ollama', model: 'llama3.2:latest'};
      const result = getOptimalWindowSize(aiConfig);
      
      expect(result.windowSize).toBe(2457); // 4096 * 0.75 * 0.8
      expect(result.overlapSize).toBe(1228); // 50% of window size
    });

    it('should handle Qwen models with larger context', () => {
      const aiConfig = {provider: 'ollama', model: 'qwen2.5:14b'};
      const result = getOptimalWindowSize(aiConfig);
      
      expect(result.windowSize).toBe(18000); // Capped at 18000
      expect(result.overlapSize).toBe(9000); // 50% of window size
    });

    it('should handle missing provider/model gracefully', () => {
      const result1 = getOptimalWindowSize({});
      const result2 = getOptimalWindowSize();
      
      expect(result1.windowSize).toBe(2457);
      expect(result2.windowSize).toBe(2457);
    });

    it('should handle case insensitive model names', () => {
      const aiConfig = {provider: 'OPENAI', model: 'GPT-4'};
      const result = getOptimalWindowSize(aiConfig);
      
      expect(result.windowSize).toBe(4800);
    });
  });

  describe('buildSlidingCacheInstructions', () => {
    it('should build instructions with complete metadata', () => {
      const metadata = {
        title: 'Test Document',
        url: 'https://example.com/test',
        description: 'A test document for validation'
      };
      
      const instructions = buildSlidingCacheInstructions(metadata);
      
      expect(instructions).toContain('SLIDING CONTEXT DISAMBIGUATION SESSION');
      expect(instructions).toContain('Test Document');
      expect(instructions).toContain('https://example.com/test');
      expect(instructions).toContain('A test document for validation');
      expect(instructions).toContain('Document-Only Context');
      expect(instructions).toContain('[[...]] delimiters');
    });

    it('should handle missing metadata gracefully', () => {
      const metadata = {};
      const instructions = buildSlidingCacheInstructions(metadata);
      
      expect(instructions).toContain('Unknown');
      expect(instructions).toContain('None');
      expect(instructions).toContain('SLIDING CONTEXT DISAMBIGUATION SESSION');
    });

    it('should include all required instruction sections', () => {
      const instructions = buildSlidingCacheInstructions({});
      
      expect(instructions).toContain('Guidelines');
      expect(instructions).toContain('Validation Requirements');
      expect(instructions).toContain('Pronoun Clarification');
      expect(instructions).toContain('Temporal Context');
      expect(instructions).toContain('Acronym Expansion');
    });
  });

  describe('createBatchProcessingPrompt', () => {
    it('should create batch processing prompt with numbered paragraphs', () => {
      const batch = {
        blocks: [
          {originalText: 'First paragraph text'},
          {originalText: 'Second paragraph text'},
          {originalText: 'Third paragraph text'}
        ]
      };
      
      const prompt = createBatchProcessingPrompt(batch);
      
      expect(prompt).toContain('1. First paragraph text');
      expect(prompt).toContain('2. Second paragraph text');
      expect(prompt).toContain('3. Third paragraph text');
      expect(prompt).toContain('MARKDOWN PRESERVATION RULES');
      expect(prompt).toContain('JSON Response Format');
    });

    it('should include markdown preservation rules', () => {
      const batch = {blocks: [{originalText: 'Test'}]};
      const prompt = createBatchProcessingPrompt(batch);
      
      expect(prompt).toContain('preserve ALL markdown syntax exactly');
      expect(prompt).toContain('NEVER change URLs, links, image paths');
      expect(prompt).toContain('![alt text](url)');
      expect(prompt).toContain('[link text](url)');
      expect(prompt).toContain('Do NOT add [[...]] insertions inside URLs');
    });

    it('should include correct and wrong examples', () => {
      const batch = {blocks: [{originalText: 'Test'}]};
      const prompt = createBatchProcessingPrompt(batch);
      
      expect(prompt).toContain('Examples of CORRECT markdown enhancement');
      expect(prompt).toContain('Examples of WRONG enhancement');
      expect(prompt).toContain('this [[Ocean search software development]] was');
      expect(prompt).toContain('NEVER DO THIS');
    });

    it('should handle empty blocks', () => {
      const batch = {blocks: []};
      const prompt = createBatchProcessingPrompt(batch);
      
      expect(prompt).toContain('MARKDOWN paragraphs to enhance');
      expect(prompt).toContain('JSON Response Format');
    });
  });

  describe('createOptimizedSlidingWindows', () => {
    const sampleBlocks = [
      {text: 'First paragraph with some content here'},
      {text: 'Second paragraph with more content'},
      {text: 'Third paragraph with additional text'},
      {text: 'Fourth paragraph with final content'}
    ];

    it('should create sliding windows with proper overlap', () => {
      const windows = createOptimizedSlidingWindows(sampleBlocks, 10, 5);
      
      expect(windows.length).toBeGreaterThan(0);
      expect(windows[0]).toHaveProperty('windowIndex', 0);
      expect(windows[0]).toHaveProperty('startWord', 0);
      expect(windows[0]).toHaveProperty('contextText');
      expect(windows[0]).toHaveProperty('coveredBlocks');
      expect(windows[0]).toHaveProperty('paragraphBatches');
    });

    it('should handle different block content structures', () => {
      const mixedBlocks = [
        {text: 'Text property'},
        {content: 'Content property'},
        {original: 'Original property'},
        'Direct string'
      ];
      
      const windows = createOptimizedSlidingWindows(mixedBlocks, 10, 5);
      
      expect(windows.length).toBeGreaterThan(0);
    });

    it('should skip tiny windows when others exist', () => {
      const shortBlocks = [{text: 'Short text'}];
      const windows = createOptimizedSlidingWindows(shortBlocks, 1000, 500);
      
      expect(windows.length).toBe(1); // Should create one window even if small
    });

    it('should filter out non-string content', () => {
      const invalidBlocks = [
        {text: 'Valid text'},
        {text: null},
        {text: undefined},
        {text: 123},
        {text: 'Another valid text'}
      ];
      
      const windows = createOptimizedSlidingWindows(invalidBlocks, 10, 5);
      
      expect(windows.length).toBeGreaterThan(0);
    });

    it('should end windows on sentence boundaries when possible', () => {
      const blocks = [{text: 'First sentence. Second sentence! Third sentence? More text'}];
      const windows = createOptimizedSlidingWindows(blocks, 8, 4);
      
      expect(windows[0].contextText).toMatch(/[.!?]$/);
    });
  });

  describe('createParagraphBatches', () => {
    const allBlocks = [
      {text: 'Block 0'},
      {text: 'Block 1'},
      {text: 'Block 2'},
      {text: 'Block 3'},
      {text: 'Block 4'},
      {text: 'Block 5'},
      {text: 'Block 6'}
    ];

    it('should create batches with maximum size of 5', () => {
      const blockIndices = [0, 1, 2, 3, 4, 5, 6];
      const batches = createParagraphBatches(blockIndices, allBlocks);
      
      expect(batches.length).toBe(2); // 7 blocks = 2 batches (5 + 2)
      expect(batches[0].blocks.length).toBe(5);
      expect(batches[1].blocks.length).toBe(2);
    });

    it('should preserve original indices', () => {
      const blockIndices = [1, 3, 5];
      const batches = createParagraphBatches(blockIndices, allBlocks);
      
      expect(batches[0].blocks[0].originalIndex).toBe(1);
      expect(batches[0].blocks[1].originalIndex).toBe(3);
      expect(batches[0].blocks[2].originalIndex).toBe(5);
    });

    it('should handle different block text properties', () => {
      const mixedBlocks = [
        {text: 'Text property'},
        {content: 'Content property'},
        {original: 'Original property'}
      ];
      const batches = createParagraphBatches([0, 1, 2], mixedBlocks);
      
      expect(batches[0].blocks[0].originalText).toBe('Text property');
      expect(batches[0].blocks[1].originalText).toBe('Content property');
      expect(batches[0].blocks[2].originalText).toBe('Original property');
    });

    it('should include escaped text for JSON safety', () => {
      const blocks = [{text: 'Text with "quotes" and \\backslashes'}];
      const batches = createParagraphBatches([0], blocks);
      
      expect(batches[0].blocks[0].escapedText).toBe('"Text with \\"quotes\\" and \\\\backslashes"');
    });

    it('should handle empty block indices', () => {
      const batches = createParagraphBatches([], allBlocks);
      
      expect(batches).toEqual([]);
    });
  });

  describe('findBlocksInWindowRange', () => {
    const blocks = [
      {text: 'First block with five words'},     // 0-4
      {text: 'Second block with three words'},   // 5-7
      {text: 'Third block with four words'},     // 8-11
      {text: 'Fourth block with two words'}      // 12-13
    ];

    it('should find blocks overlapping with window range', () => {
      const coveredBlocks = findBlocksInWindowRange(3, 6, blocks); // Words 3-8
      
      expect(coveredBlocks).toContain(0); // First block (0-4) overlaps
      expect(coveredBlocks).toContain(1); // Second block (5-7) overlaps
      expect(coveredBlocks).toContain(2); // Third block (8-11) overlaps at start
      expect(coveredBlocks).not.toContain(3); // Fourth block (12-13) doesn't overlap
    });

    it('should handle window at document start', () => {
      const coveredBlocks = findBlocksInWindowRange(0, 3, blocks); // Words 0-2
      
      expect(coveredBlocks).toContain(0);
      expect(coveredBlocks).not.toContain(1);
    });

    it('should handle window at document end', () => {
      const coveredBlocks = findBlocksInWindowRange(12, 2, blocks); // Words 12-13
      
      expect(coveredBlocks).toContain(3);
      expect(coveredBlocks).not.toContain(2);
    });

    it('should handle large window covering all blocks', () => {
      const coveredBlocks = findBlocksInWindowRange(0, 20, blocks);
      
      expect(coveredBlocks).toEqual([0, 1, 2, 3]);
    });

    it('should handle blocks with different text properties', () => {
      const mixedBlocks = [
        {text: 'Text property'},
        {content: 'Content property'},
        {original: 'Original property'}
      ];
      const coveredBlocks = findBlocksInWindowRange(0, 5, mixedBlocks);
      
      expect(coveredBlocks.length).toBeGreaterThan(0);
    });
  });

  describe('validateEnhancement', () => {
    it('should validate matching original and enhanced text', () => {
      const original = 'This is the original text';
      const enhanced = 'This is the [[enhanced]] original text';
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(true);
    });

    it('should reject enhanced text that changes original content', () => {
      const original = 'This is the original text';
      const enhanced = 'This is the modified text';
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(false);
    });

    it('should handle Bahai terminology normalization', () => {
      const original = "Bahá'í faith";
      const enhanced = "Baha'i [[religious]] faith";
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(true);
    });

    it('should handle accent mark variations', () => {
      const original = 'Bahá text';
      const enhanced = 'Baha [[enhanced]] text';
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(true);
    });

    it('should handle apostrophe variations', () => {
      const original = "Text with 'quotes'";
      const enhanced = "Text with [[added context]] 'quotes'";
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(true);
    });

    it('should handle whitespace normalization', () => {
      const original = 'Text  with   extra    spaces';
      const enhanced = 'Text with [[context]] extra spaces';
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(true);
    });

    it('should reject null or undefined inputs', () => {
      expect(validateEnhancement(null, 'enhanced')).toBe(false);
      expect(validateEnhancement('original', null)).toBe(false);
      expect(validateEnhancement(undefined, 'enhanced')).toBe(false);
      expect(validateEnhancement('original', undefined)).toBe(false);
    });

    it('should handle multiple context insertions', () => {
      const original = 'The organization was founded in 1844';
      const enhanced = 'The [[Bahai]] organization was founded [[by Bahaullah]] in 1844';
      
      const isValid = validateEnhancement(original, enhanced);
      
      expect(isValid).toBe(true);
    });
  });

  describe('removeContextInsertions', () => {
    it('should remove single context insertion', () => {
      const enhanced = 'Text with [[context]] insertion';
      const result = removeContextInsertions(enhanced);
      
      expect(result).toBe('Text with insertion');
    });

    it('should remove multiple context insertions', () => {
      const enhanced = 'Text with [[first]] and [[second]] insertions';
      const result = removeContextInsertions(enhanced);
      
      expect(result).toBe('Text with and insertions');
    });

    it('should handle nested brackets', () => {
      const enhanced = 'Text with [[context [nested] insertion]] here';
      const result = removeContextInsertions(enhanced);
      
      expect(result).toBe('Text with here');
    });

    it('should normalize whitespace after removal', () => {
      const enhanced = 'Text   with [[context]]   extra   spaces';
      const result = removeContextInsertions(enhanced);
      
      expect(result).toBe('Text with extra spaces');
    });

    it('should handle text without context insertions', () => {
      const enhanced = 'Plain text without any insertions';
      const result = removeContextInsertions(enhanced);
      
      expect(result).toBe('Plain text without any insertions');
    });

    it('should handle empty or null input', () => {
      expect(removeContextInsertions('')).toBe('');
      expect(removeContextInsertions(null)).toBe(null);
      expect(removeContextInsertions(undefined)).toBe(undefined);
    });

    it('should handle context insertions with whitespace', () => {
      const enhanced = 'Text [[with spaces in context]] here';
      const result = removeContextInsertions(enhanced);
      
      expect(result).toBe('Text here');
    });
  });

  describe('extractContextInsertions', () => {
    it('should extract single context insertion', () => {
      const enhanced = 'Text with [[context]] insertion';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual(['context']);
    });

    it('should extract multiple context insertions', () => {
      const enhanced = 'Text with [[first]] and [[second]] insertions';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual(['first', 'second']);
    });

    it('should handle context insertions with spaces', () => {
      const enhanced = 'Text with [[context with spaces]] here';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual(['context with spaces']);
    });

    it('should handle nested brackets correctly', () => {
      const enhanced = 'Text with [[context [nested] insertion]] here';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual(['context [nested] insertion']);
    });

    it('should return empty array for text without insertions', () => {
      const enhanced = 'Plain text without any insertions';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual([]);
    });

    it('should handle empty or null input', () => {
      expect(extractContextInsertions('')).toEqual([]);
      expect(extractContextInsertions(null)).toEqual([]);
      expect(extractContextInsertions(undefined)).toEqual([]);
    });

    it('should handle malformed brackets', () => {
      const enhanced = 'Text with [single] and [[proper]] brackets';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual(['proper']);
    });

    it('should handle complex context insertions', () => {
      const enhanced = 'The [[Bahai]] organization was [[founded by Bahaullah]] in 1844';
      const result = extractContextInsertions(enhanced);
      
      expect(result).toEqual(['Bahai', 'founded by Bahaullah']);
    });
  });
});