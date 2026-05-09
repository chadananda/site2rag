import { describe, it, expect } from 'vitest';
import { markHeadersFooters, bboxWordsToText, reconstructFromOcrPages } from '../src/pdf-upgrade/ocr-reconstruct.js';

const word = (text, x0, y0, x1, y1, conf = 95) => ({ text, bbox: { x0, y0, x1, y1 }, conf });

describe('bboxWordsToText', () => {
  it('returns empty string for empty pages', () => {
    expect(bboxWordsToText([])).toBe('');
  });

  it('returns empty string for page with no words', () => {
    expect(bboxWordsToText([{ words: [], pageNo: 1 }])).toBe('');
  });

  it('joins words on the same line into a sentence', () => {
    const pages = [{
      pageNo: 1,
      words: [word('Hello', 10, 100, 60, 120), word('world', 70, 100, 120, 120)]
    }];
    const result = bboxWordsToText(pages);
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('skips words marked as isHeader', () => {
    const pages = [{
      pageNo: 1,
      words: [
        { ...word('CHAPTER', 10, 5, 80, 20), isHeader: true },
        word('Real', 10, 100, 60, 120),
        word('content', 70, 100, 130, 120)
      ]
    }];
    const result = bboxWordsToText(pages);
    expect(result).not.toContain('CHAPTER');
    expect(result).toContain('Real');
  });

  it('skips words marked as isFooter', () => {
    const pages = [{
      pageNo: 1,
      words: [
        word('Text', 10, 100, 60, 120),
        { ...word('42', 300, 780, 340, 800), isFooter: true }
      ]
    }];
    const result = bboxWordsToText(pages);
    expect(result).toContain('Text');
    expect(result).not.toContain('42');
  });

  it('creates a paragraph break when vertical gap exceeds 1.5× median line height', () => {
    // Two groups of words with a large vertical gap between them
    const pages = [{
      pageNo: 1,
      words: [
        word('First', 10, 100, 60, 120),
        word('paragraph', 70, 100, 130, 120),
        word('Second', 10, 300, 60, 320),  // large gap from y=120 to y=300
        word('paragraph', 70, 300, 130, 320)
      ]
    }];
    const result = bboxWordsToText(pages);
    expect(result).toContain('\n\n');
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('handles multiple pages', () => {
    const pages = [
      { pageNo: 1, words: [word('Page', 10, 100, 50, 120), word('one', 60, 100, 90, 120)] },
      { pageNo: 2, words: [word('Page', 10, 100, 50, 120), word('two', 60, 100, 90, 120)] }
    ];
    const result = bboxWordsToText(pages);
    expect(result).toContain('Page');
  });
});

describe('markHeadersFooters', () => {
  it('returns pages unchanged when no words', () => {
    const pages = [{ words: [], pageNo: 1 }];
    const result = markHeadersFooters(pages);
    expect(result).toBe(pages);
  });

  it('marks page number digits in footer zone as isFooter', () => {
    const pages = [{
      pageNo: 1,
      words: [
        word('Body', 10, 400, 60, 420),
        word('42', 300, 950, 340, 970)  // in bottom 8% of 1000px page
      ]
    }];
    markHeadersFooters(pages);
    const pageNumWord = pages[0].words.find(w => w.text === '42');
    expect(pageNumWord.isFooter).toBe(true);
  });

  it('marks repeating header text as isHeader on both pages', () => {
    const headerText = 'My Book Title';
    const pages = [
      {
        pageNo: 1,
        words: [
          word('My', 10, 5, 40, 20),
          word('Book', 50, 5, 90, 20),
          word('Title', 100, 5, 150, 20),
          word('Content', 10, 500, 70, 520)
        ]
      },
      {
        pageNo: 2,
        words: [
          word('My', 10, 5, 40, 20),
          word('Book', 50, 5, 90, 20),
          word('Title', 100, 5, 150, 20),
          word('More', 10, 500, 60, 520)
        ]
      }
    ];
    markHeadersFooters(pages, { headerZone: 0.1, footerZone: 0.05 });
    const p1Header = pages[0].words.filter(w => w.isHeader);
    const p2Header = pages[1].words.filter(w => w.isHeader);
    expect(p1Header.length).toBeGreaterThan(0);
    expect(p2Header.length).toBeGreaterThan(0);
    // Body content should not be marked
    expect(pages[0].words.find(w => w.text === 'Content')?.isHeader).toBeFalsy();
  });

  it('does NOT mark non-repeating zone text as header (unique to one page)', () => {
    const pages = [
      {
        pageNo: 1,
        words: [word('Unique', 10, 5, 70, 20), word('Body', 10, 500, 60, 520)]
      },
      {
        pageNo: 2,
        words: [word('Different', 10, 5, 80, 20), word('More', 10, 500, 60, 520)]
      }
    ];
    markHeadersFooters(pages);
    expect(pages[0].words.find(w => w.text === 'Unique')?.isHeader).toBeFalsy();
    expect(pages[1].words.find(w => w.text === 'Different')?.isHeader).toBeFalsy();
  });
});

describe('bboxWordsToText — cross-page joining', () => {
  it('joins words from two pages into a single paragraph (y-coords reset between pages)', () => {
    // Page 1 ends at y1=120; page 2 starts at y0=10 → gap = 10-120 = -110 (negative, no break)
    const pages = [
      { pageNo: 1, words: [word('First', 10, 100, 60, 120), word('sentence', 70, 100, 130, 120)] },
      { pageNo: 2, words: [word('continues', 10, 10, 80, 30), word('here', 90, 10, 130, 30)] },
    ];
    const result = bboxWordsToText(pages);
    // Both pages' content should appear in the output
    expect(result).toContain('First');
    expect(result).toContain('continues');
    expect(result).toContain('here');
  });

  it('handles empty first page (null boundary) then second page with content', () => {
    const pages = [
      { pageNo: 1, words: [] },          // empty page → null boundary marker
      { pageNo: 2, words: [word('Content', 10, 100, 80, 120)] },
    ];
    const result = bboxWordsToText(pages);
    expect(result).toContain('Content');
  });
});

describe('markHeadersFooters — minRepeat option', () => {
  it('marks single-page header as isHeader when minRepeat=1', () => {
    const pages = [{
      pageNo: 1,
      words: [
        word('RunningHead', 10, 5, 120, 20),  // in top 8%
        word('Body', 10, 500, 60, 520)
      ]
    }];
    // With minRepeat=1, a unique header on one page should be marked
    markHeadersFooters(pages, { minRepeat: 1 });
    const headerWord = pages[0].words.find(w => w.text === 'RunningHead');
    expect(headerWord?.isHeader).toBe(true);
    // Body content is NOT in the zone
    const bodyWord = pages[0].words.find(w => w.text === 'Body');
    expect(bodyWord?.isHeader).toBeFalsy();
  });
});

describe('reconstructFromOcrPages', () => {
  it('returns empty string for empty array', () => {
    expect(reconstructFromOcrPages([])).toBe('');
  });

  it('skips pages with null bboxes_json', () => {
    const pages = [{ bboxes_json: null, pageNo: 1 }];
    expect(reconstructFromOcrPages(pages)).toBe('');
  });

  it('handles malformed bboxes_json without throwing', () => {
    const pages = [{ bboxes_json: '{not valid json}', pageNo: 1 }];
    expect(() => reconstructFromOcrPages(pages)).not.toThrow();
  });

  it('extracts text from valid bboxes_json', () => {
    const words = [
      word('Hello', 10, 100, 60, 120),
      word('world', 70, 100, 120, 120)
    ];
    const pages = [{ bboxes_json: JSON.stringify(words), pageNo: 1 }];
    const result = reconstructFromOcrPages(pages);
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });
});
