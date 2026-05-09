// Tests for playwright-fetch.js pure utility functions. No browser launched.
import { describe, it, expect } from 'vitest';
import { extractTextWordCount, isHtmlShell, isWorthRendering } from '../src/playwright-fetch.js';

describe('extractTextWordCount', () => {
  it('counts words in plain text', () => {
    expect(extractTextWordCount('Hello world foo')).toBe(3);
  });

  it('strips HTML tags before counting', () => {
    const html = '<p>Hello <strong>world</strong> foo</p>';
    expect(extractTextWordCount(html)).toBe(3);
  });

  it('strips script tags and their content', () => {
    const html = '<p>Real content here today.</p><script>var x = "hidden script words lots";</script>';
    expect(extractTextWordCount(html)).toBe(4);
  });

  it('strips style tags and their content', () => {
    const html = '<p>Real content here today.</p><style>.foo { color: red; background: blue; }</style>';
    expect(extractTextWordCount(html)).toBe(4);
  });

  it('filters words shorter than 3 characters', () => {
    // 'hi', 'a', 'is' are ≤2 chars, only 'hello', 'world' count
    expect(extractTextWordCount('hello world hi a is')).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(extractTextWordCount('')).toBe(0);
  });

  it('returns 0 for only tags', () => {
    expect(extractTextWordCount('<div><span></span></div>')).toBe(0);
  });
});

describe('isHtmlShell', () => {
  it('returns true for minimal HTML (under 100 meaningful words)', () => {
    const shell = '<html><body><div id="app"></div></body></html>';
    expect(isHtmlShell(shell)).toBe(true);
  });

  it('returns false for content-rich HTML (100+ meaningful words)', () => {
    const words = Array(120).fill('word').join(' ');
    const html = `<html><body><article>${words}</article></body></html>`;
    expect(isHtmlShell(html)).toBe(false);
  });

  it('treats inline script-heavy page as shell', () => {
    // Large script content should not be counted
    const script = `<script>${'var x = 1;'.repeat(100)}</script>`;
    const html = `<html><body>${script}<p>Just few words here now.</p></body></html>`;
    expect(isHtmlShell(html)).toBe(true);
  });
});

describe('isWorthRendering', () => {
  it('returns false when rendered has less content than static', () => {
    const staticHtml = Array(200).fill('word').join(' ');
    const renderedHtml = Array(100).fill('word').join(' ');
    expect(isWorthRendering(staticHtml, renderedHtml)).toBe(false);
  });

  it('returns false when rendered is only slightly more than static', () => {
    // ratio must be > 3x AND rendered > 100 words
    const staticHtml = Array(100).fill('word').join(' ');
    const renderedHtml = Array(150).fill('word').join(' '); // 1.5x, not 3x
    expect(isWorthRendering(staticHtml, renderedHtml)).toBe(false);
  });

  it('returns true when rendered has 3x+ more content than static and > 100 words', () => {
    const staticHtml = Array(20).fill('word').join(' ');
    const renderedHtml = Array(200).fill('word').join(' '); // 10x more
    expect(isWorthRendering(staticHtml, renderedHtml)).toBe(true);
  });

  it('returns false when rendered is 3x but under 100 words threshold', () => {
    const staticHtml = Array(5).fill('word').join(' ');
    const renderedHtml = Array(20).fill('word').join(' '); // 4x but only 20 words
    expect(isWorthRendering(staticHtml, renderedHtml)).toBe(false);
  });

  it('returns true for shell static (0 words) with large rendered output', () => {
    const staticHtml = '<html><body><div id="app"></div></body></html>';
    const renderedHtml = Array(200).fill('word').join(' ');
    expect(isWorthRendering(staticHtml, renderedHtml)).toBe(true);
  });
});
