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
  // New regression tests
  it('malformed JSON in ld+json block returns null title_source json_ld, no throw', () => {
    const page = html('<script type="application/ld+json">{not valid json}</script>');
    let meta;
    expect(() => { meta = extractMetadata(page, 'https://example.com/test'); }).not.toThrow();
    // Falls back past JSON-LD since it failed to parse
    expect(meta.title_source).not.toBe('json_ld');
    expect(meta.title).toBeTruthy(); // still has a title from fallback chain
  });
  it('multiple JSON-LD blocks -- first matching Article type wins', () => {
    const page = html(`
      <script type="application/ld+json">{"@type":"BreadcrumbList","name":"ignored"}</script>
      <script type="application/ld+json">{"@type":"Article","headline":"Real Article"}</script>
    `);
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.title).toBe('Real Article');
    expect(meta.title_source).toBe('json_ld');
  });
  it('date_published with invalid date string returns null, no throw', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","headline":"X","datePublished":"not-a-date"}</script>');
    let meta;
    expect(() => { meta = extractMetadata(page, 'https://example.com/test'); }).not.toThrow();
    expect(meta.date_published).toBeNull();
  });
  it('lang="en-US" returns "en" (split on hyphen)', () => {
    const page = `<!DOCTYPE html><html lang="en-US"><head></head><body><h1>Title</h1></body></html>`;
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.language).toBe('en');
  });
  it('canonical link wins over og:url', () => {
    const page = html(`
      <link rel="canonical" href="https://example.com/canonical-path">
      <meta property="og:url" content="https://example.com/og-path">
    `);
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.canonical_url).toBe('https://example.com/canonical-path');
  });
});
