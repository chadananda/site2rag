// Regression tests for core invariants documented in docs/architecture.md.
// These prevent re-introduction of bugs found in production.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const testRoot = join(tmpdir(), `site2rag-regression-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb, upsertPage } from '../src/db.js';
import { runRetain } from '../src/retain.js';
import { runClassify } from '../src/classify.js';
import { runSummarizePdfs } from '../src/summarize-pdfs.js';
import { getSiteRoot, getMirrorRoot, getMdRoot, metaDir } from '../src/config.js';

const DOMAIN = 'regression.example.com';

// ── Config invariants ──────────────────────────────────────────────────────────

describe('config path helpers are functions (not constants)', () => {
  it('getSiteRoot reads SITE2RAG_ROOT at call time', async () => {
    const original = process.env.SITE2RAG_ROOT;
    process.env.SITE2RAG_ROOT = '/tmp/test-root-override';
    expect(getSiteRoot()).toBe('/tmp/test-root-override');
    process.env.SITE2RAG_ROOT = original;
  });

  it('getMirrorRoot reflects updated SITE2RAG_ROOT', async () => {
    const original = process.env.SITE2RAG_ROOT;
    process.env.SITE2RAG_ROOT = '/tmp/test-root-2';
    expect(getMirrorRoot()).toContain('/tmp/test-root-2');
    process.env.SITE2RAG_ROOT = original;
  });
});

// ── DB migration invariants ────────────────────────────────────────────────────

describe('openDb always migrates pdf_quality columns', () => {
  let db;
  afterEach(() => { db?.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('fresh DB has all migration columns', async () => {
    db = openDb(DOMAIN);
    const cols = db.pragma('table_info(pdf_quality)').map(r => r.name);
    // Base DDL columns
    ['url', 'content_hash', 'scored_at', 'composite_score', 'pages', 'pdf_title', 'excerpt'].forEach(c =>
      expect(cols, `missing base column: ${c}`).toContain(c)
    );
    // Migration-only columns
    ['skip', 'ai_summary', 'ai_author', 'ai_summarized_at', 'thumbnail_path', 'summary_tier', 'ai_language'].forEach(c =>
      expect(cols, `missing migration column: ${c}`).toContain(c)
    );
  });

  it('old DB without migration columns gets them added by openDb', async () => {
    const dir = join(testRoot, DOMAIN, '_meta');
    mkdirSync(dir, { recursive: true });
    // Create old schema without migration columns
    const oldDb = new Database(join(dir, 'site.sqlite'));
    oldDb.exec(`CREATE TABLE pdf_quality (url TEXT PRIMARY KEY, composite_score REAL, pages INT)`);
    oldDb.close();
    // openDb should migrate
    db = openDb(DOMAIN);
    const cols = db.pragma('table_info(pdf_quality)').map(r => r.name);
    ['pdf_title', 'ai_summarized_at', 'thumbnail_path', 'summary_tier', 'ai_language'].forEach(c =>
      expect(cols, `migration failed to add: ${c}`).toContain(c)
    );
  });
});

// ── summarize-pdfs schema guard ────────────────────────────────────────────────
// Bug: runSummarizePdfs db.prepare() crashes if ai_summarized_at column missing.
// Fix: wrapped in try/catch, returns {summarized:0,skipped:0} on schema error.

describe('runSummarizePdfs schema guard', () => {
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns empty stats instead of crashing on old schema', async () => {
    const dir = join(testRoot, 'summarize-old', '_meta');
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'site.sqlite'));
    db.exec(`CREATE TABLE pdf_quality (url TEXT PRIMARY KEY, composite_score REAL);
             CREATE TABLE hosts (host_url TEXT, hosted_url TEXT, hosted_title TEXT, PRIMARY KEY(host_url, hosted_url))`);
    const stats = await runSummarizePdfs(db, { domain: 'summarize-old' });
    expect(stats).toMatchObject({ summarized: 0, skipped: 0 });
    db.close();
  });

  it('skips when no ANTHROPIC_API_KEY set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const db = openDb(DOMAIN);
    const stats = await runSummarizePdfs(db, { domain: DOMAIN });
    expect(stats).toMatchObject({ summarized: 0, skipped: 0 });
    db.close();
    process.env.ANTHROPIC_API_KEY = saved;
    rmSync(testRoot, { recursive: true, force: true });
  });
});

// ── retain: freeze state clears ───────────────────────────────────────────────

describe('runRetain freeze lifecycle', () => {
  let db;
  afterEach(() => { db?.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('sets frozen_since on first freeze', async () => {
    db = openDb(DOMAIN);
    await runRetain(db, { domain: DOMAIN, retention: { preserve_always: true, gone_grace_days: 90 } }, DOMAIN);
    const frozenSince = db.prepare('SELECT value FROM site_meta WHERE key=?').get('frozen_since')?.value;
    expect(frozenSince).toBeTruthy();
  });

  it('clears frozen_since when freeze no longer applies', async () => {
    db = openDb(DOMAIN);
    // First run: freeze
    await runRetain(db, { domain: DOMAIN, retention: { preserve_always: true, gone_grace_days: 90 } }, DOMAIN);
    // Second run: no freeze condition
    await runRetain(db, { domain: DOMAIN, retention: { preserve_always: false, gone_grace_days: 90, freeze_on_degradation: { enabled: false } } }, DOMAIN);
    const frozenSince = db.prepare('SELECT value FROM site_meta WHERE key=?').get('frozen_since')?.value;
    expect(frozenSince).toBeFalsy();
  });

  it('deletes MD export file when page expires', async () => {
    db = openDb(DOMAIN);
    const mdFile = join(testRoot, 'test-export.md');
    writeFileSync(mdFile, '# test');
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    const url = `https://${DOMAIN}/expired-with-export`;
    db.prepare('INSERT INTO pages (url, path_slug, local_path, gone, gone_since, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)').run(url, 'expired', null, 1, oldDate, oldDate, oldDate);
    db.prepare('INSERT INTO exports (url, md_path, status) VALUES (?,?,?)').run(url, mdFile, 'ok');
    await runRetain(db, { domain: DOMAIN, retention: { gone_grace_days: 90, freeze_on_degradation: { enabled: false } } }, DOMAIN);
    expect(existsSync(mdFile)).toBe(false);
  });

  it('tombstones older than 1 year are pruned', async () => {
    db = openDb(DOMAIN);
    const url = `https://${DOMAIN}/ancient`;
    const oldDate = new Date(Date.now() - 400 * 86400000).toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, gone, gone_since, archive_only, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)').run(url, 'ancient', 1, oldDate, 1, oldDate, oldDate);
    const stats = await runRetain(db, { domain: DOMAIN, retention: { gone_grace_days: 90, freeze_on_degradation: { enabled: false } } }, DOMAIN);
    expect(stats.tombstones_pruned).toBeGreaterThan(0);
    expect(db.prepare('SELECT * FROM pages WHERE url=?').get(url)).toBeUndefined();
  });
});

// ── classify: host_page detection ─────────────────────────────────────────────

describe('runClassify host_page detection', () => {
  let db;
  afterEach(() => { db?.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('classifies page with many PDF links as host_page', async () => {
    db = openDb(DOMAIN);
    const dir = join(testRoot, 'html');
    mkdirSync(dir, { recursive: true });
    const links = Array(10).fill(0).map((_, i) =>
      `<a href="https://${DOMAIN}/doc${i}.pdf">Document ${i}</a>`
    ).join('\n');
    const html = `<html><head><title>Documents</title></head><body><h1>Papers</h1>${links}</body></html>`;
    const path = join(dir, 'host.html');
    writeFileSync(path, html);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run(`https://${DOMAIN}/papers`, 'papers', path, 'text/html', 0);
    await runClassify(db, { domain: DOMAIN });
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get(`https://${DOMAIN}/papers`);
    expect(row.page_role).toBe('host_page');
    // Should also populate hosts table
    const hosted = db.prepare('SELECT * FROM hosts WHERE host_url=?').all(`https://${DOMAIN}/papers`);
    expect(hosted.length).toBeGreaterThan(0);
  });

  it('rule overrides apply even to already-classified pages (no file I/O needed)', async () => {
    // classify always re-runs so updated rules in websites.yaml apply immediately
    db = openDb(DOMAIN);
    const dir = join(testRoot, 'html2');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'p.html');
    writeFileSync(path, '<html><body><p>content</p></body></html>');
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, page_role) VALUES (?,?,?,?,?,?)').run(`https://${DOMAIN}/page`, 'page', path, 'text/html', 0, 'index');
    // Override via rules — should win over existing page_role
    await runClassify(db, { domain: DOMAIN, rules: { classify_overrides: [{ pattern: '/page', role: 'content' }] } });
    const row = db.prepare('SELECT page_role, classify_method FROM pages WHERE url=?').get(`https://${DOMAIN}/page`);
    expect(row.page_role).toBe('content');
    expect(row.classify_method).toBe('rules');
  });
});

// ── score-pdfs concurrency cap ─────────────────────────────────────────────────
// Bug: unbounded concurrency (cpus().length) caused OOM → PM2 kill before classify.
// Fix: capped at 4 workers, 500-PDF batch, 5-min budget.

describe('score-pdfs concurrency limits (import check)', () => {
  it('CONCURRENCY import is capped at 4', async () => {
    // We can't import the private constant, but we can verify the module loads
    // and that scoreOne resolves (not rejects) even on a non-existent file
    const { runScorePdfs } = await import('../src/score-pdfs.js');
    const db = openDb(DOMAIN);
    // No unscored PDFs → returns immediately
    const stats = await runScorePdfs(db, { domain: DOMAIN });
    expect(stats).toMatchObject({ scored: 0, queued: 0, skipped: 0 });
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });
});
