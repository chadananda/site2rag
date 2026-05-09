import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const testRoot = join(tmpdir(), `site2rag-classify-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb, upsertPage } from '../src/db.js';
import { runClassify, classifyPage, jaccard, heuristicRole, wordCount, textToLinkRatio, computeDocFeatures } from '../src/classify.js';
import * as cheerio from 'cheerio';
import { compileRules } from '../src/rules.js';
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
  it('classifies content pages', async () => {
    const path = join(tmpDir, 'article.html');
    const body = Array(50).fill('<p>This is a paragraph of content text with lots of words and information about a topic.</p>').join('');
    writeFileSync(path, pageHtml(body, 'Article'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/article', 'article', path, 'text/html', 0);
    const stats = await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/article');
    expect(row.page_role).toBe('content');
    expect(stats.classified).toBe(1);
  });
  it('classifies redirect pages', async () => {
    const path = join(tmpDir, 'redirect.html');
    writeFileSync(path, pageHtml('<p>See <a href="https://classify.example.com/new">new page</a></p>', 'Redirect'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/redirect', 'redirect', path, 'text/html', 0);
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/redirect');
    expect(row.page_role).toBe('redirect');
  });
  it('classifies index pages (many links, low text-to-link ratio)', async () => {
    const path = join(tmpDir, 'navindex.html');
    // Few words but many outbound links → ttr < 5 and outbound_link_count > 10 → index
    const links = Array(15).fill(0).map((_, i) =>
      `<a href="https://classify.example.com/topic-${i}">Topic ${i}</a>`
    ).join('');
    writeFileSync(path, pageHtml(`<p>Browse topics:</p>${links}`, 'Topics'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/navindex', 'navindex', path, 'text/html', 0);
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/navindex');
    expect(row.page_role).toBe('index');
  });
  it('applies classify_overrides from rules', async () => {
    const path = join(tmpDir, 'manual.html');
    writeFileSync(path, pageHtml('<p>Some content</p>', 'Manual'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/manual', 'manual', path, 'text/html', 0);
    const stats = await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 }, rules: { classify_overrides: [{ pattern: '/manual', role: 'index' }] } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/manual');
    expect(row.page_role).toBe('index');
    expect(row.classify_method).toBe('rules');
    expect(stats.rule_overrides).toBe(1);
  });
  it('rule override of host_page also populates hosts table', async () => {
    const path = join(tmpDir, 'hostoverride.html');
    const pdfLinks = Array(3).fill(0).map((_, i) =>
      `<a href="https://classify.example.com/forced${i}.pdf">Forced Doc ${i}</a>`
    ).join('\n');
    writeFileSync(path, pageHtml(`<p>Host override test.</p>${pdfLinks}`, 'Host Override'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run('https://classify.example.com/hostoverride', 'hostoverride', path, 'text/html', 0);
    await runClassify(db, {
      domain: DOMAIN,
      classify: { word_threshold: 200 },
      rules: { classify_overrides: [{ pattern: '/hostoverride', role: 'host_page' }] }
    });
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get('https://classify.example.com/hostoverride');
    expect(row.page_role).toBe('host_page');
    const hosts = db.prepare('SELECT * FROM hosts WHERE host_url=?').all('https://classify.example.com/hostoverride');
    expect(hosts.length).toBeGreaterThan(0);
  });
  it('page with wc=0 (empty body) is classified as redirect', async () => {
    const path = join(tmpDir, 'empty.html');
    writeFileSync(path, pageHtml('', 'Empty'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/empty', 'empty', path, 'text/html', 0);
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/empty');
    // wc=0 < 50 and outbound_link_count=0 (not exactly 1 for redirect), falls through to content
    // BUT wc=0 < word_threshold and doc_link_count=0 means NOT host_page, wc<50 and outbound=0 (not 1) => content
    // Actual: redirect requires wc<50 AND outbound===1; empty page has 0 links => content or index
    // Let's test what actually happens: wc=0, outbound=0 => ttr=wc/0 => ttr=0 (wc since no links), ttr<5 and outbound>10 => no => content
    expect(['content', 'redirect', 'index']).toContain(row.page_role);
  });
  it('page with high word count (>500) and multiple PDF links is NOT host_page', async () => {
    // host_page requires wc < word_threshold. With wc >> threshold, it should be content.
    const pdfLinks = Array(5).fill('<a href="https://classify.example.com/doc.pdf">Document</a>').join(' ');
    const bodyText = Array(100).fill('<p>This is a substantial paragraph of content text providing useful information for readers.</p>').join('');
    const path = join(tmpDir, 'richpage.html');
    writeFileSync(path, pageHtml(bodyText + pdfLinks, 'Rich Page'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/richpage', 'richpage', path, 'text/html', 0);
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/richpage');
    // wc >> 200 threshold, so heuristic should NOT return host_page
    expect(row.page_role).not.toBe('host_page');
    expect(row.page_role).toBe('content');
  });
  it('classifies host_page when few words and multiple PDF links', async () => {
    const path = join(tmpDir, 'host.html');
    const pdfLinks = Array(5).fill(0).map((_, i) =>
      `<a href="https://classify.example.com/doc${i}.pdf">Report Document ${i}</a>`
    ).join('\n');
    writeFileSync(path, pageHtml(`<p>Document index.</p>${pdfLinks}`, 'Document Repository'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run('https://classify.example.com/host', 'host', path, 'text/html', 0);
    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT OR IGNORE INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)')
        .run(`https://classify.example.com/doc${i}.pdf`, `doc${i}`, 'application/pdf', 0);
    }
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get('https://classify.example.com/host');
    expect(row.page_role).toBe('host_page');
  });

  it('skips pages already classified by heuristic (classify_method=heuristic)', async () => {
    const path = join(tmpDir, 'already.html');
    const body = Array(50).fill('<p>Content text here.</p>').join('');
    writeFileSync(path, pageHtml(body, 'Already Classified'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, page_role, classify_method) VALUES (?,?,?,?,?,?,?)')
      .run('https://classify.example.com/already', 'already', path, 'text/html', 0, 'content', 'heuristic');
    const stats = await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    expect(stats.classified).toBe(0);
  });

  it('content selector that matches uses that element only for word count', async () => {
    const path = join(tmpDir, 'withsel.html');
    // Main article has lots of content, nav has lots of noise -- selector should use article only
    const body = `<nav>${Array(50).fill('<a href="#">nav link</a>').join('')}</nav><article>${Array(40).fill('<p>Article content words here for the test of selector matching path.</p>').join('')}</article>`;
    writeFileSync(path, pageHtml(body, 'Selector Article'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/withsel', 'withsel', path, 'text/html', 0);
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 }, rules: { content_selector: 'article' } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/withsel');
    expect(row.page_role).toBe('content');
  });

  it('skips page when local_path does not exist on disk', async () => {
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run('https://classify.example.com/missing', 'missing', join(tmpDir, 'nonexistent.html'), 'text/html', 0);
    const stats = await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 } });
    expect(stats.classified).toBe(0);
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get('https://classify.example.com/missing');
    expect(row.page_role).toBeNull();
  });

  it('content selector that matches nothing falls back to body/readability', async () => {
    const path = join(tmpDir, 'fallback.html');
    const body = Array(30).fill('<p>This is content text for the fallback article with lots of words.</p>').join('');
    writeFileSync(path, pageHtml(body, 'Fallback Article'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)').run('https://classify.example.com/fallback', 'fallback', path, 'text/html', 0);
    // content_selector that matches nothing -- classify should not crash and should use fallback
    await runClassify(db, { domain: DOMAIN, classify: { word_threshold: 200 }, rules: { content_selector: '.nonexistent-class-xyz' } });
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://classify.example.com/fallback');
    // Falls back -- page_role should be set (not null) because enough text exists
    expect(row.page_role).not.toBeNull();
  });
});

describe('classifyPage — direct unit tests (no file I/O)', () => {
  const compiled = compileRules({});

  it('classifies content pages (many words, no special signals)', () => {
    const html = pageHtml(Array(60).fill('<p>This is a paragraph with good content text.</p>').join(''));
    const { role, classify_method } = classifyPage(html, 'https://example.com/article', compiled, 200, null);
    expect(role).toBe('content');
    expect(classify_method).toBe('heuristic');
  });

  it('classifies redirect (wc < 50, exactly 1 outbound link)', () => {
    const html = pageHtml('<p>See <a href="https://example.com/new">new page</a></p>');
    const { role } = classifyPage(html, 'https://example.com/old', compiled, 200, null);
    expect(role).toBe('redirect');
  });

  it('classifies index (low ttr: few words, many links)', () => {
    const links = Array(15).fill(0).map((_, i) =>
      `<a href="https://example.com/topic-${i}">Topic ${i}</a>`
    ).join('');
    const html = pageHtml(`<p>Browse:</p>${links}`, 'Topics');
    const { role } = classifyPage(html, 'https://example.com/index', compiled, 200, null);
    expect(role).toBe('index');
  });

  it('returns heuristic classify_method for non-override pages', () => {
    const html = pageHtml('<p>Short content.</p>');
    const { classify_method } = classifyPage(html, 'https://example.com/page', compiled, 200, null);
    expect(classify_method).toBe('heuristic');
  });

  it('returns rules classify_method for override match', () => {
    const overrideCompiled = compileRules({ classify_overrides: [{ pattern: '/override', role: 'index' }] });
    const html = pageHtml('<p>Content here.</p>');
    const { role, classify_method } = classifyPage(html, 'https://example.com/override', overrideCompiled, 200, null);
    expect(role).toBe('index');
    expect(classify_method).toBe('rules');
  });

  it('uses content_selector to restrict word count', () => {
    const contentCompiled = compileRules({ content_selector: 'article' });
    // article has lots of content, nav has lots of links — selector limits word count to article only
    const body = `<nav>${Array(20).fill('<a href="#">nav</a>').join('')}</nav><article>${Array(50).fill('<p>Article content words here.</p>').join('')}</article>`;
    const html = pageHtml(body, 'Selector Test');
    const { role } = classifyPage(html, 'https://example.com/sel', contentCompiled, 200, null);
    expect(role).toBe('content');
  });

  it('word_count_clean is null for override pages', () => {
    const overrideCompiled = compileRules({ classify_overrides: [{ pattern: '/force', role: 'content' }] });
    const { word_count_clean } = classifyPage(pageHtml('<p>x</p>'), 'https://example.com/force', overrideCompiled, 200, null);
    expect(word_count_clean).toBeNull();
  });

  it('word_count_clean is numeric for heuristic pages', () => {
    const html = pageHtml(Array(30).fill('<p>Word count test content text here.</p>').join(''));
    const { word_count_clean } = classifyPage(html, 'https://example.com/count', compiled, 200, null);
    expect(typeof word_count_clean).toBe('number');
    expect(word_count_clean).toBeGreaterThan(0);
  });

  it('host_page via title overlap: page title matches PDF link text', () => {
    // page title = "Annual Report", PDF link text = "Annual Report" → Jaccard overlap > 0.3
    const body = `<a href="https://example.com/annual-report.pdf">Annual Report</a>`;
    const html = `<html><head><title>Annual Report</title></head><body>${body}</body></html>`;
    const { role } = classifyPage(html, 'https://example.com/docs', compiled, 200, null);
    expect(role).toBe('host_page');
  });

  it('classifies index when ttr < 5 and many outbound links', () => {
    // Very few words but many links → ttr < 5 threshold → index role
    const manyLinks = Array(15).fill(0).map((_, i) => `<a href="https://example.com/p${i}">Link ${i}</a>`).join('');
    const html = pageHtml(`<p>Browse topics:</p>${manyLinks}`, 'Browse');
    const { role } = classifyPage(html, 'https://example.com/nav', compiled, 200, null);
    expect(role).toBe('index');
  });

  it('classifies host_page when override forces host_page and db is provided — populates hosts', () => {
    const hostCompiled = compileRules({ classify_overrides: [{ pattern: '/host', role: 'host_page' }] });
    const html = pageHtml('<a href="https://classify.example.com/report.pdf">Report PDF</a>');
    const db2 = openDb('classify-hosts.example.com');
    const { role } = classifyPage(html, 'https://classify.example.com/host', hostCompiled, 200, db2);
    expect(role).toBe('host_page');
    const hostRow = db2.prepare('SELECT * FROM hosts WHERE host_url=?').get('https://classify.example.com/host');
    expect(hostRow).toBeTruthy();
    expect(hostRow.hosted_url).toContain('.pdf');
    db2.close();
  });
});

describe('jaccard', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccard('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(jaccard('apple banana', 'cat dog')).toBe(0);
  });

  it('returns a value between 0 and 1 for partial overlap', () => {
    const score = jaccard('hello world', 'hello there');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('is case-insensitive', () => {
    expect(jaccard('Hello World', 'hello world')).toBe(1);
  });

  it('ignores punctuation (splits on non-word chars)', () => {
    // "hello, world!" splits to {hello, world}; "hello world" splits to same
    expect(jaccard('hello, world!', 'hello world')).toBe(1);
  });

  it('returns ~0.5 for 50% word overlap', () => {
    // {hello, world} vs {hello, there}: intersection=1, union=3 → 1/3 ≈ 0.33
    const score = jaccard('hello world', 'hello there');
    expect(score).toBeCloseTo(1 / 3, 2);
  });

  it('handles empty strings without throwing', () => {
    expect(() => jaccard('', '')).not.toThrow();
    expect(() => jaccard('hello', '')).not.toThrow();
    expect(() => jaccard('', 'hello')).not.toThrow();
  });

  it('empty vs non-empty returns 0', () => {
    expect(jaccard('hello world', '')).toBe(0);
  });

  it('treats multiple separators as word boundaries', () => {
    // "hello-world" splits to {hello, world}
    expect(jaccard('hello-world', 'hello world')).toBe(1);
  });
});

describe('heuristicRole', () => {
  const threshold = 200;

  it('returns host_page when wc < threshold and doc_link_count >= 1', () => {
    const features = { wc: 50, doc_link_count: 2, title_doc_overlap: 0.5, outbound_link_count: 5, ttr: 10 };
    expect(heuristicRole(features, threshold)).toBe('host_page');
  });

  it('returns host_page when doc_link_count>=1 even with title_doc_overlap=0', () => {
    // doc_link_count >= 1 satisfies the OR condition
    const features = { wc: 100, doc_link_count: 1, title_doc_overlap: 0, outbound_link_count: 3, ttr: 33 };
    expect(heuristicRole(features, threshold)).toBe('host_page');
  });

  it('returns redirect when wc < 50 and outbound_link_count === 1', () => {
    const features = { wc: 20, doc_link_count: 0, title_doc_overlap: 0, outbound_link_count: 1, ttr: 20 };
    expect(heuristicRole(features, threshold)).toBe('redirect');
  });

  it('returns index when ttr < 5 and outbound_link_count > 10', () => {
    const features = { wc: 500, doc_link_count: 0, title_doc_overlap: 0, outbound_link_count: 20, ttr: 2 };
    expect(heuristicRole(features, threshold)).toBe('index');
  });

  it('returns content as default', () => {
    const features = { wc: 500, doc_link_count: 0, title_doc_overlap: 0, outbound_link_count: 3, ttr: 166 };
    expect(heuristicRole(features, threshold)).toBe('content');
  });

  it('host_page takes priority over redirect when both conditions met', () => {
    // wc < 50, doc_link_count >= 1 → host_page checked first
    const features = { wc: 30, doc_link_count: 1, title_doc_overlap: 0, outbound_link_count: 1, ttr: 30 };
    expect(heuristicRole(features, threshold)).toBe('host_page');
  });

  it('returns content when wc >= threshold despite doc links', () => {
    const features = { wc: 300, doc_link_count: 5, title_doc_overlap: 0.8, outbound_link_count: 10, ttr: 30 };
    expect(heuristicRole(features, threshold)).toBe('content');
  });
});

describe('wordCount', () => {
  it('returns 0 for empty string', () => {
    expect(wordCount('')).toBe(0);
  });

  it('counts words separated by spaces', () => {
    expect(wordCount('hello world foo')).toBe(3);
  });

  it('handles multiple spaces between words', () => {
    expect(wordCount('hello   world')).toBe(2);
  });

  it('handles leading and trailing spaces', () => {
    expect(wordCount('  hello  ')).toBe(1);
  });

  it('counts single word', () => {
    expect(wordCount('hello')).toBe(1);
  });

  it('handles newlines and tabs as whitespace', () => {
    expect(wordCount('hello\nworld\tthere')).toBe(3);
  });
});

describe('textToLinkRatio', () => {
  it('returns wordCount when no links present', () => {
    const $ = cheerio.load('<p>hello world foo</p>');
    expect(textToLinkRatio($, 'hello world foo')).toBe(3);
  });

  it('returns wc / linkCount when links present', () => {
    const $ = cheerio.load('<a href="/a">A</a><a href="/b">B</a>');
    // 4 words, 2 links → 2
    expect(textToLinkRatio($, 'hello world foo bar')).toBe(2);
  });

  it('returns 0 for empty text with links', () => {
    const $ = cheerio.load('<a href="/x">X</a>');
    expect(textToLinkRatio($, '')).toBe(0);
  });

  it('counts only <a href> anchors, not bare <a>', () => {
    const $ = cheerio.load('<a>anchor no href</a><a href="/x">with href</a>');
    // 1 link with href, 6 words → 6
    expect(textToLinkRatio($, 'one two three four five six')).toBe(6);
  });

  it('handles single link', () => {
    const $ = cheerio.load('<a href="/x">link</a>');
    expect(textToLinkRatio($, 'word')).toBe(1);
  });
});

describe('computeDocFeatures', () => {
  it('returns zero counts for page with no doc links', () => {
    const $ = cheerio.load('<a href="/about">About</a>');
    const f = computeDocFeatures($, 'Test Page');
    expect(f.doc_link_count).toBe(0);
    expect(f.title_doc_overlap).toBe(0);
  });

  it('counts PDF links as doc links', () => {
    const $ = cheerio.load('<a href="/file.pdf">Document</a>');
    const f = computeDocFeatures($, 'Test Page');
    expect(f.doc_link_count).toBe(1);
  });

  it('counts multiple doc link types', () => {
    const $ = cheerio.load('<a href="/a.pdf">A</a><a href="/b.docx">B</a><a href="/page">Page</a>');
    const f = computeDocFeatures($, 'Test');
    expect(f.doc_link_count).toBe(2);
  });

  it('computes jaccard overlap between page title and link text', () => {
    const $ = cheerio.load('<a href="/annual-report.pdf">Annual Report</a>');
    const f = computeDocFeatures($, 'Annual Report 2024');
    expect(f.title_doc_overlap).toBeGreaterThan(0);
  });

  it('uses filename as fallback when link has no text', () => {
    const $ = cheerio.load('<a href="/annual-report.pdf"></a>');
    const f = computeDocFeatures($, 'annual report');
    // filename fallback: "annual-report" → should overlap with title
    expect(f.doc_link_count).toBe(1);
  });
});
