import { describe, it, expect } from 'vitest';
import { analyzeDocument, buildContextWindow, getPreviousContext, getFollowingContext, getEntityReference, optimizeForTokenLimit, DocumentAnalysisSchema } from '../../src/context.js';
import { z } from 'zod';
import path from 'path';

const SAMPLE_BLOCKS = [
  { text: 'The Báb was born in Shiraz in 1819. He was the founder of the Bábí Faith.' },
  { text: 'Baháʼu’lláh, born in Tehran, was a follower of the Báb before proclaiming his own mission.' },
  { text: 'Key locations include Shiraz, Tehran, and Baghdad. The Ottoman Empire played a role.' },
  { text: 'Major themes: religious renewal, persecution, exile.' },
  { text: 'The movement spread rapidly in Persia and beyond.' }
];

const SAMPLE_METADATA = {
  title: 'Origins of the Baháʼí Faith',
  author: 'Researcher X',
  publication_date: '2020-05-01',
  language: 'en'
};

const AI_CONFIG = { provider: 'mock', host: '', model: '' };

// Mock callAI to return a plausible AI response for analysis
async function mockCallAI(prompt, schema, aiConfig) {
  if (schema === DocumentAnalysisSchema) {
    return {
      bibliographic: {
        title: 'Origins of the Baháʼí Faith',
        author: 'Researcher X',
        publication_date: '2020-05-01',
        language: 'en',
        word_count: 1500
      },
      content_analysis: {
        people: [ { name: 'The Báb', role: 'founder' }, { name: 'Baháʼu’lláh', role: 'prophet' } ],
        places: [ { name: 'Shiraz' }, { name: 'Tehran' }, { name: 'Baghdad' } ],
        organizations: [ { name: 'Ottoman Empire' } ],
        themes: [ 'religious renewal', 'persecution', 'exile' ]
      },
      context_summary: 'This document describes the origins of the Baháʼí Faith, focusing on the Báb and Baháʼu’lláh, key locations, and major themes.'
    };
  }
  // For block enrichment
  return { contexted: prompt.includes('context window') ? 'ENRICHED: ' + prompt.slice(0, 40) : '' };
}

// TESTS

describe('Document Analysis and Context Window', () => {
  it('produces valid document analysis from blocks and metadata', async () => {
    const analysis = await analyzeDocument(SAMPLE_BLOCKS, SAMPLE_METADATA, AI_CONFIG, mockCallAI);
    expect(analysis).toBeTruthy();
    expect(analysis.bibliographic.title).toMatch(/Baháʼí Faith/);
    expect(analysis.content_analysis.people).toHaveLength(2);
    expect(analysis.context_summary).toMatch(/origins of the Baháʼí Faith/);
    DocumentAnalysisSchema.parse(analysis); // schema validation
  });

  it('builds a context window that fits the budget and includes all components', () => {
    const processed = [ { contexted: 'Block 1' }, { contexted: 'Block 2' } ];
    const analysis = {
      context_summary: 'Summary here',
      content_analysis: {
        people: [ { name: 'A' }, { name: 'B' } ],
        places: [ { name: 'X' } ],
        organizations: [],
        themes: ['foo']
      }
    };
    const window = buildContextWindow(2, SAMPLE_BLOCKS, processed, analysis, { totalBudget: 300 });
    expect(window.length).toBeLessThan(315);
    expect(window).toMatch(/Summary here/);
    expect(window).toMatch(/Block 1/);
    expect(window).toMatch(/Block 2/);
    expect(window).toMatch(/foo|A|B|X/);
  });

  it('truncates previous and following context correctly', () => {
    const prev = getPreviousContext([
      { contexted: 'A'.repeat(50) },
      { contexted: 'B'.repeat(50) },
      { contexted: 'C'.repeat(50) }
    ], 100);
    expect(prev.length).toBeLessThanOrEqual(100 + 4); // allow for newlines
    const next = getFollowingContext([
      { text: 'A'.repeat(50) },
      { text: 'B'.repeat(50) },
      { text: 'C'.repeat(50) },
      { text: 'D'.repeat(50) }
    ], 1, 100);
    expect(next.length).toBeLessThanOrEqual(100 + 4);
  });

  it('gets entity references within char budget', () => {
    const contentAnalysis = {
      people: [ { name: 'A' }, { name: 'B' } ],
      places: [ { name: 'X' } ],
      organizations: [],
      themes: ['foo','bar','baz']
    };
    const ref = getEntityReference(contentAnalysis, 30);
    expect(ref.length).toBeLessThanOrEqual(33); // ...
    expect(ref).toMatch(/People/);
  });

  it('optimizes for token limit', () => {
    const components = {
      a: 'A'.repeat(50), b: 'B'.repeat(50), c: 'C'.repeat(50)
    };
    const out = optimizeForTokenLimit(components, 120);
    expect(out.length).toBeLessThanOrEqual(123); // ...
  });
});
