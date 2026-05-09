// Tests for summarize-pdfs.js buildPrompt pure function.
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/summarize-pdfs.js';

describe('buildPrompt', () => {
  it('returns null when no title and no excerpt', () => {
    const row = { url: 'https://example.com/12.pdf', hosted_title: null, pdf_title: null, source_url: null, excerpt: null };
    expect(buildPrompt(row)).toBeNull();
  });

  it('returns null when slug is 3 chars or fewer and no title or excerpt', () => {
    // Slug "ab" (2 chars) → slug.length > 3 is false → title = null → returns null
    const row = { url: 'https://example.com/ab.pdf', hosted_title: null, pdf_title: null, source_url: null, excerpt: null };
    expect(buildPrompt(row)).toBeNull();
  });

  it('uses hosted_title over pdf_title', () => {
    const row = {
      url: 'https://example.com/doc.pdf',
      hosted_title: 'Hosted Title',
      pdf_title: 'PDF Title',
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('Hosted Title');
    expect(prompt).not.toContain('PDF Title');
  });

  it('falls back to pdf_title when hosted_title is null', () => {
    const row = {
      url: 'https://example.com/doc.pdf',
      hosted_title: null,
      pdf_title: 'PDF Title',
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('PDF Title');
  });

  it('uses URL slug when no title available and slug > 3 chars', () => {
    // URL "annual-report.pdf" → slug "annual report" (13 chars > 3)
    const row = {
      url: 'https://example.com/annual-report.pdf',
      hosted_title: null,
      pdf_title: null,
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('annual report');
  });

  it('replaces underscores in slug with spaces', () => {
    const row = {
      url: 'https://example.com/my_great_document.pdf',
      hosted_title: null,
      pdf_title: null,
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('my great document');
  });

  it('always includes URL in prompt', () => {
    const row = {
      url: 'https://example.com/report.pdf',
      hosted_title: 'My Report',
      pdf_title: null,
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('https://example.com/report.pdf');
  });

  it('includes source_url in prompt when set', () => {
    const row = {
      url: 'https://example.com/report.pdf',
      hosted_title: 'Report',
      pdf_title: null,
      source_url: 'https://example.com/reports/',
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('https://example.com/reports/');
  });

  it('includes excerpt in prompt when length > 40', () => {
    const excerpt = 'This is a long enough excerpt to be included in the prompt.';
    const row = {
      url: 'https://example.com/doc.pdf',
      hosted_title: 'Doc',
      pdf_title: null,
      source_url: null,
      excerpt,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain(excerpt.slice(0, 40));
  });

  it('omits excerpt when length <= 40', () => {
    const shortExcerpt = 'Short text.';
    const row = {
      url: 'https://example.com/doc.pdf',
      hosted_title: 'Doc',
      pdf_title: null,
      source_url: null,
      excerpt: shortExcerpt,
    };
    const prompt = buildPrompt(row);
    expect(prompt).not.toContain('Document excerpt:');
  });

  it('returns non-null when only excerpt is present (> 40 chars), even without title', () => {
    // No title, no slug > 3 chars, but has long excerpt → should still return prompt
    const row = {
      url: 'https://example.com/12.pdf',
      hosted_title: null,
      pdf_title: null,
      source_url: null,
      excerpt: 'This is a long enough excerpt text to trigger inclusion in the prompt output.',
    };
    const prompt = buildPrompt(row);
    expect(prompt).not.toBeNull();
  });

  it('includes language detection in prompt', () => {
    const row = {
      url: 'https://example.com/doc.pdf',
      hosted_title: 'English Document',
      pdf_title: null,
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toMatch(/language: \w+/);
  });

  it('prompt instructs two-line response format', () => {
    const row = {
      url: 'https://example.com/doc.pdf',
      hosted_title: 'Test Doc',
      pdf_title: null,
      source_url: null,
      excerpt: null,
    };
    const prompt = buildPrompt(row);
    expect(prompt).toContain('two plain-text lines');
  });
});
