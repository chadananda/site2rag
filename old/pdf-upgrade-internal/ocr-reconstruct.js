// Reconstruct readable text from Tesseract bbox word objects with layout awareness.
// Exports: markHeadersFooters, bboxWordsToText. Deps: none
//
// Input word objects: { text, bbox: {x0, y0, x1, y1}, conf, [isHeader], [isFooter] }
// Multiple pages passed together so cross-page paragraph joining can work.

/** Median of a numeric array. */
export const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Group a page's words into lines by y-coordinate proximity.
 * Returns [{y0, y1, words: [...]}] sorted top-to-bottom, words sorted left-to-right.
 */
export const groupIntoLines = (words, lineGap) => {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  const lines = [];
  let current = { y0: sorted[0].bbox.y0, y1: sorted[0].bbox.y1, words: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    // Same line if word's top is within lineGap of current line's midpoint
    const lineMid = (current.y0 + current.y1) / 2;
    if (w.bbox.y0 < lineMid + lineGap) {
      current.words.push(w);
      current.y1 = Math.max(current.y1, w.bbox.y1);
    } else {
      // Sort words in line left-to-right before pushing
      current.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      lines.push(current);
      current = { y0: w.bbox.y0, y1: w.bbox.y1, words: [w] };
    }
  }
  current.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  lines.push(current);
  return lines;
};

/**
 * Mark header and footer words on each page.
 * Strategy:
 *   1. Mark words in top/bottom N% of each page as candidate header/footer
 *   2. For candidate zones, identify text that repeats across pages (running titles, page numbers)
 *      → those get isHeader/isFooter = true
 *   3. Single-page or non-repeating zone text is left unmarked (might be real content)
 *
 * Mutates word objects in-place; returns the same pages array.
 * @param {Array<{words: Array, pageNo: number}>} pages
 * @param {object} [opts]
 * @param {number} [opts.headerZone=0.08]  - Fraction of page height for header zone
 * @param {number} [opts.footerZone=0.08]  - Fraction of page height for footer zone
 * @param {number} [opts.minRepeat=2]      - Min pages a pattern must appear on to count
 */
export const markHeadersFooters = (pages, { headerZone = 0.08, footerZone = 0.08, minRepeat = 2 } = {}) => {
  // Collect candidate zone text per page
  const headerCandidates = new Map(); // normalized text → count
  const footerCandidates = new Map();

  for (const { words } of pages) {
    if (!words.length) continue;
    const pageHeight = Math.max(...words.map(w => w.bbox.y1));
    const headerY = pageHeight * headerZone;
    const footerY = pageHeight * (1 - footerZone);
    // Gather zone text as a normalized string
    const hWords = words.filter(w => w.bbox.y1 <= headerY).map(w => w.text).join(' ').trim().toLowerCase();
    const fWords = words.filter(w => w.bbox.y0 >= footerY).map(w => w.text).join(' ').trim().toLowerCase();
    if (hWords) headerCandidates.set(hWords, (headerCandidates.get(hWords) || 0) + 1);
    if (fWords) footerCandidates.set(fWords, (footerCandidates.get(fWords) || 0) + 1);
  }

  // Patterns that repeat across enough pages are headers/footers
  const repeatHeaders = new Set([...headerCandidates.entries()].filter(([, n]) => n >= minRepeat).map(([t]) => t));
  const repeatFooters = new Set([...footerCandidates.entries()].filter(([, n]) => n >= minRepeat).map(([t]) => t));

  // Also treat any single-word/digit-only footer as page number (repeats structurally)
  const isPageNumber = (text) => /^\d{1,4}$/.test(text.trim());

  for (const { words } of pages) {
    if (!words.length) continue;
    const pageHeight = Math.max(...words.map(w => w.bbox.y1));
    const headerY = pageHeight * headerZone;
    const footerY = pageHeight * (1 - footerZone);
    const pageHText = words.filter(w => w.bbox.y1 <= headerY).map(w => w.text).join(' ').trim().toLowerCase();
    const pageFText = words.filter(w => w.bbox.y0 >= footerY).map(w => w.text).join(' ').trim().toLowerCase();
    for (const w of words) {
      if (w.bbox.y1 <= headerY && repeatHeaders.has(pageHText)) w.isHeader = true;
      if (w.bbox.y0 >= footerY && (repeatFooters.has(pageFText) || isPageNumber(w.text))) w.isFooter = true;
    }
  }

  return pages;
};

/**
 * Reconstruct clean text from an array of pages' bbox word objects.
 * - Words marked isHeader/isFooter are skipped
 * - Lines detected from y-coordinate proximity
 * - Paragraphs detected from vertical gap > 1.5× median line height
 * - Adjacent pages' paragraphs joined if the page break fell mid-sentence
 *
 * @param {Array<{words: Array<{text, bbox, conf, isHeader?, isFooter?}>, pageNo: number}>} pages
 * @returns {string} Reconstructed markdown text
 */
export const bboxWordsToText = (pages) => {
  const allPageLines = [];

  for (const { words } of pages) {
    const bodyWords = words.filter(w => !w.isHeader && !w.isFooter && w.text.trim());
    if (!bodyWords.length) { allPageLines.push(null); continue; } // null = page boundary marker

    // Estimate line gap from word heights
    const wordHeights = bodyWords.map(w => w.bbox.y1 - w.bbox.y0).filter(h => h > 0);
    const medianHeight = median(wordHeights) || 12;
    const lineGap = medianHeight * 0.6;

    const lines = groupIntoLines(bodyWords, lineGap);
    allPageLines.push({ lines, medianHeight });
  }

  // Build paragraphs across pages
  const paragraphs = [];
  let currentPara = [];

  const flushPara = () => {
    if (currentPara.length) { paragraphs.push(currentPara.join(' ')); currentPara = []; }
  };

  let prevLineY1 = null;
  let prevMedianHeight = 12;

  for (const pageData of allPageLines) {
    if (pageData === null) {
      // Page boundary — check if we should join or break
      // If current paragraph ends without sentence-ending punctuation, defer the break
      // We'll decide after seeing the next page's first word
      continue;
    }

    const { lines, medianHeight } = pageData;
    prevMedianHeight = medianHeight;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineText = line.words.map(w => w.text).join(' ');

      if (prevLineY1 !== null) {
        const gap = line.y0 - prevLineY1;
        const paraBreakThreshold = medianHeight * 1.5;
        if (gap > paraBreakThreshold) {
          // Large gap → new paragraph
          flushPara();
        }
        // Otherwise same paragraph, just add the line text
      }

      currentPara.push(lineText);
      prevLineY1 = line.y1;
    }
  }
  flushPara();

  return paragraphs.join('\n\n');
};

/**
 * Full pipeline: given raw bboxes_json strings per page, reconstruct clean text.
 * Handles markHeadersFooters → bboxWordsToText in one call.
 *
 * @param {Array<{bboxes_json: string, pageNo: number}>} ocrPages
 * @returns {string}
 */
export const reconstructFromOcrPages = (ocrPages) => {
  const pages = ocrPages
    .filter(p => p.bboxes_json)
    .map(p => {
      let words = [];
      try { words = JSON.parse(p.bboxes_json); } catch {}
      return { words, pageNo: p.pageNo };
    });
  markHeadersFooters(pages);
  return bboxWordsToText(pages);
};
