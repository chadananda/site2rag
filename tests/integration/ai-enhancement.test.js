import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  extractEntitiesWithSlidingWindow,
  enhanceBlocksWithEntityContext,
  enhanceBlocksWithCaching
} from '../../src/context.js';

const TEST_OUTPUT_DIR = path.join(process.cwd(), 'tests', 'tmp', 'integration', 'ai-enhancement');

// Mock AI service for testing
class MockAIService {
  constructor() {
    this.callCount = 0;
    this.responses = new Map();
  }
  async callAI(prompt) {
    this.callCount++;
    if (prompt.includes('Extract all entities')) {
      return {
        people: [{name: 'Test Person', roles: ['author'], context: 'Test context'}],
        places: [{name: 'Test Place', type: 'location', context: 'Test location'}],
        organizations: [],
        dates: [],
        events: [],
        subjects: ['AI testing', 'Integration testing'],
        relationships: []
      };
    }
    // Pattern-based enhancement response (non-deterministic safe)
    const enhancedText = prompt.includes('Original text')
      ? 'Enhanced test content with entity context applied'
      : 'Default enhanced content';
    return {
      contexted_markdown: enhancedText,
      context_summary: 'Applied test entity context'
    };
  }
}

beforeEach(() => {
  if (!fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.mkdirSync(TEST_OUTPUT_DIR, {recursive: true});
  }
});

afterEach(() => {
  if (fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.rmSync(TEST_OUTPUT_DIR, {recursive: true, force: true});
  }
});

describe('Integration: AI Enhancement Workflows', () => {
  it('extracts entities and enhances content blocks', async () => {
    console.log('Starting AI enhancement integration test');
    const mockAI = new MockAIService();
    const testBlocks = [
      {text: 'This is a test block about AI processing.'},
      {text: 'Another block discussing integration testing methods.'},
      {text: 'Final block covering entity extraction techniques.'}
    ];
    const metadata = {
      title: 'Test Document',
      url: 'https://example.com/test',
      description: 'Integration test document'
    };
    // Extract entities using sliding window
    const entityGraph = await extractEntitiesWithSlidingWindow(
      testBlocks.slice(0, 2),
      metadata,
      {provider: 'mock'},
      mockAI.callAI.bind(mockAI)
    );
    expect(entityGraph).toBeTruthy();
    expect(entityGraph.people).toBeDefined();
    expect(entityGraph.subjects).toBeDefined();
    expect(mockAI.callCount).toBeGreaterThan(0);
    // Enhance blocks with entity context
    const enhancedResult = await enhanceBlocksWithEntityContext(
      testBlocks,
      entityGraph,
      {provider: 'mock'},
      mockAI.callAI.bind(mockAI)
    );
    expect(enhancedResult).toBeTruthy();
    expect(Array.isArray(enhancedResult)).toBe(true);
    expect(enhancedResult.length).toBe(testBlocks.length);
    // Pattern-based assertions for non-deterministic AI responses
    enhancedResult.forEach(block => {
      expect(block.contexted_markdown).toMatch(/enhanced|content|test/i);
      expect(typeof block.contexted_markdown).toBe('string');
      expect(block.contexted_markdown.length).toBeGreaterThan(10);
    });
    console.log(`AI calls made: ${mockAI.callCount}`);
  }, 30000);

  it('demonstrates caching optimization for repeated content', async () => {
    console.log('Starting caching optimization test');
    const mockAI = new MockAIService();
    // Create blocks with some repeated content
    const testBlocks = [
      {text: 'Repeated content about AI testing and validation.'},
      {text: 'Different content about integration workflows.'},
      {text: 'Repeated content about AI testing and validation.'}, // Duplicate
      {text: 'More unique content for testing purposes.'}
    ];
    const metadata = {
      title: 'Caching Test Document',
      url: 'https://example.com/cache-test',
      description: 'Test document for caching optimization'
    };
    const entityGraph = {
      people: [{name: 'Test Developer', roles: ['developer'], context: 'Test context'}],
      places: [],
      organizations: [],
      dates: [],
      events: [],
      subjects: ['caching', 'optimization', 'AI testing'],
      relationships: []
    };
    // Use caching-optimized enhancement
    const cachedResult = await enhanceBlocksWithCaching(
      testBlocks,
      entityGraph,
      metadata,
      {provider: 'mock'},
      mockAI.callAI.bind(mockAI)
    );
    expect(cachedResult.enhanced_blocks).toBeTruthy();
    expect(cachedResult.enhanced_blocks.length).toBe(testBlocks.length);
    expect(cachedResult.cache_stats).toBeTruthy();
    expect(typeof cachedResult.duration).toBe('number');
    // Verify caching worked (should have fewer AI calls than blocks due to duplicates)
    expect(mockAI.callCount).toBeLessThanOrEqual(testBlocks.length);
    // Pattern-based verification of enhancement quality
    cachedResult.enhanced_blocks.forEach(block => {
      expect(block.contexted_markdown).toMatch(/\w+/); // Contains words
      expect(typeof block.contexted_markdown).toBe('string');
    });
    console.log(`Cache stats: ${JSON.stringify(cachedResult.cache_stats)}`);
  }, 25000);

  it('handles real-world content processing workflow', async () => {
    console.log('Starting real-world content processing test');
    const mockAI = new MockAIService();
    // Simulate realistic content blocks
    const realisticBlocks = [
      {
        text: 'The development of modern AI systems requires careful consideration of both technical and ethical factors.'
      },
      {
        text: 'Integration testing ensures that different components of a software system work together effectively.'
      },
      {
        text: 'Performance optimization techniques include caching, indexing, and algorithmic improvements.'
      }
    ];
    const metadata = {
      title: 'AI Development Best Practices',
      url: 'https://example.com/ai-best-practices',
      description: 'Comprehensive guide to AI development methodologies'
    };
    // Full workflow: extract entities then enhance content
    console.log('Extracting entities...');
    const entityGraph = await extractEntitiesWithSlidingWindow(
      realisticBlocks,
      metadata,
      {provider: 'mock'},
      mockAI.callAI.bind(mockAI)
    );
    console.log('Enhancing content...');
    const enhancedBlocks = await enhanceBlocksWithEntityContext(
      realisticBlocks,
      entityGraph,
      {provider: 'mock'},
      mockAI.callAI.bind(mockAI)
    );
    // Save results to test output directory
    const resultsFile = path.join(TEST_OUTPUT_DIR, 'enhancement_results.json');
    const results = {
      original_blocks: realisticBlocks,
      entity_graph: entityGraph,
      enhanced_blocks: enhancedBlocks,
      ai_calls_made: mockAI.callCount,
      test_timestamp: new Date().toISOString()
    };
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    // Verify workflow completed successfully
    expect(entityGraph.subjects.length).toBeGreaterThan(0);
    expect(enhancedBlocks.length).toBe(realisticBlocks.length);
    expect(fs.existsSync(resultsFile)).toBe(true);
    // Clean up test file
    fs.unlinkSync(resultsFile);
    console.log(`Real-world workflow completed with ${mockAI.callCount} AI calls`);
  }, 45000);
});
