/**
 * Unit tests for two-pass entity extraction with sliding windows
 * Tests core processing functions independently with mocked AI calls
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSlidingWindows,
  mergeEntityExtractions,
  mergeEntities,
  mergeRelationships,
  findRelevantEntities,
  buildEntityContext,
  buildEntityAwareContextWindow,
  extractEntitiesWithSlidingWindow,
  enhanceBlocksWithEntityContext,
  buildEntitySummary,
  EntityExtractionSchema,
  EntityGraphSchema
} from '../../src/context.js';

describe('Sliding Window Functions', () => {
  it('should create sliding windows with overlap', () => {
    const blocks = [
      { text: 'Block 1 with five words' },
      { text: 'Block 2 with five words' },
      { text: 'Block 3 with five words' },
      { text: 'Block 4 with five words' }
    ];
    
    const windows = createSlidingWindows(blocks, 10, 5); // 10 words per window, 5 overlap
    
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]).toContain('Block 1 with five words');
    expect(windows[0]).toContain('Block 2 with five words');
  });

  it('should handle single large block', () => {
    const blocks = [
      { text: 'This is a very long block with many many many many many many words that exceeds the window size limit and should be split appropriately' }
    ];
    
    const windows = createSlidingWindows(blocks, 10, 2);
    
    expect(windows.length).toBe(1); // Single block goes in one window even if large
    expect(windows[0][0]).toContain('very long block');
  });

  it('should create no windows for empty blocks', () => {
    const blocks = [];
    const windows = createSlidingWindows(blocks, 10, 2);
    expect(windows).toEqual([]);
  });
});

describe('Entity Merging Functions', () => {
  it('should merge entities by key field', () => {
    const existing = [
      { name: 'John Doe', roles: ['author'], context: 'Writer' }
    ];
    const newEntities = [
      { name: 'john doe', roles: ['speaker'], context: 'Presenter' },
      { name: 'Jane Smith', roles: ['editor'], context: 'Editor' }
    ];
    
    const merged = mergeEntities(existing, newEntities, 'name');
    
    expect(merged).toHaveLength(2);
    expect(merged[0].name).toBe('John Doe');
    expect(merged[0].roles).toEqual(['author', 'speaker']);
    expect(merged[0].context).toContain('Writer; Presenter');
    expect(merged[1].name).toBe('Jane Smith');
  });

  it('should merge relationships without duplicates', () => {
    const existing = [
      { from: 'John', relationship: 'works at', to: 'Company' }
    ];
    const newRels = [
      { from: 'John', relationship: 'works at', to: 'Company' }, // duplicate
      { from: 'Jane', relationship: 'manages', to: 'Team' }
    ];
    
    const merged = mergeRelationships(existing, newRels);
    
    expect(merged).toHaveLength(2);
    expect(merged.map(r => r.from)).toEqual(['John', 'Jane']);
  });

  it('should merge multiple entity extractions', () => {
    const extractions = [
      {
        people: [{ name: 'Alice', roles: ['developer'] }],
        places: [{ name: 'San Francisco', type: 'city' }],
        subjects: ['technology', 'software']
      },
      {
        people: [{ name: 'Bob', roles: ['manager'] }],
        places: [{ name: 'San Francisco', type: 'city' }], // duplicate
        subjects: ['technology', 'business'] // partial overlap
      }
    ];
    
    const merged = mergeEntityExtractions(extractions);
    
    expect(merged.people).toHaveLength(2);
    expect(merged.places).toHaveLength(1); // deduplicated
    expect(merged.subjects).toEqual(['technology', 'software', 'business']);
  });
});

describe('Entity Context Functions', () => {
  const sampleEntityGraph = {
    people: [
      { name: 'Chad Jones', roles: ['author', 'developer'], context: 'Creator of Ocean software' },
      { name: 'Hooper Dunbar', roles: ['scholar'], aliases: ['Dunbar'], context: 'Bahá\'í scholar' }
    ],
    places: [
      { name: 'Haifa', type: 'city', context: 'Bahá\'í World Centre location' },
      { name: 'India', type: 'country', context: 'Development location' }
    ],
    organizations: [
      { name: 'Bahá\'í Publishing Trust', type: 'publisher', context: 'Official publisher' }
    ],
    subjects: ['Digital search', 'Bahá\'í literature', 'Software development']
  };

  it('should find relevant entities in text block', () => {
    const blockText = 'Chad Jones developed Ocean software in India with help from Dunbar.';
    
    const relevant = findRelevantEntities(blockText, sampleEntityGraph);
    
    expect(relevant.people).toHaveLength(2);
    expect(relevant.people[0].name).toBe('Chad Jones');
    expect(relevant.people[1].name).toBe('Hooper Dunbar'); // found by alias
    expect(relevant.places).toHaveLength(1);
    expect(relevant.places[0].name).toBe('India');
  });

  it('should build entity context string within budget', () => {
    const relevantEntities = {
      people: [{ name: 'Chad Jones', roles: ['author'], context: 'Creator' }],
      places: [{ name: 'Haifa', type: 'city', context: 'Holy city' }]
    };
    
    const context = buildEntityContext(relevantEntities, 100);
    
    expect(context).toContain('Chad Jones (author)');
    expect(context).toContain('Haifa (city)');
    expect(context.length).toBeLessThanOrEqual(100);
  });

  it('should truncate entity context if too long', () => {
    const relevantEntities = {
      people: [{ 
        name: 'Very Long Name With Many Details', 
        roles: ['very long role description that goes on and on'],
        context: 'extremely detailed context that provides way too much information for the budget'
      }]
    };
    
    const context = buildEntityContext(relevantEntities, 50);
    
    expect(context.length).toBeLessThanOrEqual(50);
    expect(context).toMatch(/\.\.\.$/); // should end with truncation
  });

  it('should build entity summary for header', () => {
    const summary = buildEntitySummary(sampleEntityGraph);
    
    expect(summary).toContain('People: Chad Jones, Hooper Dunbar');
    expect(summary).toContain('Places: Haifa, India');
    expect(summary).toContain('Organizations: Bahá\'í Publishing Trust');
  });
});

describe('AI Processing Functions with Mocks', () => {
  it('should extract entities with mocked AI call', async () => {
    const mockAI = vi.fn().mockResolvedValue({
      people: [{ name: 'Test Person', roles: ['tester'] }],
      places: [{ name: 'Test Place', type: 'location' }],
      subjects: ['testing', 'software'],
      relationships: []
    });

    const blocks = [
      { text: 'Test Person worked at Test Place on testing software.' }
    ];
    const metadata = { title: 'Test Article' };
    const aiConfig = { provider: 'test' };

    const result = await extractEntitiesWithSlidingWindow(blocks, metadata, aiConfig, mockAI);

    expect(mockAI).toHaveBeenCalledOnce();
    expect(result.people).toHaveLength(1);
    expect(result.people[0].name).toBe('Test Person');
    expect(result.subjects).toEqual(['testing', 'software']);
  });

  it('should enhance blocks with mocked AI call', async () => {
    const mockAI = vi.fn().mockResolvedValue({
      contexted_markdown: 'Enhanced text with additional context about the topic.',
      context_summary: 'Added contextual information'
    });

    const blocks = [
      { text: 'Original text about the topic.' }
    ];
    const entityGraph = {
      people: [{ name: 'Expert', roles: ['specialist'] }],
      subjects: ['topic']
    };
    const aiConfig = { provider: 'test' };

    const result = await enhanceBlocksWithEntityContext(blocks, entityGraph, aiConfig, mockAI);

    expect(mockAI).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('Original text about the topic.');
    expect(result[0].contexted).toBe('Enhanced text with additional context about the topic.');
  });

  it('should handle AI failures gracefully', async () => {
    const mockAI = vi.fn().mockRejectedValue(new Error('AI service unavailable'));

    const blocks = [{ text: 'Test content.' }];
    const entityGraph = { people: [], subjects: [] };
    const aiConfig = { provider: 'test' };

    const result = await enhanceBlocksWithEntityContext(blocks, entityGraph, aiConfig, mockAI);

    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('Test content.');
    expect(result[0].contexted).toBe('Test content.'); // fallback to original
  });
});

describe('Schema Validation', () => {
  it('should validate EntityExtractionSchema', () => {
    const validData = {
      people: [{ name: 'John', roles: ['developer'], aliases: ['Johnny'] }],
      places: [{ name: 'New York', type: 'city' }],
      subjects: ['technology', 'business'],
      relationships: [{ from: 'John', relationship: 'works in', to: 'New York' }]
    };

    const result = EntityExtractionSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should reject invalid EntityExtractionSchema', () => {
    const invalidData = {
      people: [{ name: 123 }], // name should be string
      subjects: 'not an array'
    };

    const result = EntityExtractionSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});