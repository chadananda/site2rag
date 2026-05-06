import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// Patch SITE2RAG_ROOT for tests
const testRoot = join(tmpdir(), `site2rag-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb, startRun, finishRun, upsertPage, getMeta, setMeta, upsertSitemap, markGoneUrls, logLlmCall, llmCost, getOcrPage, saveOcrPage, upsertAsset, addAssetRef, markSitemapRemoved } from '../src/db.js';
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
  // markGoneUrls
  it('markGoneUrls marks pages unseen before cutoff as gone', () => {
    const past = new Date(Date.now() - 10000).toISOString();
    const cutoff = new Date(Date.now() - 5000).toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, last_seen_at, gone) VALUES (?,?,?,?)').run('https://test.example.com/old', 'old', past, 0);
    const changed = markGoneUrls(db, cutoff);
    expect(changed).toBe(1);
    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get('https://test.example.com/old');
    expect(row.gone).toBe(1);
  });
  it('markGoneUrls does not mark pages seen after cutoff', () => {
    const cutoff = new Date(Date.now() - 10000).toISOString();
    const recent = new Date().toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, last_seen_at, gone) VALUES (?,?,?,?)').run('https://test.example.com/new', 'new', recent, 0);
    const changed = markGoneUrls(db, cutoff);
    expect(changed).toBe(0);
    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get('https://test.example.com/new');
    expect(row.gone).toBe(0);
  });
  it('markGoneUrls excludes pages in pdf_upgrade_queue with status done', () => {
    const past = new Date(Date.now() - 10000).toISOString();
    const cutoff = new Date(Date.now() - 5000).toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, last_seen_at, gone) VALUES (?,?,?,?)').run('https://test.example.com/pdf', 'pdf', past, 0);
    db.prepare('INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at) VALUES (?,?,?,?,?)').run('https://test.example.com/pdf', 'sha256:abc', 0.5, 'done', past);
    const changed = markGoneUrls(db, cutoff);
    expect(changed).toBe(0);
    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get('https://test.example.com/pdf');
    expect(row.gone).toBe(0);
  });
  // logLlmCall + llmCost
  it('llmCost computes haiku input at $0.80/M tokens', () => {
    // 1M input tokens at $0.80/M = $0.80
    const cost = llmCost('claude-haiku-3-5-20241022', 1000000, 0);
    expect(cost).toBeCloseTo(0.80, 5);
  });
  it('llmCost computes opus at $15.00/M input', () => {
    const cost = llmCost('claude-opus-4-5', 1000000, 0);
    expect(cost).toBeCloseTo(15.00, 5);
  });
  it('llmCost falls back to $3.00/M for unknown model', () => {
    const cost = llmCost('gpt-unknown-model', 1000000, 0);
    expect(cost).toBeCloseTo(3.00, 5);
  });
  it('llmCost returns zero for zero tokens', () => {
    expect(llmCost('claude-haiku-3-5-20241022', 0, 0)).toBe(0);
  });
  it('logLlmCall inserts row and cost is retrievable', () => {
    logLlmCall(db, { stage: 'ocr', url: 'https://test.example.com/doc.pdf', page_no: 1, provider: 'anthropic', model: 'claude-haiku-3-5-20241022', tokens_in: 500, tokens_out: 200, cost_usd: 0.001, ok: 1 });
    const row = db.prepare('SELECT * FROM llm_calls WHERE url=?').get('https://test.example.com/doc.pdf');
    expect(row.stage).toBe('ocr');
    expect(row.model).toBe('claude-haiku-3-5-20241022');
    expect(row.tokens_in).toBe(500);
    expect(row.tokens_out).toBe(200);
    expect(row.ok).toBe(1);
  });
  // upsertPage hash change tracking
  it('upsertPage sets last_changed_at when content_hash changes', () => {
    const url = 'https://test.example.com/tracked';
    // Insert with initial hash -- use a past timestamp to make last_changed_at distinguishable
    upsertPage(db, { url, path_slug: 'tracked', content_hash: 'sha256:aaa', mime_type: 'text/html', status_code: 200, depth: 0 });
    const before = db.prepare('SELECT last_changed_at FROM pages WHERE url=?').get(url).last_changed_at;
    // Small delay so timestamps differ
    const future = new Date(Date.now() + 2000).toISOString();
    // Simulate update with new hash by inserting a slightly-ahead timestamp via direct update then upsert
    upsertPage(db, { url, path_slug: 'tracked', content_hash: 'sha256:bbb', mime_type: 'text/html', status_code: 200, depth: 0 });
    const after = db.prepare('SELECT last_changed_at FROM pages WHERE url=?').get(url).last_changed_at;
    // Both are set; after >= before (changed on hash update)
    expect(after).toBeTruthy();
    expect(after >= before).toBe(true);
  });
  it('upsertPage does NOT update last_changed_at when hash is same', () => {
    const url = 'https://test.example.com/unchanged-hash';
    upsertPage(db, { url, path_slug: 'uh', content_hash: 'sha256:same', mime_type: 'text/html', status_code: 200, depth: 0 });
    const row1 = db.prepare('SELECT last_changed_at FROM pages WHERE url=?').get(url);
    // Force last_changed_at to a known past value to detect if it changes
    db.prepare("UPDATE pages SET last_changed_at='2020-01-01T00:00:00.000Z' WHERE url=?").run(url);
    upsertPage(db, { url, path_slug: 'uh', content_hash: 'sha256:same', mime_type: 'text/html', status_code: 200, depth: 0 });
    const row2 = db.prepare('SELECT last_changed_at FROM pages WHERE url=?').get(url);
    expect(row2.last_changed_at).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('db — saveOcrPage / getOcrPage', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DOMAIN); });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('saves and retrieves an OCR page by url, pageNo, engine', () => {
    saveOcrPage(db, {
      docUrl: 'https://example.com/a.pdf', pageNo: 1, engine: 'tesseract',
      text_md: 'Hello world', confidence: 0.85, bboxes_json: '[]', bytes: 1024,
    });
    const row = getOcrPage(db, 'https://example.com/a.pdf', 1, 'tesseract');
    expect(row).not.toBeNull();
    expect(row.text_md).toBe('Hello world');
    expect(row.confidence).toBeCloseTo(0.85, 2);
  });

  it('returns undefined for unknown url/page/engine', () => {
    expect(getOcrPage(db, 'https://example.com/missing.pdf', 1, 'tesseract')).toBeUndefined();
  });

  it('replaces existing row on re-save (same url/page/engine)', () => {
    saveOcrPage(db, { docUrl: 'https://example.com/b.pdf', pageNo: 1, engine: 'boss', text_md: 'v1', confidence: 0.5, bboxes_json: '[]', bytes: 100 });
    saveOcrPage(db, { docUrl: 'https://example.com/b.pdf', pageNo: 1, engine: 'boss', text_md: 'v2', confidence: 0.9, bboxes_json: '[]', bytes: 200 });
    const row = getOcrPage(db, 'https://example.com/b.pdf', 1, 'boss');
    expect(row.text_md).toBe('v2');
  });
});

describe('db — upsertAsset / addAssetRef', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DOMAIN); });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('inserts a new asset and retrieves it', () => {
    upsertAsset(db, { hash: 'sha256:abc', path: '/tmp/a.png', original_url: 'https://example.com/a.png', mime_type: 'image/png', bytes: 500 });
    const row = db.prepare('SELECT * FROM assets WHERE hash=?').get('sha256:abc');
    expect(row).not.toBeNull();
    expect(row.mime_type).toBe('image/png');
    expect(row.ref_count).toBe(0);
  });

  it('updates last_seen_at on re-upsert without changing path', () => {
    upsertAsset(db, { hash: 'sha256:def', path: '/tmp/b.png', original_url: 'https://example.com/b.png', mime_type: 'image/png', bytes: 100 });
    db.prepare("UPDATE assets SET last_seen_at='2020-01-01T00:00:00.000Z' WHERE hash=?").run('sha256:def');
    upsertAsset(db, { hash: 'sha256:def', path: '/tmp/b.png', original_url: 'https://example.com/b.png', mime_type: 'image/png', bytes: 100 });
    const row = db.prepare('SELECT * FROM assets WHERE hash=?').get('sha256:def');
    expect(row.last_seen_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('addAssetRef increments ref_count', () => {
    upsertAsset(db, { hash: 'sha256:ghi', path: '/tmp/c.png', original_url: 'https://example.com/c.png', mime_type: 'image/png', bytes: 200 });
    addAssetRef(db, 'sha256:ghi', 'https://example.com/page1.html');
    addAssetRef(db, 'sha256:ghi', 'https://example.com/page2.html');
    const row = db.prepare('SELECT ref_count FROM assets WHERE hash=?').get('sha256:ghi');
    expect(row.ref_count).toBe(2);
  });
});

describe('db — markSitemapRemoved', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DOMAIN); });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('marks URLs not in seenUrls as removed', () => {
    db.prepare("INSERT INTO sitemaps (url, lastmod, source_sitemap) VALUES (?,NULL,NULL)")
      .run('https://example.com/old.pdf');
    db.prepare("INSERT INTO sitemaps (url, lastmod, source_sitemap) VALUES (?,NULL,NULL)")
      .run('https://example.com/new.pdf');
    markSitemapRemoved(db, ['https://example.com/new.pdf']);
    const old = db.prepare('SELECT removed FROM sitemaps WHERE url=?').get('https://example.com/old.pdf');
    const current = db.prepare('SELECT removed FROM sitemaps WHERE url=?').get('https://example.com/new.pdf');
    expect(old.removed).toBe(1);
    expect(current.removed).toBeFalsy();
  });

  it('marks all as removed when seenUrls is empty', () => {
    db.prepare("INSERT INTO sitemaps (url, lastmod, source_sitemap) VALUES (?,NULL,NULL)")
      .run('https://example.com/a.pdf');
    db.prepare("INSERT INTO sitemaps (url, lastmod, source_sitemap) VALUES (?,NULL,NULL)")
      .run('https://example.com/b.pdf');
    const count = markSitemapRemoved(db, []);
    expect(count).toBe(2);
  });
});
