import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeAgreement, reconcilePage, levenshtein, agreementScore, pickBestEngine, buildReconcilerPrompt } from '../../src/ocr/reconcile.js';
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

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns 1 for completely different strings of same length', () => {
    expect(levenshtein('abc', 'xyz')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns 1 when one string is empty', () => {
    expect(levenshtein('abc', '')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(1);
  });

  it('computes normalized distance (length-divided)', () => {
    // 'kitten' → 'sitting': 3 edits / 7 chars (max of 6,7) = 3/7
    const d = levenshtein('kitten', 'sitting');
    expect(d).toBeCloseTo(3 / 7, 5);
  });

  it('returns value in [0,1] range', () => {
    const d = levenshtein('abcdef', 'xyz');
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });
});

describe('agreementScore', () => {
  it('returns 1 for identical strings', () => {
    expect(agreementScore('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for same string with different casing', () => {
    expect(agreementScore('Hello World', 'hello world')).toBe(1);
  });

  it('returns 1 for same string with different whitespace', () => {
    expect(agreementScore('hello  world', 'hello world')).toBe(1);
  });

  it('returns less than 1 for different strings', () => {
    expect(agreementScore('hello world', 'goodbye cruel world')).toBeLessThan(1);
  });

  it('returns value in [0,1] range', () => {
    const score = agreementScore('completely different text here', 'xyzxyzxyz');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('pickBestEngine', () => {
  it('returns the single result when only one provided', () => {
    const results = [{ engine: 'tesseract', text_md: 'text', confidence: 0.9 }];
    expect(pickBestEngine(results)).toBe(results[0]);
  });

  it('picks highest confidence result', () => {
    const results = [
      { engine: 'tesseract', text_md: 'lower', confidence: 0.7 },
      { engine: 'claude', text_md: 'higher', confidence: 0.95 },
      { engine: 'mistral', text_md: 'middle', confidence: 0.85 },
    ];
    expect(pickBestEngine(results).engine).toBe('claude');
  });

  it('returns first element when all have equal confidence', () => {
    const results = [
      { engine: 'a', text_md: 'x', confidence: 0.9 },
      { engine: 'b', text_md: 'y', confidence: 0.9 },
    ];
    expect(pickBestEngine(results).engine).toBe('a');
  });
});

describe('buildReconcilerPrompt', () => {
  const engines = [
    { engine: 'tesseract', text_md: 'Hello world', confidence: 0.85 },
    { engine: 'claude',    text_md: 'Hello World', confidence: 0.95 },
  ];

  it('returns a non-empty string', () => {
    const prompt = buildReconcilerPrompt(engines, false);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes engine names in the prompt', () => {
    const prompt = buildReconcilerPrompt(engines, false);
    expect(prompt).toContain('tesseract');
    expect(prompt).toContain('claude');
  });

  it('includes transcripts in the prompt', () => {
    const prompt = buildReconcilerPrompt(engines, false);
    expect(prompt).toContain('Hello world');
    expect(prompt).toContain('Hello World');
  });

  it('excludes bboxes when passBboxes is false', () => {
    const enginesWithBboxes = engines.map(e => ({ ...e, bboxes_json: '[{"x":0,"y":0}]' }));
    const prompt = buildReconcilerPrompt(enginesWithBboxes, false);
    expect(prompt).not.toContain('"x":0');
  });

  it('includes bboxes when passBboxes is true and bboxes_json present', () => {
    const enginesWithBboxes = [
      { engine: 'tesseract', text_md: 'Text', confidence: 0.8, bboxes_json: '[{"x":1}]' },
    ];
    const prompt = buildReconcilerPrompt(enginesWithBboxes, true);
    expect(prompt).toContain('"x":1');
  });

  it('requests JSON output format', () => {
    const prompt = buildReconcilerPrompt(engines, false);
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('agreement_score');
  });
});
