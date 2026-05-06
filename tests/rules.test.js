import { describe, it, expect } from 'vitest';
import { compileRules, applyClassifyOverride, applyFollowOverride, applyOcrOverride, stripQueryParams } from '../src/rules.js';
describe('compileRules', () => {
  it('compiles empty rules without error', () => {
    const compiled = compileRules({});
    expect(compiled.classify_overrides).toEqual([]);
    expect(compiled.exclude_selectors).toEqual([]);
  });
  it('compiles classify_overrides to RegExp', () => {
    const compiled = compileRules({ classify_overrides: [{ pattern: '/docs/.*', role: 'content' }] });
    expect(compiled.classify_overrides[0].pattern).toBeInstanceOf(RegExp);
  });
});
describe('applyClassifyOverride', () => {
  it('returns role for matching URL', () => {
    const compiled = compileRules({ classify_overrides: [{ pattern: '/blog/.*', role: 'content' }] });
    expect(applyClassifyOverride(compiled, 'https://example.com/blog/post')).toBe('content');
  });
  it('returns null for non-matching URL', () => {
    const compiled = compileRules({ classify_overrides: [{ pattern: '/blog/.*', role: 'content' }] });
    expect(applyClassifyOverride(compiled, 'https://example.com/about')).toBeNull();
  });
});
describe('applyFollowOverride', () => {
  it('returns false for no-follow pattern', () => {
    const compiled = compileRules({ follow_overrides: [{ pattern: '/admin/.*', follow: false }] });
    expect(applyFollowOverride(compiled, 'https://example.com/admin/users')).toBe(false);
  });
  it('returns null when no match', () => {
    const compiled = compileRules({ follow_overrides: [{ pattern: '/admin/.*', follow: false }] });
    expect(applyFollowOverride(compiled, 'https://example.com/docs')).toBeNull();
  });
});
describe('applyOcrOverride', () => {
  it('returns override config object for matching URL', () => {
    const compiled = compileRules({ ocr_overrides: [{ pattern: '/arabic/.*', language: 'ara', engines: ['tesseract'] }] });
    const result = applyOcrOverride(compiled, 'https://example.com/arabic/doc.pdf');
    // Returns the original rule object (minus the compiled pattern) — just check key fields
    expect(result).toBeDefined();
    expect(result.language).toBe('ara');
    expect(result.engines).toEqual(['tesseract']);
  });

  it('returns null when no pattern matches', () => {
    const compiled = compileRules({ ocr_overrides: [{ pattern: '/arabic/.*', language: 'ara' }] });
    expect(applyOcrOverride(compiled, 'https://example.com/english/doc.pdf')).toBeNull();
  });

  it('returns null for empty ocr_overrides', () => {
    const compiled = compileRules({});
    expect(applyOcrOverride(compiled, 'https://example.com/any.pdf')).toBeNull();
  });
});

describe('stripQueryParams', () => {
  it('strips listed query params', () => {
    const compiled = compileRules({ canonical_strip_query: ['utm_source', 'ref'] });
    const result = stripQueryParams(compiled, 'https://example.com/page?utm_source=email&id=5&ref=home');
    expect(result).toContain('id=5');
    expect(result).not.toContain('utm_source');
    expect(result).not.toContain('ref=home');
  });
  it('returns URL unchanged when no strip list', () => {
    const compiled = compileRules({});
    const url = 'https://example.com/page?foo=bar';
    expect(stripQueryParams(compiled, url)).toBe(url);
  });
  it('returns URL unchanged when strip list has no matching params', () => {
    const compiled = compileRules({ canonical_strip_query: ['utm_source'] });
    const url = 'https://example.com/page?id=5&category=news';
    expect(stripQueryParams(compiled, url)).toContain('id=5');
    expect(stripQueryParams(compiled, url)).toContain('category=news');
  });
  it('URL with no query string returns unchanged', () => {
    const compiled = compileRules({ canonical_strip_query: ['utm_source'] });
    const url = 'https://example.com/page';
    expect(stripQueryParams(compiled, url)).toBe(url);
  });
});

describe('applyFollowOverride', () => {
  it('returns true for follow:true pattern match', () => {
    const compiled = compileRules({ follow_overrides: [{ pattern: '/docs/.*', follow: true }] });
    expect(applyFollowOverride(compiled, 'https://example.com/docs/guide')).toBe(true);
  });
});
