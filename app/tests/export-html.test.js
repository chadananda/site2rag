import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const testRoot = join(tmpdir(), `site2rag-export-html-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb, upsertPage } from '../src/db.js';
import { runExportHtml } from '../src/export-html.js';
import { mdDir } from '../src/config.js';
const DOMAIN = 'export.example.com';
const pageHtml = (title, body) => `<!DOCTYPE html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
describe('runExportHtml', () => {
  let db, htmlDir;
  beforeEach(() => {
    htmlDir = join(testRoot, 'html');
    mkdirSync(htmlDir, { recursive: true });
    db = openDb(DOMAIN); // openDb calls metaDir() which is lazy -- creates correct dirs
    mkdirSync(mdDir(DOMAIN), { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });
  it('exports HTML page to MD with frontmatter', () => {
    const htmlPath = join(htmlDir, 'article.html');
    const content = Array(30).fill('<p>This is content text for the article with many words.</p>').join('');
    writeFileSync(htmlPath, pageHtml('Test Article', content));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, page_role, content_hash, depth) VALUES (?,?,?,?,?,?,?,?)').run('https://export.example.com/article', 'article', htmlPath, 'text/html', 0, 'content', 'sha256:abc123', 1);
    const stats = runExportHtml(db, { domain: DOMAIN, export_md: true, assets: { rewrite_links: false } });
    expect(stats.written).toBe(1);
    expect(stats.failed).toBe(0);
    const mdPath = join(mdDir(DOMAIN), 'article.md');
    expect(existsSync(mdPath)).toBe(true);
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('---');
    expect(mdContent).toContain('source_url: https://export.example.com/article');
    expect(mdContent).toContain('page_role: content');
  });
  it('skips pages with unchanged content hash', () => {
    const htmlPath = join(htmlDir, 'unchanged.html');
    writeFileSync(htmlPath, pageHtml('Unchanged', '<p>Content</p>'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, page_role, content_hash, depth) VALUES (?,?,?,?,?,?,?,?)').run('https://export.example.com/unchanged', 'unchanged', htmlPath, 'text/html', 0, 'content', 'sha256:same', 1);
    // Pre-populate exports with same hash
    db.prepare('INSERT INTO exports (url, source_hash, status) VALUES (?,?,?)').run('https://export.example.com/unchanged', 'sha256:same', 'ok');
    const stats = runExportHtml(db, { domain: DOMAIN, export_md: true, assets: { rewrite_links: false } });
    expect(stats.skipped).toBe(1);
    expect(stats.written).toBe(0);
  });
});
