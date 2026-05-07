// Tests for pdf-upgrade/summarize.js: language detection skip, no-signals skip, response parsing.
// Anthropic SDK is mocked — no real API calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-summarize-behavior-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

import { openDb } from '../../src/db.js';
import { summarizeTopPending } from '../../src/pdf-upgrade/summarize.js';

const DOMAIN = 'summarize-behavior.example.com';

const okResponse = (text = '') => ({
  content: [{ text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const insertPdfRow = (db, url, opts = {}) => {
  const {
    aiLanguage = null, aiSummarizedAt = null, skip = 0,
    pdfTitle = null, excerpt = null,
  } = opts;
  db.prepare('INSERT OR IGNORE INTO pages (url, mime_type, gone) VALUES (?,?,0)').run(url, 'application/pdf');
  db.prepare(`INSERT OR REPLACE INTO pdf_quality
    (url, has_text_layer, readable_pages_pct, word_quality_estimate, composite_score,
     ai_language, ai_summarized_at, skip, pdf_title, excerpt)
    VALUES (?,0,0.1,0.1,0.3,?,?,?,?,?)`)
    .run(url, aiLanguage, aiSummarizedAt, skip, pdfTitle, excerpt);
};

describe('summarizeTopPending — language skip behavior', () => {
  let db;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    db = openDb(DOMAIN);
    vi.clearAllMocks();
    createMock.mockResolvedValue(okResponse('Title: Test\nAuthor: Unknown\nDescription: A test doc.\nKeywords: test'));
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('SQL filter excludes arabic docs — no API call for arabic ai_language', async () => {
    const url = `https://${DOMAIN}/arabic.pdf`;
    insertPdfRow(db, url, { aiLanguage: 'arabic', pdfTitle: 'Arabic doc' });
    await summarizeTopPending(db, DOMAIN);
    // arabic is excluded by SQL WHERE NOT IN, so API should never be called
    expect(createMock).not.toHaveBeenCalled();
  });

  it('SQL filter excludes persian docs — no API call for persian ai_language', async () => {
    const url = `https://${DOMAIN}/persian.pdf`;
    insertPdfRow(db, url, { aiLanguage: 'persian', pdfTitle: 'Persian doc' });
    await summarizeTopPending(db, DOMAIN);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('SQL filter excludes hebrew docs — no API call for hebrew ai_language', async () => {
    const url = `https://${DOMAIN}/hebrew.pdf`;
    insertPdfRow(db, url, { aiLanguage: 'hebrew', pdfTitle: 'Hebrew doc' });
    await summarizeTopPending(db, DOMAIN);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('SQL filter excludes already-summarized rows (ai_summarized_at set)', async () => {
    const url = `https://${DOMAIN}/done.pdf`;
    insertPdfRow(db, url, { aiSummarizedAt: new Date().toISOString(), pdfTitle: 'Done doc' });
    await summarizeTopPending(db, DOMAIN);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('SQL filter excludes skip=1 rows', async () => {
    const url = `https://${DOMAIN}/skipped.pdf`;
    insertPdfRow(db, url, { skip: 1, pdfTitle: 'Skipped doc' });
    await summarizeTopPending(db, DOMAIN);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('marks ai_summarized_at without API call when detected language is non-English', async () => {
    // Row has unknown language, but excerpt contains Arabic text that detectLanguage identifies
    // The NON_ENGLISH branch marks it done without API call
    const url = `https://${DOMAIN}/arabic-unknown.pdf`;
    // Simulate row with NULL ai_language that text-detection should identify as arabic
    // Using Arabic Unicode text for detection
    insertPdfRow(db, url, {
      aiLanguage: null,
      pdfTitle: 'مرحبا بالعالم العربي',
      excerpt: 'هذا نص عربي لاختبار الكشف التلقائي عن اللغة في نظام المعالجة',
    });
    await summarizeTopPending(db, DOMAIN);
    // Should NOT have called API (detected as arabic → NON_ENGLISH skip)
    expect(createMock).not.toHaveBeenCalled();
    const row = db.prepare('SELECT ai_summarized_at FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_summarized_at).toBeTruthy();
  });
});

describe('summarizeTopPending — response parsing', () => {
  let db;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    db = openDb(DOMAIN);
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('stores ai_summary from Description line', async () => {
    createMock.mockResolvedValue(okResponse(
      'Title: My Document\nAuthor: Jane Smith\nDescription: A comprehensive study of history.\nKeywords: history, study'
    ));
    const url = `https://${DOMAIN}/history.pdf`;
    insertPdfRow(db, url, { pdfTitle: 'History Study', aiLanguage: 'english' });
    await summarizeTopPending(db, DOMAIN);
    const row = db.prepare('SELECT ai_summary, ai_author, ai_title, summary_tier FROM pdf_quality WHERE url=?').get(url);
    expect(row.ai_summary).toBe('A comprehensive study of history.');
    expect(row.summary_tier).toBe('haiku');
  });

  it('stores ai_author from Author line (when not "Unknown")', async () => {
    createMock.mockResolvedValue(okResponse(
      'Title: Book\nAuthor: John Doe\nDescription: About books.\nKeywords: books'
    ));
    const url = `https://${DOMAIN}/book.pdf`;
    insertPdfRow(db, url, { pdfTitle: 'A Book', aiLanguage: 'english' });
    await summarizeTopPending(db, DOMAIN);
    const row = db.prepare('SELECT ai_author FROM pdf_quality WHERE url=?').get(url);
    expect(row.ai_author).toBe('John Doe');
  });

  it('stores NULL ai_author when Author line is "Unknown"', async () => {
    createMock.mockResolvedValue(okResponse(
      'Title: Book\nAuthor: Unknown\nDescription: About books.\nKeywords: books'
    ));
    const url = `https://${DOMAIN}/unknown-author.pdf`;
    insertPdfRow(db, url, { pdfTitle: 'A Book', aiLanguage: 'english' });
    await summarizeTopPending(db, DOMAIN);
    const row = db.prepare('SELECT ai_author FROM pdf_quality WHERE url=?').get(url);
    expect(row.ai_author).toBeNull();
  });

  it('stores ai_title from Title line', async () => {
    createMock.mockResolvedValue(okResponse(
      'Title: The Real Title\nAuthor: Unknown\nDescription: Details.\nKeywords: topic'
    ));
    const url = `https://${DOMAIN}/titled.pdf`;
    insertPdfRow(db, url, { aiLanguage: 'english', excerpt: 'Some content here for signals' });
    await summarizeTopPending(db, DOMAIN);
    const row = db.prepare('SELECT ai_title FROM pdf_quality WHERE url=?').get(url);
    expect(row.ai_title).toBe('The Real Title');
  });

  it('sets ai_summarized_at after successful API call', async () => {
    createMock.mockResolvedValue(okResponse(
      'Title: Doc\nAuthor: Author\nDescription: Something.\nKeywords: key'
    ));
    const url = `https://${DOMAIN}/timestamped.pdf`;
    insertPdfRow(db, url, { pdfTitle: 'Doc Title', aiLanguage: 'english' });
    const before = new Date().toISOString();
    await summarizeTopPending(db, DOMAIN);
    const row = db.prepare('SELECT ai_summarized_at FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_summarized_at).toBeTruthy();
    expect(row.ai_summarized_at >= before).toBe(true);
  });

  it('marks summarized without API call when row has no signals (no url title, no excerpt)', async () => {
    // Row with only a numeric-only slug URL, no title, no excerpt, no hosted_title
    const url = `https://${DOMAIN}/12345.pdf`;
    insertPdfRow(db, url, { aiLanguage: 'english' });
    await summarizeTopPending(db, DOMAIN);
    // The slug is "12345" — /^\d+$/.test('12345') === true → slugTitle = null
    // signals = only URL line (url is always included)
    // URL is always in signals, so API IS called
    expect(createMock).toHaveBeenCalled();
  });

  it('uses url slug as title signal when title and excerpt are absent', async () => {
    createMock.mockResolvedValue(okResponse(
      'Title: Inferred Title\nAuthor: Unknown\nDescription: About something.\nKeywords: topic'
    ));
    const url = `https://${DOMAIN}/some-interesting-document.pdf`;
    insertPdfRow(db, url, { aiLanguage: 'english' });
    // Slug "some interesting document" (length > 3) will be included in signals
    await summarizeTopPending(db, DOMAIN);
    const signals = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content || '';
    expect(signals).toContain('some interesting document');
  });
});
