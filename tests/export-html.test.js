import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
const testRoot = join(tmpdir(), `site2rag-export-html-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb } from '../src/db.js';
import { runExportHtml, exportHtmlPage } from '../src/export-html.js';
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
  // New regression tests
  it('exportHtmlPage with page_role=null stores source_hash=null in exports (preliminary)', () => {
    const htmlPath = join(htmlDir, 'prelim.html');
    writeFileSync(htmlPath, pageHtml('Preliminary', '<p>Some content here.</p>'));
    const page = {
      url: 'https://export.example.com/prelim', path_slug: 'prelim', local_path: htmlPath,
      content_hash: 'sha256:prelim', mime_type: 'text/html', depth: 1,
      page_role: null, last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const exp = db.prepare('SELECT source_hash FROM exports WHERE url=?').get('https://export.example.com/prelim');
    expect(exp).toBeTruthy();
    expect(exp.source_hash).toBeNull();
  });
  it('exportHtmlPage with page_role=content stores source_hash equal to content_hash', () => {
    const htmlPath = join(htmlDir, 'classified.html');
    writeFileSync(htmlPath, pageHtml('Classified', Array(20).fill('<p>Content text here for classified article.</p>').join('')));
    const page = {
      url: 'https://export.example.com/classified', path_slug: 'classified', local_path: htmlPath,
      content_hash: 'sha256:classified123', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const exp = db.prepare('SELECT source_hash FROM exports WHERE url=?').get('https://export.example.com/classified');
    expect(exp.source_hash).toBe('sha256:classified123');
  });
  it('frontmatter with title containing colon+space produces valid parseable YAML', () => {
    const htmlPath = join(htmlDir, 'colontest.html');
    writeFileSync(htmlPath, pageHtml('Site: A Title With Colon', Array(20).fill('<p>Content text paragraph.</p>').join('')));
    const page = {
      url: 'https://export.example.com/colontest', path_slug: 'colontest', local_path: htmlPath,
      content_hash: 'sha256:colon', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'colontest.md');
    expect(existsSync(mdPath)).toBe(true);
    const mdContent = readFileSync(mdPath, 'utf8');
    // Extract frontmatter block
    const fmMatch = mdContent.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    // Must parse without error -- yaml.load throws on invalid YAML
    let parsed;
    expect(() => { parsed = yaml.load(fmMatch[1]); }).not.toThrow();
    // The title field should be present
    expect(parsed).toBeTruthy();
  });
});
