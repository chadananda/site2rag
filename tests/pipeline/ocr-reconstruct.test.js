// Tests for ocr-reconstruct.js: markHeadersFooters, bboxWordsToText, reconstructFromOcrPages
import { describe, it, expect } from 'vitest';
import {
  markHeadersFooters,
  bboxWordsToText,
  reconstructFromOcrPages,
  median,
  groupIntoLines,
} from '../../src/pdf-upgrade/ocr-reconstruct.js';

/** Build a word object with a simple bbox. */
const w = (text, x0, y0, x1, y1, extra = {}) => ({ text, bbox: { x0, y0, x1, y1 }, conf: 90, ...extra });

/** Build a page from word definitions and a pageNo. */
const page = (words, pageNo = 1) => ({ words, pageNo });

describe('markHeadersFooters', () => {
  it('marks words that repeat in header zone across multiple pages', () => {
    // Page is ~800px tall: body words at y0=100, y1=120.
    // pageHeight=max(y1) = 120 but we need to anchor bottom with a tall word.
    // Simplest: use explicit large page + header words clearly in top 8%.
    // header at y0=0, y1=50; body at y0=400, y1=420; page bottom word at y0=740, y1=760 → pageHeight=760
    // headerY = 760 * 0.08 = 60.8 → words with y1<=60 in header zone ✓
    const hWord = (text) => w(text, 0, 0, 100, 50);
    const body = (text) => w(text, 0, 400, 100, 420);
    const bottomAnchor = () => w('_', 0, 740, 10, 760); // anchors page height
    const pages = [
      page([hWord('Chapter'), body('content'), bottomAnchor()], 1),
      page([hWord('Chapter'), body('more'), bottomAnchor()], 2),
    ];
    markHeadersFooters(pages, { headerZone: 0.08 });
    expect(pages[0].words[0].isHeader).toBe(true);
    expect(pages[1].words[0].isHeader).toBe(true);
    // Body words should NOT be marked
    expect(pages[0].words[1].isHeader).toBeUndefined();
  });

  it('does NOT mark header zone words that appear on only one page', () => {
    const bottomAnchor = () => w('_', 0, 740, 10, 760);
    const pages = [
      page([w('Unique Header', 0, 0, 100, 50), w('body', 0, 400, 100, 420), bottomAnchor()], 1),
      page([w('Different', 0, 0, 100, 50), w('body2', 0, 400, 100, 420), bottomAnchor()], 2),
    ];
    markHeadersFooters(pages, { minRepeat: 2 });
    expect(pages[0].words[0].isHeader).toBeUndefined();
  });

  it('marks page number digits as footer even without repetition pattern', () => {
    // page height anchored at y1=760; footer zone = 760 * 0.08 = ~60.8 from bottom
    // footer starts at y0 >= 760 - 60.8 = 699.2; page num at y0=710, y1=730
    const pages = [
      page([w('body text', 0, 100, 100, 120), w('_anchor', 0, 740, 10, 760), w('1', 50, 710, 60, 730)], 1),
    ];
    markHeadersFooters(pages, { footerZone: 0.08 });
    const pgNum = pages[0].words.find(wd => wd.text === '1');
    expect(pgNum.isFooter).toBe(true);
  });

  it('marks footer zone words repeating across pages', () => {
    // footer at y0=710, y1=730; page anchored at y1=760; footerY = 760*(1-0.08) = 699.2
    const fWord = (text) => w(text, 0, 710, 200, 730);
    const body = (text) => w(text, 0, 100, 100, 120);
    const bottomAnchor = () => w('_', 0, 740, 10, 760);
    const pages = [
      page([body('intro'), fWord('All rights reserved'), bottomAnchor()], 1),
      page([body('chapter'), fWord('All rights reserved'), bottomAnchor()], 2),
    ];
    markHeadersFooters(pages, { footerZone: 0.08, minRepeat: 2 });
    expect(pages[0].words[1].isFooter).toBe(true);
    expect(pages[1].words[1].isFooter).toBe(true);
  });

  it('returns the same pages array (mutates in place)', () => {
    const pages = [page([w('hello', 0, 50, 50, 60)], 1)];
    const result = markHeadersFooters(pages);
    expect(result).toBe(pages);
  });

  it('handles pages with no words without throwing', () => {
    const pages = [page([], 1), page([w('body', 0, 50, 50, 60)], 2)];
    expect(() => markHeadersFooters(pages)).not.toThrow();
  });
});

describe('bboxWordsToText', () => {
  it('reconstructs simple single-paragraph text', () => {
    const words = [
      w('Hello', 0, 10, 40, 20),
      w('world', 50, 10, 90, 20),
    ];
    const text = bboxWordsToText([page(words)]);
    expect(text).toContain('Hello world');
  });

  it('creates paragraph break on large vertical gap', () => {
    const words = [
      w('First', 0, 10, 40, 20),
      w('paragraph.', 50, 10, 120, 20),
      w('Second', 0, 80, 50, 90),   // large gap from y=20 to y=80
      w('paragraph.', 60, 80, 130, 90),
    ];
    const text = bboxWordsToText([page(words)]);
    expect(text).toContain('\n\n');
    const parts = text.split('\n\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('First paragraph.');
    expect(parts[1]).toContain('Second paragraph.');
  });

  it('skips words marked as header', () => {
    const words = [
      w('Running Title', 0, 0, 100, 10, { isHeader: true }),
      w('Body text.', 0, 50, 100, 60),
    ];
    const text = bboxWordsToText([page(words)]);
    expect(text).not.toContain('Running Title');
    expect(text).toContain('Body text.');
  });

  it('skips words marked as footer', () => {
    const words = [
      w('Body content.', 0, 50, 100, 60),
      w('42', 50, 190, 60, 200, { isFooter: true }),
    ];
    const text = bboxWordsToText([page(words)]);
    expect(text).not.toContain('42');
    expect(text).toContain('Body content.');
  });

  it('returns empty string for pages with no body words', () => {
    const words = [w('Header', 0, 0, 100, 10, { isHeader: true })];
    const text = bboxWordsToText([page(words)]);
    expect(text).toBe('');
  });

  it('sorts words left-to-right within a line', () => {
    const words = [
      w('second', 60, 10, 100, 20),  // comes second spatially
      w('first', 0, 10, 50, 20),     // comes first spatially
    ];
    const text = bboxWordsToText([page(words)]);
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  it('handles multiple pages joined', () => {
    const page1Words = [w('Page', 0, 10, 40, 20), w('one.', 50, 10, 80, 20)];
    const page2Words = [w('Page', 0, 10, 40, 20), w('two.', 50, 10, 80, 20)];
    const text = bboxWordsToText([page(page1Words, 1), page(page2Words, 2)]);
    expect(text).toContain('Page one.');
    expect(text).toContain('Page two.');
  });

  it('continues paragraph across page break without inserting blank line', () => {
    // Page boundary is a soft continuation — no forced paragraph break between pages
    const page1Words = [w('This', 0, 10, 40, 20), w('sentence', 50, 10, 100, 20), w('continues', 110, 10, 180, 20)];
    const page2Words = [w('on', 0, 10, 20, 20), w('next', 30, 10, 70, 20), w('page.', 80, 10, 120, 20)];
    const text = bboxWordsToText([page(page1Words, 1), page(page2Words, 2)]);
    expect(text).not.toContain('\n\n');
    expect(text).toContain('This sentence continues');
    expect(text).toContain('on next page.');
  });
});

describe('reconstructFromOcrPages', () => {
  it('parses bboxes_json and returns reconstructed text', () => {
    const words = [
      { text: 'Hello', bbox: { x0: 0, y0: 10, x1: 40, y1: 20 }, conf: 90 },
      { text: 'world', bbox: { x0: 50, y0: 10, x1: 90, y1: 20 }, conf: 90 },
    ];
    const ocrPages = [{ bboxes_json: JSON.stringify(words), pageNo: 1 }];
    const text = reconstructFromOcrPages(ocrPages);
    expect(text).toContain('Hello world');
  });

  it('filters out pages without bboxes_json', () => {
    const words = [{ text: 'Content', bbox: { x0: 0, y0: 10, x1: 60, y1: 20 }, conf: 90 }];
    const ocrPages = [
      { bboxes_json: null, pageNo: 1 },
      { bboxes_json: JSON.stringify(words), pageNo: 2 },
    ];
    const text = reconstructFromOcrPages(ocrPages);
    expect(text).toContain('Content');
  });

  it('handles malformed bboxes_json gracefully (empty words array)', () => {
    const ocrPages = [{ bboxes_json: 'not valid json {{{', pageNo: 1 }];
    expect(() => reconstructFromOcrPages(ocrPages)).not.toThrow();
  });

  it('returns empty string for empty ocrPages array', () => {
    expect(reconstructFromOcrPages([])).toBe('');
  });
});

describe('median', () => {
  it('returns 0 for empty array', () => {
    expect(median([])).toBe(0);
  });

  it('returns single element', () => {
    expect(median([7])).toBe(7);
  });

  it('returns middle element for odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('returns average of two middle elements for even-length array', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not mutate the input array', () => {
    const arr = [5, 2, 8, 1];
    median(arr);
    expect(arr).toEqual([5, 2, 8, 1]);
  });
});

describe('groupIntoLines', () => {
  const makeWord = (text, x0, y0, x1, y1) => ({ text, bbox: { x0, y0, x1, y1 }, conf: 90 });

  it('returns empty array for empty input', () => {
    expect(groupIntoLines([], 10)).toEqual([]);
  });

  it('groups words on same y-band into one line', () => {
    const words = [
      makeWord('Hello', 10, 20, 60, 35),
      makeWord('world', 70, 22, 130, 37),
    ];
    const lines = groupIntoLines(words, 20);
    expect(lines).toHaveLength(1);
    expect(lines[0].words.map(w => w.text)).toEqual(['Hello', 'world']);
  });

  it('separates words on different y-bands into distinct lines', () => {
    const words = [
      makeWord('First', 10, 10, 60, 25),
      makeWord('Second', 10, 100, 80, 115),
    ];
    const lines = groupIntoLines(words, 20);
    expect(lines).toHaveLength(2);
  });

  it('sorts words left-to-right within a line', () => {
    const words = [
      makeWord('B', 100, 20, 150, 35),
      makeWord('A', 10, 20, 60, 35),
    ];
    const lines = groupIntoLines(words, 20);
    expect(lines[0].words.map(w => w.text)).toEqual(['A', 'B']);
  });

  it('sorts lines top-to-bottom', () => {
    const words = [
      makeWord('Bottom', 10, 200, 100, 215),
      makeWord('Top', 10, 10, 60, 25),
    ];
    const lines = groupIntoLines(words, 20);
    expect(lines[0].words[0].text).toBe('Top');
    expect(lines[1].words[0].text).toBe('Bottom');
  });
});
