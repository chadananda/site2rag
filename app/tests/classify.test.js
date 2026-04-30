import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const testRoot = join(tmpdir(), `site2rag-classify-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb, upsertPage } from '../src/db.js';
import { runClassify } from '../src/classify.js';
const DOMAIN = 'classify.example.com';
const pageHtml = (body, title = 'Test') => `<!DOCTYPE html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
describe('runClassify', () => {
  let db, tmpDir;
  beforeEach(() => {
    tmpDir = join(testRoot, 'html');
    mkdirSync(tmpDir, { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });
  it('classifies content pages', () => {
    const path = join(tmpDir, 'article.html');
    const body = Array(50).fill('<p>This is a paragraph of content text with lots of words and information about a topic.</p>').join('');
    writeFileSync(path, pageHtml(body, 'Article'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/article', 'article', path, 'text/html', 0);
    const stats = runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/article');
    expect(row.page_role).toBe('content');
    expect(stats.classified).toBe(1);
  });
  it('classifies redirect pages', () => {
    const path = join(tmpDir, 'redirect.html');
    writeFileSync(path, pageHtml('<p>See <a href="https://classify.example.com/new">new page</a></p>', 'Redirect'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/redirect', 'redirect', path, 'text/html', 0);
    runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/redirect');
    expect(row.page_role).toBe('redirect');
  });
  it('applies classify_overrides from rules', () => {
    const path = join(tmpDir, 'manual.html');
    writeFileSync(path, pageHtml('<p>Some content</p>', 'Manual'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/manual', 'manual', path, 'text/html', 0);
    const stats = runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 }, rules: { classify_overrides: [{ pattern: '/manual', role: 'index' }] } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/manual');
    expect(row.page_role).toBe('index');
    expect(row.classify_method).toBe('rules');
    expect(stats.rule_overrides).toBe(1);
  });
});
