// Tests for parseRssItems pure XML parser in fetch-adapters.js
import { describe, it, expect } from 'vitest';
import { parseRssItems } from '../src/fetch-adapters.js';

describe('parseRssItems', () => {
  it('returns empty array for empty XML', () => {
    expect(parseRssItems('')).toEqual([]);
  });

  it('returns empty array when no <item> elements', () => {
    expect(parseRssItems('<rss><channel><title>Blog</title></channel></rss>')).toEqual([]);
  });

  it('parses a single item with all fields', () => {
    const xml = `<rss><channel><item>
      <link>https://example.com/post-1/</link>
      <title>First Post</title>
      <pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate>
      <dc:creator>John Doe</dc:creator>
      <description>Short excerpt.</description>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://example.com/post-1/');
    expect(items[0].title).toBe('First Post');
    expect(items[0].pubDate).toBe('Mon, 01 Jan 2024 00:00:00 +0000');
    expect(items[0].author).toBe('John Doe');
    expect(items[0].description).toBe('Short excerpt.');
  });

  it('parses multiple items', () => {
    const xml = `<rss><channel>
      <item><link>https://example.com/a/</link><title>A</title></item>
      <item><link>https://example.com/b/</link><title>B</title></item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0].link).toBe('https://example.com/a/');
    expect(items[1].link).toBe('https://example.com/b/');
  });

  it('skips items with no link', () => {
    const xml = `<rss><channel>
      <item><title>No Link Post</title><description>No link</description></item>
      <item><link>https://example.com/valid/</link><title>Has Link</title></item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://example.com/valid/');
  });

  it('handles CDATA-wrapped fields', () => {
    const xml = `<rss><channel><item>
      <link>https://example.com/post/</link>
      <title><![CDATA[Post with <special> chars & entities]]></title>
      <description><![CDATA[<p>Rich <b>HTML</b> description.</p>]]></description>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Post with <special> chars & entities');
    expect(items[0].description).toContain('Rich');
  });

  it('returns empty strings for missing optional fields', () => {
    const xml = `<rss><channel><item>
      <link>https://example.com/minimal/</link>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('');
    expect(items[0].pubDate).toBe('');
    expect(items[0].author).toBe('');
    expect(items[0].description).toBe('');
  });

  it('handles multiline item content', () => {
    const xml = `<rss><channel><item>
      <link>
        https://example.com/multiline/
      </link>
      <title>
        Multiline Title
      </title>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    // trim() is applied to all extracted values
    expect(items[0].link).toBe('https://example.com/multiline/');
    expect(items[0].title).toBe('Multiline Title');
  });

  it('returns items as array with link, title, pubDate, author, description keys', () => {
    const xml = `<rss><channel><item>
      <link>https://example.com/p/</link>
      <title>Test</title>
    </item></channel></rss>`;
    const [item] = parseRssItems(xml);
    expect(item).toHaveProperty('link');
    expect(item).toHaveProperty('title');
    expect(item).toHaveProperty('pubDate');
    expect(item).toHaveProperty('author');
    expect(item).toHaveProperty('description');
  });
});
