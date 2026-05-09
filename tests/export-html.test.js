import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
const testRoot = join(tmpdir(), `site2rag-export-html-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb } from '../src/db.js';
import { runExportHtml, exportHtmlPage, buildFrontmatter } from '../src/export-html.js';
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
  it('archive_only=true appears as boolean true in frontmatter', () => {
    const htmlPath = join(htmlDir, 'archived.html');
    writeFileSync(htmlPath, pageHtml('Archived', Array(20).fill('<p>Some archived content.</p>').join('')));
    const page = {
      url: 'https://export.example.com/archived', path_slug: 'archived', local_path: htmlPath,
      content_hash: 'sha256:arc', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 1, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'archived.md');
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('archive_only: true');
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

  it('host_page role exports hosts JSON in frontmatter', () => {
    const htmlPath = join(htmlDir, 'hostpage.html');
    writeFileSync(htmlPath, pageHtml('Document Host', '<p>Hosts several documents.</p><a href="https://export.example.com/report.pdf">Report</a>'));
    const page = {
      url: 'https://export.example.com/hostpage', path_slug: 'hostpage', local_path: htmlPath,
      content_hash: 'sha256:host', mime_type: 'text/html', depth: 1,
      page_role: 'host_page', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    db.prepare('INSERT OR REPLACE INTO hosts (host_url, hosted_url, hosted_title, detected_at) VALUES (?,?,?,?)').run('https://export.example.com/hostpage', 'https://export.example.com/report.pdf', 'Report', new Date().toISOString());
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'hostpage.md');
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('hosts:');
  });

  it('content_selector in rules uses that element for conversion', () => {
    const htmlPath = join(htmlDir, 'selectorpage.html');
    writeFileSync(htmlPath, pageHtml('Selector Test', '<nav>Nav junk</nav><article><p>Main article content here.</p></article>'));
    const page = {
      url: 'https://export.example.com/selectorpage', path_slug: 'selectorpage', local_path: htmlPath,
      content_hash: 'sha256:sel', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false }, rules: { content_selector: 'article' } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'selectorpage.md');
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('Main article content here');
    expect(mdContent).toContain('rules+turndown');
  });

  it('exclude_selectors removes matching elements before conversion', () => {
    const htmlPath = join(htmlDir, 'exclude.html');
    writeFileSync(htmlPath, pageHtml('Exclude Test', '<article><p>Keep this.</p><aside>Remove this.</aside></article>'));
    const page = {
      url: 'https://export.example.com/exclude', path_slug: 'exclude', local_path: htmlPath,
      content_hash: 'sha256:excl', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false }, rules: { content_selector: 'article', exclude_selectors: ['aside'] } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'exclude.md');
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('Keep this');
    expect(mdContent).not.toContain('Remove this');
  });

  it('title_selector overrides title in frontmatter', () => {
    const htmlPath = join(htmlDir, 'titleselector.html');
    writeFileSync(htmlPath, pageHtml('Default Title', '<h1 class="main-title">Custom Title</h1>' + Array(20).fill('<p>Content text.</p>').join('')));
    const page = {
      url: 'https://export.example.com/titleselector', path_slug: 'titleselector', local_path: htmlPath,
      content_hash: 'sha256:tsel', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false }, rules: { title_selector: '.main-title' } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'titleselector.md');
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('Custom Title');
    expect(mdContent).not.toContain('Default Title');
  });

  it('exportHtmlPage returns false and records error when page export throws', () => {
    // Pass a page with bad local_path that doesn't exist to trigger error path via exportHtmlPage
    // Actually exportHtmlPage doesn't check existence -- pass truly broken HTML to force an error
    // The safest path: call with page that has invalid URL so new URL() throws in frontmatter
    const page = {
      url: 'https://export.example.com/errpage', path_slug: 'errpage', local_path: null,
      content_hash: 'sha256:err', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    // Pass null htmlStr to trigger a throw in cheerio/readability
    const result = exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, null);
    expect(result).toBe(false);
    const exp = db.prepare('SELECT status FROM exports WHERE url=?').get('https://export.example.com/errpage');
    expect(exp?.status).toBe('failed');
  });

  it('runExportHtml increments failed when local_path does not exist', () => {
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, page_role, content_hash, depth) VALUES (?,?,?,?,?,?,?,?)').run(
      'https://export.example.com/missing', 'missing', join(htmlDir, 'missing.html'), 'text/html', 0, 'content', 'sha256:miss', 1
    );
    const stats = runExportHtml(db, { domain: DOMAIN, assets: { rewrite_links: false } });
    expect(stats.failed).toBe(1);
    expect(stats.written).toBe(0);
  });

  it('frontmatter with title starting with single-quote produces valid parseable YAML', () => {
    const htmlPath = join(htmlDir, 'squotetest.html');
    writeFileSync(htmlPath, pageHtml("'Quoted Title': A Story", Array(20).fill('<p>Content text paragraph.</p>').join('')));
    const page = {
      url: 'https://export.example.com/squotetest', path_slug: 'squotetest', local_path: htmlPath,
      content_hash: 'sha256:squote', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'squotetest.md');
    expect(existsSync(mdPath)).toBe(true);
    const mdContent = readFileSync(mdPath, 'utf8');
    const fmMatch = mdContent.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    let parsed;
    expect(() => { parsed = yaml.load(fmMatch[1]); }).not.toThrow();
    expect(parsed).toBeTruthy();
  });

  it('frontmatter with title starting with double-quote produces valid parseable YAML', () => {
    const htmlPath = join(htmlDir, 'dquotetest.html');
    writeFileSync(htmlPath, pageHtml('"Quoted Title" Study', Array(20).fill('<p>Content text paragraph.</p>').join('')));
    const page = {
      url: 'https://export.example.com/dquotetest', path_slug: 'dquotetest', local_path: htmlPath,
      content_hash: 'sha256:dquote', mime_type: 'text/html', depth: 1,
      page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null,
      backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0
    };
    const html = readFileSync(htmlPath, 'utf8');
    exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: false } }, page, html);
    const mdPath = join(mdDir(DOMAIN), 'dquotetest.md');
    expect(existsSync(mdPath)).toBe(true);
    const mdContent = readFileSync(mdPath, 'utf8');
    const fmMatch = mdContent.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    let parsed;
    expect(() => { parsed = yaml.load(fmMatch[1]); }).not.toThrow();
    expect(parsed).toBeTruthy();
  });

  it('frontmatter with title containing ": " produces valid parseable YAML', () => {
    const htmlPath = join(htmlDir, 'colontest.html');
    writeFileSync(htmlPath, pageHtml('Title: A Subtitle Here', Array(20).fill('<p>Content text paragraph.</p>').join('')));
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
    const fmMatch = mdContent.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    let parsed;
    expect(() => { parsed = yaml.load(fmMatch[1]); }).not.toThrow();
    expect(parsed).toBeTruthy();
  });

  it('rewrite_links=true rewrites known asset URLs in markdown', () => {
    const imgUrl = 'https://export.example.com/images/photo.jpg';
    const htmlPath = join(htmlDir, 'rewrite.html');
    const html = pageHtml('Rewrite Test', `<p>Text</p><img src="${imgUrl}" alt="photo">`);
    writeFileSync(htmlPath, html);
    const url = 'https://export.example.com/rewrite';
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, page_role, content_hash, depth) VALUES (?,?,?,?,?,?,?,?)').run(url, 'rewrite', htmlPath, 'text/html', 0, 'content', 'sha256:rw', 1);
    // Register the asset so rewriteAssetLinks finds it
    const fakeAssetPath = join(testRoot, DOMAIN + '_assets', 'photo.jpg');
    mkdirSync(join(testRoot, DOMAIN + '_assets'), { recursive: true });
    writeFileSync(fakeAssetPath, Buffer.from('fake image'));
    db.prepare('INSERT INTO assets (hash, path, original_url, mime_type, bytes, first_seen_at, last_seen_at, ref_count) VALUES (?,?,?,?,?,?,?,?)')
      .run('sha256:photo', fakeAssetPath, imgUrl, 'image/jpeg', 10, new Date().toISOString(), new Date().toISOString(), 1);
    const result = exportHtmlPage(db, { domain: DOMAIN, assets: { rewrite_links: true } }, { url, path_slug: 'rewrite', local_path: htmlPath, content_hash: 'sha256:rw', mime_type: 'text/html', depth: 1, page_role: 'content', last_seen_at: new Date().toISOString(), backup_url: null, backup_archived_at: null, archive_only: 0, last_changed_at: null, from_sitemap: 0 }, html);
    expect(result).toBe(true);
    const mdPath = join(mdDir(DOMAIN), 'rewrite.md');
    const md = readFileSync(mdPath, 'utf8');
    // The asset URL should be rewritten to a relative path
    expect(md).toContain('<!-- src:');
  });
});

describe('buildFrontmatter', () => {
  it('wraps output in --- delimiters', () => {
    const fm = buildFrontmatter({ title: 'Hello' });
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm).toContain('\n---\n');
  });

  it('includes key: value pairs', () => {
    const fm = buildFrontmatter({ title: 'Hello', lang: 'en' });
    expect(fm).toContain('title: Hello');
    expect(fm).toContain('lang: en');
  });

  it('omits null values', () => {
    const fm = buildFrontmatter({ title: 'Hello', author: null });
    expect(fm).not.toContain('author:');
  });

  it('omits undefined values', () => {
    const fm = buildFrontmatter({ title: 'Hello', author: undefined });
    expect(fm).not.toContain('author:');
  });

  it('quotes strings containing ": " to prevent invalid YAML', () => {
    const fm = buildFrontmatter({ title: 'Note: this is special' });
    expect(fm).toContain('title: "Note: this is special"');
  });

  it('quotes strings starting with double-quote character', () => {
    const fm = buildFrontmatter({ title: '"quoted start"' });
    expect(fm).toContain('title: "\\"quoted start\\""');
  });

  it('quotes strings starting with single-quote character', () => {
    const fm = buildFrontmatter({ title: "'single quoted'" });
    // Should be JSON.stringify-escaped so YAML is valid
    expect(fm).toContain("title: \"'single quoted'\"");
  });

  it('serializes objects as JSON', () => {
    const fm = buildFrontmatter({ authors: [{ name: 'Jane' }] });
    expect(fm).toContain('[{"name":"Jane"}]');
  });

  it('outputs numbers without quoting', () => {
    const fm = buildFrontmatter({ word_count: 1234 });
    expect(fm).toContain('word_count: 1234');
  });

  it('produces parseable YAML for typical frontmatter object', () => {
    const fm = buildFrontmatter({
      title: 'My Article',
      source_url: 'https://example.com/article',
      page_role: 'content',
      word_count: 500,
      language: 'en',
    });
    const block = fm.slice(4, fm.indexOf('\n---\n'));
    const parsed = yaml.load(block);
    expect(parsed.title).toBe('My Article');
    expect(parsed.word_count).toBe(500);
  });
});
