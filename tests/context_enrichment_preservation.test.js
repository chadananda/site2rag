import { describe, it, expect } from 'vitest';
import path from 'path';

describe('Context enrichment preserves original content after context is stripped', () => {
  function stripContext(text) {
    // Remove any context summary or lines starting with '> CONTEXT SUMMARY' or '> CONTEXT NOTE'
    return text.replace(/^> CONTEXT SUMMARY[\s\S]*?\n\n/, '')
               .replace(/^> CONTEXT NOTE[\s\S]*?\n\n/, '')
               .replace(/^> .+\n/gm, '')
               .trim();
  }

  it('returns identical content after stripping context', () => {
    const original = 'The Báb was born in Shiraz in 1819.';
    const enriched = '> CONTEXT SUMMARY\n> This is a summary.\n\nThe Báb was born in Shiraz in 1819.';
    expect(stripContext(enriched)).toEqual(stripContext(original));
  });

  it('handles context added at multiple steps', () => {
    const original = 'Baháʼu’lláh, born in Tehran, was a follower of the Báb.';
    const enriched = '> CONTEXT SUMMARY\n> Another summary.\n\n> CONTEXT NOTE\n> Disambiguation.\n\nBaháʼu’lláh, born in Tehran, was a follower of the Báb.';
    expect(stripContext(enriched)).toEqual(stripContext(original));
  });
});
