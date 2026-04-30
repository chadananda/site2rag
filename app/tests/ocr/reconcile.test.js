import { describe, it, expect } from 'vitest';
import { computeAgreement } from '../../src/ocr/reconcile.js';
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
