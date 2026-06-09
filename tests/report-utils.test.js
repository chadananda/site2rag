import { describe, it, expect } from 'vitest';
import { stripHtml, getLinkContext, buildFreeSummary, mapDoc, buildSummaryPrompt, titleFromUrl, isGenericTitle } from '../bin/report-utils.js';

describe('stripHtml', () => {
  it('removes HTML tags leaving plain text', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes style blocks entirely', () => {
    const result = stripHtml('<style>body { color: red; }</style><p>Text</p>');
    expect(result).not.toContain('color');
    expect(result).toContain('Text');
  });

  it('removes script blocks entirely', () => {
    const result = stripHtml('<script>alert("xss")</script><p>Content</p>');
    expect(result).not.toContain('alert');
    expect(result).toContain('Content');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp; &gt; &lt; &nbsp;')).toBe('& > <');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('<p>  too   many   spaces  </p>')).toBe('too many spaces');
  });
});

describe('getLinkContext', () => {
  it('returns null when PDF URL not found in HTML', () => {
    const result = getLinkContext('<p>No matching content here.</p>', 'https://example.com/report.pdf');
    expect(result).toBeNull();
  });

  it('extracts surrounding paragraph for a PDF link', () => {
    const html = '<p>Download the <a href="https://example.com/annual-report.pdf">Annual Report</a> here.</p>';
    const result = getLinkContext(html, 'https://example.com/annual-report.pdf');
    expect(result).toBeTruthy();
    expect(result).toContain('Annual Report');
  });

  it('limits context to 600 characters', () => {
    const longHtml = `<p>${'x '.repeat(500)} annual-report.pdf and more text here to test the limit</p>`;
    const result = getLinkContext(longHtml, 'https://example.com/annual-report.pdf');
    if (result) expect(result.length).toBeLessThanOrEqual(600);
  });

  it('returns null when context is less than 30 chars', () => {
    const html = '<p>annual-report.pdf</p>';
    const result = getLinkContext(html, 'https://example.com/annual-report.pdf');
    // "annual-report.pdf" is under 30 chars after stripping HTML, so returns null
    expect(result).toBeNull();
  });
});

describe('buildFreeSummary', () => {
  it('combines title and excerpt for full row', () => {
    const row = {
      title: 'Annual Report',
      source_url: 'https://example.com/report.pdf',
      excerpt: 'This report summarizes the financial activities for the fiscal year 2024 with detailed analysis.'
    };
    const result = buildFreeSummary(row);
    expect(result).toContain('Annual Report');
    expect(result).toContain('example.com');
  });

  it('returns null when row has no title and no excerpt', () => {
    expect(buildFreeSummary({ title: null, excerpt: null, source_url: null })).toBeNull();
  });

  it('truncates long excerpts with ellipsis', () => {
    const row = {
      title: 'Report',
      source_url: 'https://example.com/r.pdf',
      excerpt: 'A '.repeat(200)
    };
    const result = buildFreeSummary(row);
    expect(result).toContain('…');
  });

  it('returns title with domain when excerpt is short', () => {
    const row = { title: 'My Doc', source_url: 'https://example.com/doc.pdf', excerpt: 'Short' };
    const result = buildFreeSummary(row);
    expect(result).toContain('My Doc');
    expect(result).toContain('example.com');
  });

  it('uses just excerpt when title is null but excerpt is long enough', () => {
    const row = { title: null, source_url: null, excerpt: 'Long excerpt text that is definitely more than forty characters long here.' };
    const result = buildFreeSummary(row);
    expect(result).toBe(row.excerpt);
  });
});

describe('mapDoc', () => {
  const baseDoc = {
    url: 'https://example.com/doc.pdf', title: 'My Document', ai_summary: null,
    ai_language: 'english', pages: 10, readable_pages_pct: 0.9, composite_score: 0.8,
    has_text_layer: 1, avg_chars_per_page: 1500, excerpt: 'Sample text content here.',
    upgrade_history: null, receipt_json: null, before_score: null, after_score: null,
    summary_tier: null
  };

  it('preserves good title as-is', () => {
    const result = mapDoc(baseDoc, 'example.com');
    expect(result.title).toBe('My Document');
  });

  it('replaces generic short title with URL-derived title', () => {
    const doc = { ...baseDoc, title: 'pdf', url: 'https://example.com/annual-report-2024.pdf' };
    const result = mapDoc(doc, 'example.com');
    expect(result.title).toContain('Annual');
  });

  it('classifies text PDF correctly (has_text_layer=1, readable_pct high)', () => {
    const result = mapDoc(baseDoc, 'example.com');
    expect(result.pdf_type).toBe('text');
  });

  it('classifies image PDF correctly (has_text_layer=0)', () => {
    const doc = { ...baseDoc, has_text_layer: 0 };
    const result = mapDoc(doc, 'example.com');
    expect(result.pdf_type).toBe('image');
  });

  it('classifies mixed PDF (has_text_layer=1, low readable_pct)', () => {
    const doc = { ...baseDoc, has_text_layer: 1, readable_pages_pct: 0.2 };
    const result = mapDoc(doc, 'example.com');
    expect(result.pdf_type).toBe('mixed');
  });

  it('sets summary_tier=free when free summary generated', () => {
    const doc = { ...baseDoc, ai_summary: null, excerpt: 'Long excerpt text content for testing the free summary tier assignment.' };
    const result = mapDoc(doc, 'example.com');
    expect(result.summary_tier).toBe('free');
    expect(result.ai_summary).toBeTruthy();
  });

  it('score_trail extracts before and after from upgrade_history JSON', () => {
    const history = [{ score_before: 0.3, score_after: 0.6 }, { score_before: 0.6, score_after: 0.8 }];
    const doc = { ...baseDoc, upgrade_history: JSON.stringify(history) };
    const result = mapDoc(doc, 'example.com');
    expect(result.score_trail).toEqual([0.3, 0.6, 0.8]);
  });

  it('score_trail is empty array when upgrade_history is null', () => {
    const result = mapDoc(baseDoc, 'example.com');
    expect(result.score_trail).toEqual([]);
  });

  it('archive_url is set when status=done and upgraded_pdf_path exists', () => {
    const doc = { ...baseDoc, status: 'done', upgraded_pdf_path: '/path/to/upgraded.pdf', path_slug: 'doc' };
    const result = mapDoc(doc, 'example.com');
    expect(result.archive_url).toBeTruthy();
    expect(result.archive_url).toContain('example.com');
  });

  it('archive_url is null when status is not done', () => {
    const doc = { ...baseDoc, status: 'pending', upgraded_pdf_path: '/path/to/upgraded.pdf' };
    const result = mapDoc(doc, 'example.com');
    expect(result.archive_url).toBeNull();
  });

  it('effective_before uses before_score when available', () => {
    const doc = { ...baseDoc, before_score: 0.25, after_score: 0.75 };
    const result = mapDoc(doc, 'example.com');
    expect(result.effective_before).toBe(0.25);
    expect(result.effective_after).toBe(0.75);
    expect(result.effective_improvement).toBeCloseTo(0.5, 5);
  });

  it('effort_mins is 0 when all pages are readable', () => {
    const doc = { ...baseDoc, pages: 10, readable_pages_pct: 1.0 };
    const result = mapDoc(doc, 'example.com');
    expect(result.effort_mins).toBe(0);
  });

  it('effort_mins is nonzero for image PDFs', () => {
    const doc = { ...baseDoc, pages: 10, readable_pages_pct: 0, has_text_layer: 0 };
    const result = mapDoc(doc, 'example.com');
    expect(result.effort_mins).toBeGreaterThan(0);
  });

  it('titleFromUrl strips numeric timestamp prefix', () => {
    const doc = { ...baseDoc, title: 'pdf', url: 'https://example.com/1770651898-history-of-aliyabad.pdf' };
    const result = mapDoc(doc, 'example.com');
    expect(result.title).not.toMatch(/^\d/);
    expect(result.title).toContain('History');
  });

  it('titleFromUrl uses ?dl= query param filename when present', () => {
    const doc = { ...baseDoc, title: 'pdf', url: 'https://example.com/download?dl=climate-change-report.pdf' };
    const result = mapDoc(doc, 'example.com');
    expect(result.title).toContain('Climate');
  });

  it('effective_improvement is null when before_score is null', () => {
    const doc = { ...baseDoc, before_score: null, after_score: 0.8 };
    const result = mapDoc(doc, 'example.com');
    expect(result.effective_improvement).toBeNull();
  });

  it('effective_after is capped at 1.0 even if after_score exceeds 1', () => {
    const doc = { ...baseDoc, before_score: 0.3, after_score: 1.5 };
    const result = mapDoc(doc, 'example.com');
    expect(result.effective_after).toBe(1);
  });
});

describe('buildSummaryPrompt', () => {
  it('returns null when no title, no excerpt, and no source_url', () => {
    expect(buildSummaryPrompt({ url: 'https://example.com/123.pdf', hosted_title: null, pdf_title: null, excerpt: null, source_url: null })).toBeNull();
  });

  it('includes title in prompt when available', () => {
    const row = { url: 'https://example.com/report.pdf', hosted_title: 'Annual Report', pdf_title: null, excerpt: null, source_url: null };
    const prompt = buildSummaryPrompt(row);
    expect(prompt).toContain('Annual Report');
    expect(prompt).toContain('https://example.com/report.pdf');
  });

  it('uses URL slug as title when no explicit title', () => {
    const row = { url: 'https://example.com/annual-report-2024.pdf', hosted_title: null, pdf_title: null, excerpt: 'Some text excerpt here.', source_url: null };
    const prompt = buildSummaryPrompt(row);
    expect(prompt).toContain('annual report 2024');
  });

  it('includes excerpt truncated to 500 chars', () => {
    const row = { url: 'https://example.com/doc.pdf', hosted_title: 'Title', pdf_title: null, excerpt: 'x'.repeat(600), source_url: null };
    const prompt = buildSummaryPrompt(row);
    // Excerpt line ends at newline; slice(0,500) produces exactly 500 'x' chars
    const excerptMatch = prompt.match(/Excerpt: ([^\n]+)/);
    expect(excerptMatch).toBeTruthy();
    expect(excerptMatch[1].length).toBe(500);
  });

  it('includes source_url when provided', () => {
    const row = { url: 'https://example.com/doc.pdf', hosted_title: 'My Doc', pdf_title: null, excerpt: null, source_url: 'https://example.com/docs' };
    const prompt = buildSummaryPrompt(row);
    expect(prompt).toContain('Source page: https://example.com/docs');
  });
});

describe('mapDoc — method_steps from receipt_json', () => {
  const baseDoc = {
    url: 'https://example.com/doc.pdf', title: 'My Document', ai_summary: null,
    ai_language: 'english', pages: 5, readable_pages_pct: 0.2, composite_score: 0.4,
    has_text_layer: 0, avg_chars_per_page: 1000, excerpt: 'Sample.',
    upgrade_history: null, receipt_json: null, before_score: null, after_score: null,
    summary_tier: null
  };

  it('method_steps is null when receipt_json is null', () => {
    const result = mapDoc(baseDoc, 'example.com');
    expect(result.method_steps).toBeNull();
  });

  it('method_steps parses stages with per-stage scores', () => {
    const receipt = {
      stages: [
        { stage: 's3', pages_affected: 3, notes: 'tesseract' },
        { stage: 's6', pages_affected: 3, notes: '' }
      ],
      quality: {
        gain: 0.3,
        per_stage: { s0: 0.2, s3: 0.5, s6: 0.6 }
      }
    };
    const doc = { ...baseDoc, receipt_json: JSON.stringify(receipt), before_score: 0.2, after_score: 0.6 };
    const result = mapDoc(doc, 'example.com');
    expect(result.method_steps).not.toBeNull();
    expect(result.method_steps.steps.length).toBeGreaterThan(0);
    expect(result.method_steps.totalGainPct).toBe(40); // 0.6 - 0.2 = 0.4 → 40%
  });

  it('method_steps skips stages with pages_affected=0', () => {
    const receipt = {
      stages: [
        { stage: 's3', pages_affected: 0, notes: 'tesseract' },
        { stage: 's5', pages_affected: 3, approach: 'claude' }
      ],
      quality: { gain: 0.2, per_stage: { s5: 0.5 } }
    };
    const doc = { ...baseDoc, receipt_json: JSON.stringify(receipt) };
    const result = mapDoc(doc, 'example.com');
    expect(result.method_steps).not.toBeNull();
    const labels = result.method_steps.steps.map(s => s.label);
    expect(labels.some(l => l.includes('Tesseract'))).toBe(false);
    expect(labels.some(l => l.includes('Claude'))).toBe(true);
  });

  it('method_steps returns null when no stages have pages_affected > 0', () => {
    const receipt = {
      stages: [{ stage: 's3', pages_affected: 0 }],
      quality: { per_stage: {} }
    };
    const doc = { ...baseDoc, receipt_json: JSON.stringify(receipt) };
    const result = mapDoc(doc, 'example.com');
    expect(result.method_steps).toBeNull();
  });
});

describe('titleFromUrl', () => {
  it('converts filename to title case', () => {
    expect(titleFromUrl('https://example.com/history-of-bahrain.pdf')).toBe('History Of Bahrain');
  });

  it('strips numeric timestamp prefix', () => {
    expect(titleFromUrl('https://example.com/1770651898-history-of-aliyabad.pdf')).toBe('History Of Aliyabad');
  });

  it('uses dl query parameter when present', () => {
    expect(titleFromUrl('https://example.com/download?dl=annual-report.pdf')).toBe('Annual Report');
  });

  it('converts underscores to spaces', () => {
    expect(titleFromUrl('https://example.com/the_great_document.pdf')).toBe('The Great Document');
  });

  it('returns null for invalid URL', () => {
    expect(titleFromUrl('not-a-url')).toBeNull();
  });

  it('returns null when pathname has no meaningful filename', () => {
    const result = titleFromUrl('https://example.com/');
    // empty filename → null or empty string → null
    expect(result == null || result === '').toBe(true);
  });
});

describe('isGenericTitle', () => {
  it('returns true for null/undefined', () => {
    expect(isGenericTitle(null)).toBe(true);
    expect(isGenericTitle(undefined)).toBe(true);
  });

  it('returns true for short titles (5 chars or fewer)', () => {
    expect(isGenericTitle('PDF')).toBe(true);
    expect(isGenericTitle('abc')).toBe(true);
    expect(isGenericTitle('12345')).toBe(true);
  });

  it('returns true for bare "pdf" string (case insensitive)', () => {
    expect(isGenericTitle('pdf')).toBe(true);
    expect(isGenericTitle('PDF')).toBe(true);
    expect(isGenericTitle(' PDF ')).toBe(true);
  });

  it('returns false for meaningful titles longer than 5 chars', () => {
    expect(isGenericTitle('Annual Report')).toBe(false);
    expect(isGenericTitle('History of Medicine')).toBe(false);
  });
});
