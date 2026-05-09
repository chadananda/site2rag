import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as cheerio from 'cheerio';

const testRoot = join(tmpdir(), `site2rag-mirror-crawl-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { urlToMirrorPath, urlPathToSlug, inScope, parseRobots, extractLinks } from '../src/mirror-crawl.js';

const DOMAIN = 'crawl.example.com';

beforeEach(() => mkdirSync(testRoot, { recursive: true }));
afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

describe('urlToMirrorPath', () => {
  it('appends index.html for root URL', () => {
    const result = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/`);
    expect(result).toContain('index.html');
  });

  it('appends index.html for path-only URL (no extension)', () => {
    const result = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/about`);
    expect(result).toContain('index.html');
  });

  it('preserves file extension for non-index paths', () => {
    const result = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/report.pdf`);
    expect(result).toContain('report.pdf');
  });

  it('appends query hash suffix when URL has search params', () => {
    const withQuery = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/page.html?foo=bar`);
    const withoutQuery = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/page.html`);
    expect(withQuery).not.toBe(withoutQuery);
    // The __hash part should appear before the extension
    expect(withQuery).toMatch(/__[0-9a-f]{4}\.html$/);
  });

  it('different query strings produce different paths', () => {
    const p1 = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/page.html?a=1`);
    const p2 = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/page.html?a=2`);
    expect(p1).not.toBe(p2);
  });

  it('truncates extremely long filenames to avoid ENAMETOOLONG', () => {
    const longName = 'a'.repeat(300);
    const result = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/${longName}.html`);
    const filename = result.split('/').pop();
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(200);
  });

  it('includes domain mirror dir in path', () => {
    const result = urlToMirrorPath(DOMAIN, `https://${DOMAIN}/page.html`);
    expect(result).toContain(DOMAIN);
  });
});

describe('urlPathToSlug', () => {
  it('converts simple path to slug', () => {
    expect(urlPathToSlug('/about')).toBe('about');
  });

  it('converts nested path to slug with dashes', () => {
    expect(urlPathToSlug('/blog/post-title')).toBe('blog-post-title');
  });

  it('strips file extension', () => {
    expect(urlPathToSlug('/page.html')).toBe('page');
  });

  it('returns index for root path', () => {
    expect(urlPathToSlug('/')).toBe('index');
  });

  it('handles empty string', () => {
    expect(urlPathToSlug('')).toBe('index');
  });

  it('replaces multiple slashes with dashes', () => {
    expect(urlPathToSlug('/a/b/c.html')).toBe('a-b-c');
  });
});

describe('inScope', () => {
  const seedHost = DOMAIN;

  it('accepts URL on same domain', () => {
    expect(inScope(`https://${DOMAIN}/page`, { same_domain_only: true }, seedHost)).toBe(true);
  });

  it('rejects URL on different domain when same_domain_only=true', () => {
    expect(inScope('https://other.com/page', { same_domain_only: true }, seedHost)).toBe(false);
  });

  it('accepts URL on different domain when same_domain_only=false', () => {
    expect(inScope('https://other.com/page', { same_domain_only: false }, seedHost)).toBe(true);
  });

  it('accepts URL in allow_domains even when same_domain_only=true', () => {
    expect(inScope('https://allowed.com/page', { same_domain_only: true, allow_domains: ['allowed.com'] }, seedHost)).toBe(true);
  });

  it('rejects URL matching exclude prefix', () => {
    expect(inScope(`https://${DOMAIN}/private/secret`, { exclude: ['/private/'] }, seedHost)).toBe(false);
  });

  it('accepts URL not matching any exclude prefix', () => {
    expect(inScope(`https://${DOMAIN}/public/page`, { exclude: ['/private/'] }, seedHost)).toBe(true);
  });

  it('accepts URL matching include prefix when include list set', () => {
    expect(inScope(`https://${DOMAIN}/docs/page`, { include: ['/docs/'] }, seedHost)).toBe(true);
  });

  it('rejects URL not matching include prefix when include list set', () => {
    expect(inScope(`https://${DOMAIN}/blog/post`, { include: ['/docs/'] }, seedHost)).toBe(false);
  });

  it('returns false for malformed URL', () => {
    expect(inScope('not-a-url', {}, seedHost)).toBe(false);
  });

  it('exclude wins over include when URL matches both', () => {
    // URL matches include=/docs/ AND exclude=/docs/private/ — exclude takes precedence
    const url = `https://${DOMAIN}/docs/private/secret`;
    expect(inScope(url, { include: ['/docs/'], exclude: ['/docs/private/'] }, seedHost)).toBe(false);
  });
});

describe('parseRobots', () => {
  it('returns empty set for null/empty input', () => {
    expect(parseRobots(null, 'site2rag').size).toBe(0);
    expect(parseRobots('', 'site2rag').size).toBe(0);
  });

  it('parses Disallow for wildcard user-agent', () => {
    const robots = 'User-agent: *\nDisallow: /private/\n';
    const disallowed = parseRobots(robots, 'site2rag');
    expect(disallowed.has('/private/')).toBe(true);
  });

  it('parses multiple Disallow lines', () => {
    const robots = 'User-agent: *\nDisallow: /admin/\nDisallow: /tmp/\n';
    const disallowed = parseRobots(robots, 'site2rag');
    expect(disallowed.has('/admin/')).toBe(true);
    expect(disallowed.has('/tmp/')).toBe(true);
  });

  it('ignores Disallow for irrelevant user-agents', () => {
    const robots = 'User-agent: googlebot\nDisallow: /secret/\n';
    const disallowed = parseRobots(robots, 'site2rag');
    expect(disallowed.has('/secret/')).toBe(false);
  });

  it('matches site2rag-specific user-agent block', () => {
    const robots = 'User-agent: site2rag\nDisallow: /crawl-block/\n';
    const disallowed = parseRobots(robots, 'site2rag');
    expect(disallowed.has('/crawl-block/')).toBe(true);
  });

  it('ignores empty Disallow lines', () => {
    const robots = 'User-agent: *\nDisallow:\n';
    const disallowed = parseRobots(robots, 'site2rag');
    expect(disallowed.size).toBe(0);
  });

  it('matches site2rag user-agent case-insensitively (Site2RAG should match)', () => {
    const robots = 'User-agent: Site2RAG\nDisallow: /case-test/\n';
    const disallowed = parseRobots(robots, 'site2rag');
    expect(disallowed.has('/case-test/')).toBe(true);
  });
});

describe('extractLinks', () => {
  const BASE = `https://${DOMAIN}`;

  it('extracts absolute href links', () => {
    const $ = cheerio.load(`<a href="${BASE}/page1">link</a>`);
    expect(extractLinks($, BASE)).toContain(`${BASE}/page1`);
  });

  it('resolves relative href links against base URL', () => {
    const $ = cheerio.load('<a href="/about">about</a>');
    const links = extractLinks($, BASE);
    expect(links).toContain(`${BASE}/about`);
  });

  it('strips URL fragments', () => {
    const $ = cheerio.load(`<a href="${BASE}/page#section">link</a>`);
    const links = extractLinks($, BASE);
    expect(links).toContain(`${BASE}/page`);
    expect(links.every(l => !l.includes('#'))).toBe(true);
  });

  it('ignores mailto: links', () => {
    const $ = cheerio.load('<a href="mailto:test@example.com">email</a>');
    expect(extractLinks($, BASE)).toHaveLength(0);
  });

  it('ignores javascript: links', () => {
    const $ = cheerio.load('<a href="javascript:void(0)">js</a>');
    expect(extractLinks($, BASE)).toHaveLength(0);
  });

  it('ignores anchor-only links', () => {
    const $ = cheerio.load('<a href="#top">top</a>');
    expect(extractLinks($, BASE)).toHaveLength(0);
  });

  it('ignores data: links', () => {
    const $ = cheerio.load('<a href="data:text/html,<h1>hi</h1>">data</a>');
    expect(extractLinks($, BASE)).toHaveLength(0);
  });

  it('extracts multiple links', () => {
    const $ = cheerio.load(`<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`);
    const links = extractLinks($, BASE);
    expect(links).toHaveLength(3);
  });

  it('handles spaces in href by percent-encoding', () => {
    const $ = cheerio.load('<a href="/path with spaces">link</a>');
    const links = extractLinks($, BASE);
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toContain('%20');
  });
});
