import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../src/metadata.js';
const html = (body) => `<!DOCTYPE html><html lang="en"><head>${body}</head><body><h1>Fallback Title</h1></body></html>`;
describe('extractMetadata', () => {
  it('extracts title from JSON-LD headline', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","headline":"Test Article"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.title).toBe('Test Article');
    expect(meta.title_source).toBe('json_ld');
  });
  it('falls back to og:title', () => {
    const page = html('<meta property="og:title" content="OG Title">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.title).toBe('OG Title');
    expect(meta.title_source).toBe('og');
  });
  it('falls back to h1', () => {
    const page = html('');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.title).toBe('Fallback Title');
    expect(meta.title_source).toBe('h1');
  });
  it('extracts authors from JSON-LD', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Jane Doe","url":"https://example.com/jane"}}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors[0].name).toBe('Jane Doe');
    expect(meta.authors[0].url).toBe('https://example.com/jane');
  });
  it('extracts language from html lang attribute', () => {
    const meta = extractMetadata(html(''), 'https://example.com/test');
    expect(meta.language).toBe('en');
  });
  it('extracts keywords from meta tags', () => {
    const page = html('<meta name="keywords" content="foo, bar, baz">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.keywords).toContain('foo');
    expect(meta.keywords).toContain('bar');
  });
  it('extracts date_published from JSON-LD', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","datePublished":"2024-01-15"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.date_published).toMatch(/^2024-01-15/);
  });
});
