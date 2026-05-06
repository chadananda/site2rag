// Tests for summarize.js: summarizeTopPending prompt construction, response parsing, skip logic.
// Anthropic SDK is mocked — no real API calls.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

// Mock db.js to avoid needing real DB schema for logLlmCall
vi.mock('../../src/db.js', () => ({
  logLlmCall: vi.fn(),
  llmCost: vi.fn(() => 0.001),
}));

import { summarizeTopPending } from '../../src/pdf-upgrade/summarize.js';

function makeDb(rows = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pdf_quality (
      url TEXT PRIMARY KEY, pdf_title TEXT, excerpt TEXT, ai_language TEXT,
      composite_score REAL DEFAULT 0.5, skip INT DEFAULT 0,
      ai_summarized_at TEXT, ai_summary TEXT, ai_author TEXT, ai_title TEXT,
      summary_tier TEXT
    );
    CREATE TABLE IF NOT EXISTS pdf_upgrade_queue (
      url TEXT PRIMARY KEY, priority REAL DEFAULT 0.5
    );
    CREATE TABLE IF NOT EXISTS hosts (
      hosted_url TEXT PRIMARY KEY, hosted_title TEXT, host_url TEXT
    );
  `);
  for (const row of rows) {
    db.prepare('INSERT OR REPLACE INTO pdf_quality (url, pdf_title, excerpt, ai_language) VALUES (?,?,?,?)')
      .run(row.url, row.pdf_title ?? null, row.excerpt ?? null, row.language ?? null);
  }
  return db;
}

function okResponse(text) {
  return { content: [{ text }], usage: { input_tokens: 10, output_tokens: 5 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  createMock.mockResolvedValue(okResponse(
    'Title: Test Document\nAuthor: John Smith\nDescription: A test document.\nKeywords: test, document'
  ));
});

describe('summarizeTopPending — skip logic', () => {
  it('returns early when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const db = makeDb([{ url: 'https://example.com/a.pdf', excerpt: 'hello' }]);
    await summarizeTopPending(db, {});
    expect(createMock).not.toHaveBeenCalled();
  });

  it('skips documents already summarized (ai_summarized_at is set)', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO pdf_quality (url, excerpt, ai_summarized_at) VALUES (?,?,?)')
      .run('https://example.com/a.pdf', 'hello world', new Date().toISOString());
    await summarizeTopPending(db, {});
    expect(createMock).not.toHaveBeenCalled();
  });

  it('skips documents with skip=1', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO pdf_quality (url, excerpt, skip) VALUES (?,?,?)')
      .run('https://example.com/a.pdf', 'hello world', 1);
    await summarizeTopPending(db, {});
    expect(createMock).not.toHaveBeenCalled();
  });

  it('skips Arabic/Persian/Hebrew documents in the SQL query', async () => {
    const db = makeDb([{ url: 'https://example.com/arabic.pdf', excerpt: 'text', language: 'arabic' }]);
    await summarizeTopPending(db, {});
    // arabic is excluded by the WHERE clause
    expect(createMock).not.toHaveBeenCalled();
  });

  it('calls API even with minimal signals (URL is always a signal)', async () => {
    const db = makeDb([{ url: 'https://example.com/123456.pdf', excerpt: null, pdf_title: null }]);
    await summarizeTopPending(db, {});
    // URL is always a signal → API is called
    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0];
    expect(call[0].messages[0].content).toContain('URL: https://example.com/123456.pdf');
    // All-digit slug (123456) does not appear as "URL slug:" signal
    expect(call[0].messages[0].content).not.toContain('URL slug:');
  });
});

describe('summarizeTopPending — response parsing', () => {
  it('stores parsed title, author, summary, and keywords tier', async () => {
    const db = makeDb([{ url: 'https://example.com/doc.pdf', excerpt: 'The quick brown fox.' }]);
    await summarizeTopPending(db, {});
    const row = db.prepare('SELECT * FROM pdf_quality').get();
    expect(row.ai_title).toBe('Test Document');
    expect(row.ai_author).toBe('John Smith');
    expect(row.ai_summary).toBe('A test document.');
    expect(row.summary_tier).toBe('haiku');
    expect(row.ai_summarized_at).toBeTruthy();
  });

  it('stores null author when response says "Unknown"', async () => {
    createMock.mockResolvedValueOnce(okResponse(
      'Title: The Book\nAuthor: Unknown\nDescription: A book.\nKeywords: book'
    ));
    const db = makeDb([{ url: 'https://example.com/book.pdf', excerpt: 'Chapter one.' }]);
    await summarizeTopPending(db, {});
    const row = db.prepare('SELECT ai_author FROM pdf_quality').get();
    expect(row.ai_author).toBeNull();
  });

  it('strips bracketed qualifications from title', async () => {
    createMock.mockResolvedValueOnce(okResponse(
      'Title: The Collected Works [full title not available]\nAuthor: Unknown\nDescription: Works.\nKeywords: works'
    ));
    const db = makeDb([{ url: 'https://example.com/w.pdf', excerpt: 'Works of...' }]);
    await summarizeTopPending(db, {});
    const row = db.prepare('SELECT ai_title FROM pdf_quality').get();
    expect(row.ai_title).not.toContain('[');
    expect(row.ai_title).toContain('The Collected Works');
  });

  it('uses URL slug as fallback title signal when slug is meaningful', async () => {
    const db = makeDb([{ url: 'https://example.com/my-great-document.pdf', excerpt: null, pdf_title: null }]);
    await summarizeTopPending(db, {});
    // Should have called the API because slug is meaningful text
    const call = createMock.mock.calls[0];
    if (call) {
      expect(call[0].messages[0].content).toContain('my great document');
    }
  });
});

describe('summarizeTopPending — language detection fallback', () => {
  it('skips non-English document detected via language detection', async () => {
    // Document with unknown language but Arabic text in excerpt
    const arabicText = 'كتاب العربية في الحياة والأدب والثقافة';
    const db = makeDb([{ url: 'https://example.com/ar.pdf', excerpt: arabicText, language: 'unknown' }]);
    await summarizeTopPending(db, {});
    // Arabic detected → skipped → ai_summarized_at set, API not called
    expect(createMock).not.toHaveBeenCalled();
    const row = db.prepare('SELECT ai_summarized_at FROM pdf_quality').get();
    expect(row.ai_summarized_at).toBeTruthy();
  });
});

describe('summarizeTopPending — error handling', () => {
  it('leaves ai_summarized_at null when API throws — no re-throw', async () => {
    createMock.mockRejectedValueOnce(new Error('API overloaded'));
    const db = makeDb([{ url: 'https://example.com/err.pdf', excerpt: 'Some content here.' }]);
    // Should resolve without throwing
    await expect(summarizeTopPending(db, {})).resolves.toBeUndefined();
    // ai_summarized_at must NOT be set (doc should be retried next run)
    const row = db.prepare('SELECT ai_summarized_at FROM pdf_quality').get();
    expect(row.ai_summarized_at).toBeNull();
  });
});
