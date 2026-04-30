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
});
