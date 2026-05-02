// Tests for pdf_quality schema migration and report-server crash bugs.
// Bug 1: pdf_quality table missing columns (pdf_title, thumbnail_path, summary_tier, ai_language)
//        causes report-server to crash 257+ times with "no such column: q.pdf_title"
// Bug 2: siteDocs() db.prepare() throws synchronously, propagates as unhandled rejection,
//        crashing the server instead of returning a 500.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-report-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';

// The DOC_SELECT from report-server.js (copied verbatim to test schema compatibility)
const DOC_SELECT = `
  SELECT p.url, p.path_slug, p.last_seen_at,
         q.composite_score, q.pages, q.word_quality_estimate, q.readable_pages_pct,
         q.avg_chars_per_page, q.has_text_layer, q.skip,
         COALESCE(h.hosted_title, q.pdf_title) as title,
         q.excerpt, q.ai_summary, q.ai_author, q.ai_summarized_at,
         q.thumbnail_path, q.summary_tier, q.ai_language,
         h.host_url as source_url,
         u.status, u.before_score, u.after_score, u.score_improvement,
         u.upgraded_pdf_path, u.pages_processed, u.method, u.finished_at, u.error
  FROM pages p
  LEFT JOIN pdf_quality q ON p.url=q.url
  LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
  LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON p.url=h.hosted_url`;

/** Create a DB with the OLD pdf_quality schema (missing the new columns), simulating tower-nas state. */
const createOldSchemaDb = (dbPath) => {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY, path_slug TEXT, local_path TEXT,
      from_sitemap INT DEFAULT 0, content_hash TEXT, mime_type TEXT,
      status_code INT, depth INT, first_seen_at TEXT, last_seen_at TEXT,
      last_changed_at TEXT, gone INT DEFAULT 0, page_role TEXT
    );
    CREATE TABLE IF NOT EXISTS hosts (
      host_url TEXT NOT NULL, hosted_url TEXT NOT NULL, hosted_title TEXT,
      PRIMARY KEY (host_url, hosted_url)
    );
    CREATE TABLE IF NOT EXISTS pdf_quality (
      url TEXT PRIMARY KEY,
      content_hash TEXT, scored_at TEXT,
      avg_chars_per_page REAL, readable_pages_pct REAL,
      has_text_layer INT, word_quality_estimate REAL,
      composite_score REAL, pages INT
      -- MISSING: pdf_title, excerpt, skip, ai_summary, ai_author, ai_summarized_at,
      --          thumbnail_path, summary_tier, ai_language
    );
    CREATE TABLE IF NOT EXISTS pdf_upgrade_queue (
      url TEXT PRIMARY KEY, content_hash TEXT, priority REAL,
      status TEXT DEFAULT 'pending', queued_at TEXT, started_at TEXT,
      finished_at TEXT, upgraded_pdf_path TEXT, before_score REAL,
      after_score REAL, score_improvement REAL, pages_processed INT,
      method TEXT, error TEXT
    );
  `);
  db.close();
};

describe('pdf_quality schema migration (Bug 1)', () => {
  let dbPath;

  beforeEach(() => {
    const dir = join(testRoot, 'test-domain', '_meta');
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, 'site.sqlite');
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('DOC_SELECT fails on old schema (demonstrates the bug)', () => {
    createOldSchemaDb(dbPath);
    const db = new Database(dbPath);
    expect(() => db.prepare(`${DOC_SELECT} WHERE p.gone=0 AND p.mime_type='application/pdf'`))
      .toThrow(/no such column/i);
    db.close();
  });

  it('openDb migration adds all required columns to pdf_quality', () => {
    createOldSchemaDb(dbPath);
    // openDb runs migrate() which should add the missing columns
    const db = openDb('test-domain');
    const cols = db.pragma('table_info(pdf_quality)').map(r => r.name);
    expect(cols).toContain('pdf_title');
    expect(cols).toContain('excerpt');
    expect(cols).toContain('skip');
    expect(cols).toContain('ai_summary');
    expect(cols).toContain('ai_author');
    expect(cols).toContain('ai_summarized_at');
    expect(cols).toContain('thumbnail_path');
    expect(cols).toContain('summary_tier');
    expect(cols).toContain('ai_language');
    db.close();
  });

  it('DOC_SELECT succeeds after openDb migration', () => {
    createOldSchemaDb(dbPath);
    const db = openDb('test-domain');
    expect(() => db.prepare(`${DOC_SELECT} WHERE p.gone=0 AND p.mime_type='application/pdf'`))
      .not.toThrow();
    db.close();
  });
});

describe('summarize-pdfs schema guard (Bug 3)', () => {
  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('runSummarizePdfs crashes without guard when ai_summarized_at is missing', async () => {
    // Simulate old tower-nas DB missing migration columns
    const dir = join(testRoot, 'summarize-domain', '_meta');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'site.sqlite');
    createOldSchemaDb(dbPath);
    const db = new Database(dbPath);
    // Direct prepare of the query that summarize-pdfs uses — should throw on old schema
    expect(() => db.prepare(`
      SELECT q.url FROM pdf_quality q WHERE q.ai_summarized_at IS NULL
    `)).toThrow(/no such column/i);
    db.close();
  });

  it('runSummarizePdfs returns empty stats when schema is old (no crash)', async () => {
    const dir = join(testRoot, 'summarize-domain2', '_meta');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'site.sqlite');
    createOldSchemaDb(dbPath);
    // Use openDb so migrations run, but test the guard exists even without that
    const { runSummarizePdfs } = await import('../src/summarize-pdfs.js');
    const db = new Database(dbPath); // open without migrations to simulate old state
    const stats = await runSummarizePdfs(db, { domain: 'summarize-domain2' });
    expect(stats).toMatchObject({ summarized: 0, skipped: 0 });
    db.close();
  });
});

describe('siteDocs error handling (Bug 2)', () => {
  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('DOC_SELECT prepare() on bad schema throws synchronously (not an async rejection)', () => {
    const dir = join(testRoot, 'bad-domain', '_meta');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'site.sqlite');
    createOldSchemaDb(dbPath);
    const db = new Database(dbPath);
    // db.prepare throws synchronously -- this is what escapes request handlers
    let threw = false;
    try {
      db.prepare(`${DOC_SELECT} WHERE p.gone=0`);
    } catch (e) {
      threw = true;
      expect(e.message).toMatch(/no such column/i);
    }
    expect(threw).toBe(true);
    db.close();
  });
});
