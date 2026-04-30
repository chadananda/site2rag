import { describe, it, expect } from 'vitest';
import { urlToMirrorPath, urlPathToSlug } from '../src/mirror.js';
describe('urlToMirrorPath', () => {
  it('maps simple URL to path', () => {
    const p = urlToMirrorPath('docs.python.org', 'https://docs.python.org/3/library/asyncio.html');
    expect(p).toContain('docs.python.org');
    expect(p).toContain('3/library/asyncio.html');
  });
  it('appends index.html for trailing slash', () => {
    const p = urlToMirrorPath('example.com', 'https://example.com/docs/');
    expect(p).toContain('index.html');
  });
  it('appends index.html for no extension', () => {
    const p = urlToMirrorPath('example.com', 'https://example.com/about');
    expect(p).toContain('index.html');
  });
  it('hashes query string into filename', () => {
    const p1 = urlToMirrorPath('example.com', 'https://example.com/page.html?id=42');
    const p2 = urlToMirrorPath('example.com', 'https://example.com/page.html?id=99');
    expect(p1).not.toBe(p2);
    expect(p1).toMatch(/__[0-9a-f]{4}\.html$/);
  });
  it('is deterministic (same URL same path)', () => {
    const url = 'https://example.com/page.html?id=42';
    expect(urlToMirrorPath('example.com', url)).toBe(urlToMirrorPath('example.com', url));
  });
  it('preserves PDF extension at native path', () => {
    const p = urlToMirrorPath('example.com', 'https://example.com/docs/report.pdf');
    expect(p).toContain('report.pdf');
  });
});
describe('urlPathToSlug', () => {
  it('converts slashes to hyphens', () => {
    expect(urlPathToSlug('/docs/api/index.html')).toBe('docs-api-index');
  });
  it('strips leading slash', () => {
    expect(urlPathToSlug('/about')).toBe('about');
  });
  it('returns index for root path', () => {
    expect(urlPathToSlug('/')).toBe('index');
  });
});
