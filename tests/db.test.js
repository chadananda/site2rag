import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// Patch SITE2RAG_ROOT for tests
const testRoot = join(tmpdir(), `site2rag-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb, startRun, finishRun, upsertPage, getMeta, setMeta, upsertSitemap } from '../src/db.js';
const TEST_DOMAIN = 'test.example.com';
describe('db', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DOMAIN); // openDb creates dirs via metaDir() which is lazy
  });
  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });
  it('creates all tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    ['runs', 'pages', 'hosts', 'sitemaps', 'exports', 'ocr_pages', 'assets', 'asset_refs', 'llm_calls', 'site_meta'].forEach(t => {
      expect(tables).toContain(t);
    });
  });
  it('startRun / finishRun cycle', () => {
    const id = startRun(db);
    expect(id).toBeGreaterThan(0);
    finishRun(db, id, 'success', { pages_new: 5 });
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    expect(row.status).toBe('success');
    expect(row.pages_new).toBe(5);
    expect(row.finished_at).toBeTruthy();
  });
  it('upsertPage inserts new page', () => {
    upsertPage(db, { url: 'https://test.example.com/', path_slug: 'index', local_path: '/tmp/index.html', from_sitemap: 0, content_hash: 'sha256:abc', mime_type: 'text/html', status_code: 200, depth: 0 });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://test.example.com/');
    expect(row.path_slug).toBe('index');
    expect(row.gone).toBe(0);
  });
  it('upsertPage updates existing page', () => {
    const url = 'https://test.example.com/page';
    upsertPage(db, { url, path_slug: 'page', local_path: '/tmp/page.html', from_sitemap: 0, content_hash: 'sha256:aaa', mime_type: 'text/html', status_code: 200, depth: 1 });
    upsertPage(db, { url, path_slug: 'page', local_path: '/tmp/page.html', from_sitemap: 0, content_hash: 'sha256:bbb', mime_type: 'text/html', status_code: 200, depth: 1 });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get(url);
    expect(row.content_hash).toBe('sha256:bbb');
  });
  it('getMeta / setMeta round-trip', () => {
    setMeta(db, 'test_key', 'test_value');
    expect(getMeta(db, 'test_key')).toBe('test_value');
  });
  it('upsertSitemap inserts and updates', () => {
    upsertSitemap(db, { url: 'https://test.example.com/sitemap.xml', lastmod: '2024-01-01', source_sitemap: 'https://test.example.com/sitemap_index.xml' });
    const row = db.prepare('SELECT * FROM sitemaps WHERE url=?').get('https://test.example.com/sitemap.xml');
    expect(row.lastmod).toBe('2024-01-01');
    upsertSitemap(db, { url: 'https://test.example.com/sitemap.xml', lastmod: '2024-02-01', source_sitemap: 'https://test.example.com/sitemap_index.xml' });
    const updated = db.prepare('SELECT * FROM sitemaps WHERE url=?').get('https://test.example.com/sitemap.xml');
    expect(updated.lastmod).toBe('2024-02-01');
    expect(updated.removed).toBe(0);
  });
});
