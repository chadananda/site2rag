// Tests for score.js: saveQualityScore, maybeQueue, extractBadSample.
// Uses in-memory SQLite — no real PDF files needed.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveQualityScore, maybeQueue, extractBadSample } from '../../src/pdf-upgrade/score.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pdf_quality (
      url TEXT PRIMARY KEY, content_hash TEXT, scored_at TEXT,
      avg_chars_per_page REAL, readable_pages_pct REAL, has_text_layer INT,
      word_quality_estimate REAL, composite_score REAL, pages INT,
      pdf_title TEXT, excerpt TEXT, processing_difficulty REAL,
      ai_language TEXT
    );
    CREATE TABLE IF NOT EXISTS pdf_upgrade_queue (
      url TEXT PRIMARY KEY, content_hash TEXT, priority REAL,
      status TEXT DEFAULT 'pending', queued_at TEXT
    );
  `);
  return db;
}

const baseMetrics = {
  avg_chars_per_page: 400,
  readable_pages_pct: 0.8,
  has_text_layer: 0,
  word_quality_estimate: 0.7,
  composite_score: 0.65,
  pages: 5,
  pdf_title: 'Test Doc',
  excerpt: 'Some text',
  language: 'english',
  processing_difficulty: 0.5,
};

describe('saveQualityScore', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('inserts a row into pdf_quality', () => {
    saveQualityScore(db, 'https://example.com/a.pdf', 'abc123', baseMetrics);
    const row = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get('https://example.com/a.pdf');
    expect(row).toBeDefined();
    expect(row.composite_score).toBeCloseTo(0.65, 3);
    expect(row.has_text_layer).toBe(0);
  });

  it('overrides language from URL when URL contains Arabic percent-encoding', () => {
    const arabicUrl = 'https://example.com/%d8%a8%d8%af%d8%a7%d9%8a%d8%a9.pdf';
    saveQualityScore(db, arabicUrl, 'hash1', { ...baseMetrics, language: 'english' });
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(arabicUrl);
    expect(row.ai_language).toBe('arabic');
  });

  it('uses metrics.language when URL has no language signal', () => {
    saveQualityScore(db, 'https://example.com/doc.pdf', 'hash2', { ...baseMetrics, language: 'french' });
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get('https://example.com/doc.pdf');
    expect(row.ai_language).toBe('french');
  });

  it('detects custom-encoded text layer: sets has_text_layer=0 and caps score at 0.15', () => {
    const garbledMetrics = {
      ...baseMetrics,
      has_text_layer: 1,
      word_quality_estimate: 0.02, // near-zero → custom font encoding
      composite_score: 0.6,
    };
    saveQualityScore(db, 'https://example.com/persian.pdf', 'hash3', garbledMetrics);
    const row = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get('https://example.com/persian.pdf');
    expect(row.has_text_layer).toBe(0);
    expect(row.composite_score).toBeLessThanOrEqual(0.15);
  });

  it('does NOT cap score when word_quality is above 0.05', () => {
    const goodMetrics = { ...baseMetrics, has_text_layer: 1, word_quality_estimate: 0.06, composite_score: 0.8 };
    saveQualityScore(db, 'https://example.com/good.pdf', 'hash4', goodMetrics);
    const row = db.prepare('SELECT composite_score FROM pdf_quality WHERE url=?').get('https://example.com/good.pdf');
    expect(row.composite_score).toBeCloseTo(0.8, 3);
  });

  it('replaces existing row on re-score', () => {
    saveQualityScore(db, 'https://example.com/b.pdf', 'hash5', baseMetrics);
    saveQualityScore(db, 'https://example.com/b.pdf', 'hash5b', { ...baseMetrics, composite_score: 0.9 });
    const rows = db.prepare('SELECT * FROM pdf_quality WHERE url=?').all('https://example.com/b.pdf');
    expect(rows).toHaveLength(1);
    expect(rows[0].composite_score).toBeCloseTo(0.9, 3);
  });
});

describe('maybeQueue', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('returns false and does not queue when score >= threshold', () => {
    const result = maybeQueue(db, 'https://example.com/a.pdf', 'h1', 0.75, 0.7);
    expect(result).toBe(false);
    const row = db.prepare('SELECT * FROM pdf_upgrade_queue').get();
    expect(row).toBeUndefined();
  });

  it('queues and returns true when score < threshold', () => {
    const result = maybeQueue(db, 'https://example.com/b.pdf', 'h2', 0.4, 0.7);
    expect(result).toBe(true);
    const row = db.prepare("SELECT * FROM pdf_upgrade_queue WHERE url=?").get('https://example.com/b.pdf');
    expect(row).toBeDefined();
    expect(row.status).toBe('pending');
    expect(row.priority).toBeGreaterThan(0);
  });

  it('returns false when existing record is not pending (already processing/done)', () => {
    db.prepare("INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at) VALUES (?,?,?,?,?)")
      .run('https://example.com/c.pdf', 'h3', 1.0, 'done', new Date().toISOString());
    const result = maybeQueue(db, 'https://example.com/c.pdf', 'h3', 0.3, 0.7);
    expect(result).toBe(false);
  });

  it('text-layer PDFs get higher priority (textBoost × 100)', () => {
    // image PDF (has_text_layer=0)
    maybeQueue(db, 'https://example.com/image.pdf', 'h4', 0.4, 0.7, 'english', 0);
    // text-layer PDF (has_text_layer=1) with same score
    maybeQueue(db, 'https://example.com/text.pdf', 'h5', 0.4, 0.7, 'english', 1);
    const image = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://example.com/image.pdf');
    const text = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://example.com/text.pdf');
    expect(text.priority).toBeGreaterThan(image.priority * 50); // 100× boost
  });

  it('can re-queue a pending document', () => {
    maybeQueue(db, 'https://example.com/d.pdf', 'h6', 0.4, 0.7);
    const result = maybeQueue(db, 'https://example.com/d.pdf', 'h6', 0.35, 0.7);
    expect(result).toBe(true);
  });

  it('Arabic percent-encoded URL gets very low priority (LANG_PRIORITY.arabic = 0.02)', () => {
    // Arabic URL — detectLanguageFromUrl returns 'arabic' → priority multiplier 0.02
    const arabicUrl = 'https://example.com/%D8%A8%D8%B3%D9%85.pdf';
    maybeQueue(db, arabicUrl, 'ha', 0.4, 0.7, 'english', 0);
    maybeQueue(db, 'https://example.com/english.pdf', 'he', 0.4, 0.7, 'english', 0);
    const arabic = db.prepare('SELECT priority FROM pdf_upgrade_queue WHERE url=?').get(arabicUrl);
    const english = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://example.com/english.pdf');
    // Arabic priority should be ~50× lower than English (0.02 vs 1.0)
    expect(arabic.priority).toBeLessThan(english.priority * 0.1);
  });

  it('prefers db-stored ai_language over passed language parameter', () => {
    // Insert db row with ai_language='persian'
    db.prepare('INSERT INTO pdf_quality (url, ai_language, has_text_layer) VALUES (?,?,?)')
      .run('https://example.com/persian.pdf', 'persian', 0);
    // Pass 'english' as language parameter — db should win
    maybeQueue(db, 'https://example.com/persian.pdf', 'hp', 0.4, 0.7, 'english', 0);
    maybeQueue(db, 'https://example.com/english.pdf', 'he', 0.4, 0.7, 'english', 0);
    const persian = db.prepare('SELECT priority FROM pdf_upgrade_queue WHERE url=?').get('https://example.com/persian.pdf');
    const english = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://example.com/english.pdf');
    // Persian (LANG_PRIORITY=0.02) should have lower priority than English (1.0)
    expect(persian.priority).toBeLessThan(english.priority * 0.1);
  });
});

describe('extractBadSample', () => {
  it('returns empty string for a nonexistent file', () => {
    expect(extractBadSample('/tmp/nonexistent-file-xyz.pdf')).toBe('');
  });

  it('returns a string (possibly empty) for a real file', () => {
    const tmp = join(tmpdir(), `test-bad-sample-${Date.now()}.txt`);
    writeFileSync(tmp, 'Hello world this is a test document');
    const result = extractBadSample(tmp);
    expect(typeof result).toBe('string');
  });

  it('respects maxChars limit', () => {
    const tmp = join(tmpdir(), `test-bad-sample-long-${Date.now()}.txt`);
    writeFileSync(tmp, 'word '.repeat(1000));
    const result = extractBadSample(tmp, 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
