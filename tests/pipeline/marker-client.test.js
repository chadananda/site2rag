// Tests for marker-client.js: markerAvailable, convertPdfWithMarker, scoreMarkdown.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { markerAvailable, convertPdfWithMarker, scoreMarkdown } from '../../src/pdf-upgrade/marker-client.js';

afterEach(() => { vi.unstubAllGlobals(); });

function mockFetch(status, body) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }));
}

describe('markerAvailable', () => {
  it('returns true when /health responds ok', async () => {
    mockFetch(200, {});
    expect(await markerAvailable()).toBe(true);
  });

  it('returns false when /health responds non-ok', async () => {
    mockFetch(503, {});
    expect(await markerAvailable()).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await markerAvailable()).toBe(false);
  });

  it('calls the /health endpoint', async () => {
    const mockFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFn);
    await markerAvailable();
    expect(mockFn.mock.calls[0][0]).toContain('/health');
  });
});

describe('convertPdfWithMarker', () => {
  it('returns markdown string on success', async () => {
    mockFetch(200, { ok: true, markdown: '# Hello World\n\nThis is content.' });
    const result = await convertPdfWithMarker('/path/to/doc.pdf');
    expect(result).toBe('# Hello World\n\nThis is content.');
  });

  it('sends POST /convert with pdf_path in body', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, markdown: 'text' }),
    });
    vi.stubGlobal('fetch', mockFn);
    await convertPdfWithMarker('/tank/docs/file.pdf');
    const [url, opts] = mockFn.mock.calls[0];
    expect(url).toContain('/convert');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.pdf_path).toBe('/tank/docs/file.pdf');
  });

  it('throws on HTTP error status', async () => {
    mockFetch(500, 'internal error');
    await expect(convertPdfWithMarker('/doc.pdf')).rejects.toThrow('marker HTTP 500');
  });

  it('throws when response ok=false with error message', async () => {
    mockFetch(200, { ok: false, error: 'PDF parse failure' });
    await expect(convertPdfWithMarker('/doc.pdf')).rejects.toThrow('PDF parse failure');
  });

  it('throws generic message when response ok=false with no error field', async () => {
    mockFetch(200, { ok: false });
    await expect(convertPdfWithMarker('/doc.pdf')).rejects.toThrow('marker conversion failed');
  });
});

describe('scoreMarkdown', () => {
  it('returns 0 for null input', () => {
    expect(scoreMarkdown(null)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(scoreMarkdown('')).toBe(0);
  });

  it('returns 0 for very short text under 100 chars', () => {
    expect(scoreMarkdown('hi')).toBe(0);
  });

  it('returns 0.1 for short text with fewer than 30 words', () => {
    // 100+ chars but < 30 words (use repeated long word)
    const md = 'longuncommonword '.repeat(6); // 6 words, ~102 chars
    expect(scoreMarkdown(md)).toBe(0.1);
  });

  it('returns a number between 0 and 1 for typical document text', () => {
    const md = `# Introduction\n\nThis document covers the history of religious texts in the nineteenth century. It includes multiple paragraphs discussing various aspects of the Bahá'í Faith and its origins. The content is substantial and varied.`;
    const score = scoreMarkdown(md);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores longer diverse text higher than very short text', () => {
    const shortMd = 'a '.repeat(15) + 'x'.repeat(50); // 30 words, low diversity
    const longMd = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' '); // many unique words
    expect(scoreMarkdown(longMd)).toBeGreaterThan(scoreMarkdown(shortMd));
  });

  it('caps at 1.0 for very dense diverse content', () => {
    const longDiverse = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    expect(scoreMarkdown(longDiverse)).toBeLessThanOrEqual(1.0);
  });

  it('returns a number rounded to 2 decimal places', () => {
    const md = `This is a moderately long document that talks about many different topics. `.repeat(10);
    const score = scoreMarkdown(md);
    expect(score).toBe(Math.round(score * 100) / 100);
  });
});
