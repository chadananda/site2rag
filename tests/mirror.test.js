import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { urlToMirrorPath, urlPathToSlug, inScope, parseRobots, extractLinks } from '../src/mirror.js';
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
describe('urlToMirrorPath truncation', () => {
  it('filename exactly 200 UTF-8 bytes is NOT truncated', () => {
    // Build a filename that is exactly 200 ASCII bytes (200 chars) with .html extension
    // Total: 196-char base + ".html" = 201 chars... we want last segment = 200 bytes
    // Use 195 'a' chars + ".html" = 200 bytes exactly
    const name = 'a'.repeat(195) + '.html';
    expect(Buffer.byteLength(name, 'utf8')).toBe(200);
    const url = `https://example.com/${name}`;
    const p = urlToMirrorPath('example.com', url);
    // Should preserve the original name (not hashed), since 200 bytes is not > 200
    expect(p).toContain(name);
  });
  it('filename of 201 UTF-8 bytes IS truncated to a hash', () => {
    // 196 'a' chars + ".html" = 201 bytes
    const name = 'a'.repeat(196) + '.html';
    expect(Buffer.byteLength(name, 'utf8')).toBe(201);
    const url = `https://example.com/${name}`;
    const p = urlToMirrorPath('example.com', url);
    // Truncated: last segment should be a 12-char hex hash + ".html", not the original name
    const lastSeg = p.split('/').at(-1);
    expect(lastSeg).toMatch(/^[0-9a-f]{12}\.html$/);
  });
  it('multibyte chars (emoji) in filename produce valid UTF-8 path after truncation', () => {
    // Each emoji is 4 bytes in UTF-8. 51 emojis = 204 bytes > 200 -- triggers truncation
    const emoji = '\u{1F600}'; // 4 bytes
    const name = emoji.repeat(51) + '.html';
    expect(Buffer.byteLength(name, 'utf8')).toBeGreaterThan(200);
    const url = `https://example.com/path/${name}`;
    const p = urlToMirrorPath('example.com', url);
    // After truncation, path must be valid (not end mid-character)
    expect(() => Buffer.from(p, 'utf8').toString('utf8')).not.toThrow();
    const lastSeg = p.split('/').at(-1);
    // Truncated to hash form
    expect(lastSeg).toMatch(/^[0-9a-f]{12}\.html$/);
  });
});
describe('inScope', () => {
  it('different hostname with sameDomain=true returns false', () => {
    expect(inScope('https://other.com/page', { same_domain_only: true }, 'example.com')).toBe(false);
  });
  it('different hostname with sameDomain=false returns true', () => {
    expect(inScope('https://other.com/page', { same_domain_only: false }, 'example.com')).toBe(true);
  });
  it('excluded path prefix returns false', () => {
    expect(inScope('https://example.com/admin/page', { exclude: ['/admin/'] }, 'example.com')).toBe(false);
  });
  it('include list -- URL not matching returns false', () => {
    expect(inScope('https://example.com/about', { include: ['/docs/'] }, 'example.com')).toBe(false);
  });
  it('include list -- matching URL returns true', () => {
    expect(inScope('https://example.com/docs/api', { include: ['/docs/'] }, 'example.com')).toBe(true);
  });
  it('malformed URL returns false without throwing', () => {
    expect(inScope('not a url', {}, 'example.com')).toBe(false);
  });
});
describe('parseRobots', () => {
  it('matches User-agent: Site2RAG (mixed case)', () => {
    const txt = 'User-agent: Site2RAG\nDisallow: /secret/\n';
    const disallowed = parseRobots(txt, 'site2rag/1.0');
    expect(disallowed.has('/secret/')).toBe(true);
  });
  it('does not pick up rules for unrelated agents', () => {
    const txt = 'User-agent: Googlebot\nDisallow: /noindex/\n\nUser-agent: *\nDisallow: /private/\n';
    const disallowed = parseRobots(txt, 'site2rag/1.0');
    expect(disallowed.has('/noindex/')).toBe(false);
    // Star agent is still matched
    expect(disallowed.has('/private/')).toBe(true);
  });
  it('empty robots.txt returns empty set', () => {
    expect(parseRobots('', 'site2rag/1.0').size).toBe(0);
  });
  it('whitespace-only robots.txt returns empty set', () => {
    expect(parseRobots('   \n  \n  ', 'site2rag/1.0').size).toBe(0);
  });
});
describe('extractLinks', () => {
  it('excludes javascript:void(0) hrefs', () => {
    const $ = cheerio.load('<a href="javascript:void(0)">click</a>');
    const links = extractLinks($, 'https://example.com/');
    expect(links).toHaveLength(0);
  });
  it('excludes mailto: hrefs', () => {
    const $ = cheerio.load('<a href="mailto:user@example.com">mail</a>');
    const links = extractLinks($, 'https://example.com/');
    expect(links).toHaveLength(0);
  });
  it('excludes data: URI hrefs', () => {
    const $ = cheerio.load('<a href="data:text/html,<h1>hi</h1>">data</a>');
    const links = extractLinks($, 'https://example.com/');
    // data: URIs should be excluded (new URL('data:...', base) won't throw but produces a non-http URL)
    // The current impl doesn't explicitly exclude data:, but new URL resolution and the filter might handle it.
    // Test the actual behavior: if data: links leak through they'd cause crawl issues.
    const dataLinks = links.filter(l => l.startsWith('data:'));
    expect(dataLinks).toHaveLength(0);
  });
  it('resolves relative links against base URL', () => {
    const $ = cheerio.load('<a href="/docs/api">API</a>');
    const links = extractLinks($, 'https://example.com/');
    expect(links).toContain('https://example.com/docs/api');
  });
  it('strips fragment from resolved links', () => {
    const $ = cheerio.load('<a href="/page#section">link</a>');
    const links = extractLinks($, 'https://example.com/');
    expect(links).toContain('https://example.com/page');
    expect(links.some(l => l.includes('#'))).toBe(false);
  });
});
