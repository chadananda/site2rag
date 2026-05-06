import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeAgreement, reconcilePage } from '../../src/ocr/reconcile.js';
describe('computeAgreement', () => {
  it('returns 1 for single result', () => {
    expect(computeAgreement([{ text_md: 'hello world', confidence: 0.9 }])).toBe(1);
  });
  it('returns 1 for identical results', () => {
    const results = [{ text_md: 'hello world', confidence: 0.9 }, { text_md: 'hello world', confidence: 0.8 }];
    expect(computeAgreement(results)).toBe(1);
  });
  it('returns < 1 for different results', () => {
    const results = [{ text_md: 'hello world', confidence: 0.9 }, { text_md: 'completely different text here', confidence: 0.8 }];
    expect(computeAgreement(results)).toBeLessThan(1);
    expect(computeAgreement(results)).toBeGreaterThanOrEqual(0);
  });
  it('returns 0 for completely different results', () => {
    const results = [{ text_md: 'aaaaaaaaaa', confidence: 0.9 }, { text_md: 'bbbbbbbbbb', confidence: 0.8 }];
    expect(computeAgreement(results)).toBeLessThan(0.1);
  });
  it('ignores case and whitespace differences', () => {
    const results = [{ text_md: 'Hello  World', confidence: 0.9 }, { text_md: 'hello world', confidence: 0.8 }];
    expect(computeAgreement(results)).toBe(1);
  });
});

describe('reconcilePage — short-circuit paths (no API needed)', () => {
  const db = {}; // not used in short-circuit paths

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns empty result when no valid engine results', async () => {
    const result = await reconcilePage(db, 'https://example.com/doc.pdf', 1, '/tmp/fake.png', [], {});
    expect(result.text_md).toBe('');
    expect(result.agreement_score).toBe(0);
    expect(result.conversion_method).toBe('ocr+no-results');
  });

  it('returns single result directly when only one valid engine', async () => {
    const engineResults = [{ engine: 'tesseract', text_md: 'Hello world', confidence: 0.9 }];
    const result = await reconcilePage(db, 'https://example.com/doc.pdf', 1, '/tmp/fake.png', engineResults, {});
    expect(result.text_md).toBe('Hello world');
    expect(result.agreement_score).toBe(1);
    expect(result.conversion_method).toBe('ocr+single:tesseract');
  });

  it('filters out empty text_md results before processing', async () => {
    const engineResults = [
      { engine: 'tesseract', text_md: '', confidence: 0.9 },
      { engine: 'boss', text_md: 'Valid text here', confidence: 0.8 },
    ];
    const result = await reconcilePage(db, 'https://example.com/doc.pdf', 1, '/tmp/fake.png', engineResults, {});
    expect(result.text_md).toBe('Valid text here');
    expect(result.conversion_method).toBe('ocr+single:boss');
  });

  it('short-circuits with confidence-merge when agreement and confidence above thresholds', async () => {
    const engineResults = [
      { engine: 'tesseract', text_md: 'Hello world text', confidence: 0.95 },
      { engine: 'boss',      text_md: 'Hello world text', confidence: 0.93 },
    ];
    const result = await reconcilePage(db, 'https://example.com/doc.pdf', 1, '/tmp/fake.png', engineResults, {
      agreement_skip_threshold: 0.97,
      confidence_skip_threshold: 0.92,
    });
    expect(result.conversion_method).toBe('ocr+confidence-merge');
    expect(result.agreement_score).toBe(1);
  });

  it('uses vote mode when ocrConfig.mode is vote', async () => {
    const engineResults = [
      { engine: 'tesseract', text_md: 'Slightly different text A', confidence: 0.7 },
      { engine: 'boss',      text_md: 'Slightly different text B', confidence: 0.85 },
    ];
    const result = await reconcilePage(db, 'https://example.com/doc.pdf', 1, '/tmp/fake.png', engineResults, { mode: 'vote' });
    expect(result.conversion_method).toBe('ocr+vote');
    expect(result.text_md).toBe('Slightly different text B'); // boss has higher confidence
  });

  it('falls back to vote-fallback when no API key and agreement is low', async () => {
    const engineResults = [
      { engine: 'tesseract', text_md: 'Version one of the text that differs', confidence: 0.7 },
      { engine: 'boss',      text_md: 'Completely different text here entirely', confidence: 0.85 },
    ];
    const result = await reconcilePage(db, 'https://example.com/doc.pdf', 1, '/tmp/fake.png', engineResults, {});
    expect(result.conversion_method).toBe('ocr+vote-fallback');
    expect(result.text_md).toBe('Completely different text here entirely'); // boss wins by confidence
  });
});
