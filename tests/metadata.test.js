import { describe, it, expect } from 'vitest';
import { extractMetadata, normDate, parseAuthors, findJsonLd } from '../src/metadata.js';
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

  it('extracts author from meta[name="author"]', () => {
    const page = html('<meta name="author" content="Jane Doe">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors).toHaveLength(1);
    expect(meta.authors[0].name).toBe('Jane Doe');
  });

  it('extracts keywords from JSON-LD', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","headline":"X","keywords":["history","religion"]}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.keywords).toContain('history');
    expect(meta.keywords).toContain('religion');
  });

  it('extracts schema_org_type from JSON-LD @type', () => {
    const page = html('<script type="application/ld+json">{"@type":"NewsArticle","headline":"Breaking News"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.schema_org_type).toBe('NewsArticle');
  });

  it('uses httpHeaders last-modified as fallback for date_published', () => {
    const page = html('<title>No Date Article</title>');
    const meta = extractMetadata(page, 'https://example.com/test', { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' });
    expect(meta.date_published).not.toBeNull();
  });

  it('title_source is "meta" when <title> is used', () => {
    const page = `<!DOCTYPE html><html><head><title>Meta Title</title></head><body></body></html>`;
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.title).toBe('Meta Title');
    expect(meta.title_source).toBe('meta');
  });

  it('uses JSON-LD name when headline is absent', () => {
    const page = html('<script type="application/ld+json">{"@type":"WebPage","name":"Page Name"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.title).toBe('Page Name');
    expect(meta.title_source).toBe('json_ld');
  });

  it('title_source is "filename" when no title found in HTML', () => {
    const page = `<!DOCTYPE html><html><head></head><body></body></html>`;
    const meta = extractMetadata(page, 'https://example.com/my-article');
    expect(meta.title).toBe('my-article');
    expect(meta.title_source).toBe('filename');
  });

  it('extracts author from .byline element', () => {
    const page = html('<div class="byline">Jane Smith</div>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors).toHaveLength(1);
    expect(meta.authors[0].name).toBe('Jane Smith');
  });

  it('extracts date_modified from article:modified_time meta', () => {
    const page = html('<meta property="article:modified_time" content="2024-06-15T12:00:00Z">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.date_modified).toMatch(/^2024-06-15/);
  });

  it('extracts author from meta[name="DC.Creator"]', () => {
    const page = html('<meta name="DC.Creator" content="Dublin Core Author">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors).toHaveLength(1);
    expect(meta.authors[0].name).toBe('Dublin Core Author');
  });

  it('extracts multiple authors from JSON-LD author array', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","headline":"X","author":[{"@type":"Person","name":"Alice"},{"@type":"Person","name":"Bob"}]}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors).toHaveLength(2);
    expect(meta.authors[0].name).toBe('Alice');
    expect(meta.authors[1].name).toBe('Bob');
  });

  it('extracts author from JSON-LD when author is a plain string', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","headline":"X","author":"String Author"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors).toHaveLength(1);
    expect(meta.authors[0].name).toBe('String Author');
  });

  it('schema_org_type with @type array returns first element', () => {
    const page = html('<script type="application/ld+json">{"@type":["Article","NewsArticle"],"headline":"Multi-Type"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.schema_org_type).toBe('Article');
  });

  it('extracts date_modified from JSON-LD dateModified', () => {
    const page = html('<script type="application/ld+json">{"@type":"Article","headline":"X","dateModified":"2024-03-10T09:00:00Z"}</script>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.date_modified).toMatch(/^2024-03-10/);
  });

  it('extracts author from [rel="author"] element', () => {
    const page = html('<a rel="author" href="/author/jane">Jane Author</a>');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.authors).toHaveLength(1);
    expect(meta.authors[0].name).toBe('Jane Author');
  });

  it('canonical_url falls back to pageUrl when no canonical or og:url', () => {
    const page = html('');
    const meta = extractMetadata(page, 'https://example.com/fallback-url');
    expect(meta.canonical_url).toBe('https://example.com/fallback-url');
  });

  it('og:url used as canonical when no link[rel=canonical] present', () => {
    const page = html('<meta property="og:url" content="https://example.com/og-canonical">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.canonical_url).toBe('https://example.com/og-canonical');
  });

  it('language is null when html element has no lang attribute', () => {
    const page = `<!DOCTYPE html><html><head></head><body><h1>No lang</h1></body></html>`;
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.language).toBeNull();
  });

  it('date_published extracted from article:published_time meta tag', () => {
    const page = html('<meta property="article:published_time" content="2024-09-20T10:00:00Z">');
    const meta = extractMetadata(page, 'https://example.com/test');
    expect(meta.date_published).toMatch(/^2024-09-20/);
  });

  it('date_modified falls back to httpHeaders last-modified when no other source', () => {
    const page = html('');
    const meta = extractMetadata(page, 'https://example.com/test', { 'last-modified': 'Wed, 15 May 2024 08:00:00 GMT' });
    expect(meta.date_modified).toMatch(/^2024-05-15/);
  });
});

describe('normDate', () => {
  it('returns null for null input', () => {
    expect(normDate(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normDate('')).toBeNull();
  });

  it('returns null for invalid date string', () => {
    expect(normDate('not-a-date')).toBeNull();
  });

  it('normalizes ISO date to ISO string', () => {
    const result = normDate('2024-01-15');
    expect(result).toMatch(/^2024-01-15T/);
  });

  it('normalizes long form date', () => {
    const result = normDate('January 15, 2024');
    expect(result).toMatch(/^2024-01-15T/);
  });

  it('returns ISO string (includes T and Z/offset)', () => {
    const result = normDate('2023-06-01T12:00:00Z');
    expect(result).toContain('T');
    expect(typeof result).toBe('string');
  });
});

describe('parseAuthors', () => {
  it('returns empty array for null/undefined input', () => {
    expect(parseAuthors(null)).toEqual([]);
    expect(parseAuthors(undefined)).toEqual([]);
  });

  it('parses string author', () => {
    expect(parseAuthors('John Smith')).toEqual([{ name: 'John Smith' }]);
  });

  it('parses array of string authors', () => {
    const result = parseAuthors(['Alice', 'Bob']);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Alice');
    expect(result[1].name).toBe('Bob');
  });

  it('parses JSON-LD Person object', () => {
    const result = parseAuthors({ name: 'Jane Doe', url: 'https://example.com/jane' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Jane Doe');
    expect(result[0].url).toBe('https://example.com/jane');
  });

  it('parses JSON-LD with jobTitle and organization', () => {
    const result = parseAuthors({ name: 'Dr. Smith', jobTitle: 'Professor', worksFor: { name: 'MIT' } });
    expect(result[0].job_title).toBe('Professor');
    expect(result[0].organization).toBe('MIT');
  });

  it('filters out entries with no name', () => {
    const result = parseAuthors([{ jobTitle: 'Editor' }, { name: 'Real Author' }]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Real Author');
  });
});

describe('findJsonLd', () => {
  it('returns undefined for empty items array', () => {
    expect(findJsonLd([], 'Article')).toBeUndefined();
  });

  it('finds item with matching @type string', () => {
    const items = [{ '@type': 'Person', name: 'Alice' }, { '@type': 'Article', headline: 'News' }];
    expect(findJsonLd(items, 'Article')).toEqual({ '@type': 'Article', headline: 'News' });
  });

  it('finds first match when multiple types requested', () => {
    const items = [{ '@type': 'NewsArticle', headline: 'Breaking' }];
    expect(findJsonLd(items, 'Article', 'NewsArticle')).toEqual(items[0]);
  });

  it('finds item when @type is an array', () => {
    const items = [{ '@type': ['CreativeWork', 'Article'], title: 'T' }];
    expect(findJsonLd(items, 'Article')).toBe(items[0]);
  });

  it('returns undefined when no type matches', () => {
    const items = [{ '@type': 'Person', name: 'Bob' }];
    expect(findJsonLd(items, 'Article')).toBeUndefined();
  });

  it('returns first match when multiple items match', () => {
    const items = [{ '@type': 'Article', n: 1 }, { '@type': 'Article', n: 2 }];
    expect(findJsonLd(items, 'Article').n).toBe(1);
  });
});
