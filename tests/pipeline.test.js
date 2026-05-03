import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-pipeline-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';
import { runClassify } from '../src/classify.js';
import { runExportHtml, exportHtmlPage } from '../src/export-html.js';
import { mdDir, mirrorDir } from '../src/config.js';

const DOMAIN = 'pipeline.example.com';

const CONTENT_HTML = `<!DOCTYPE html><html><head><title>Deep Sea Corals</title></head><body>
<h1>Deep Sea Corals</h1>
<p>${'Corals are marine invertebrates that form reefs. '.repeat(15)}</p>
<p>${'They host diverse ecosystems and filter seawater. '.repeat(15)}</p>
<p>${'Deep sea varieties live without sunlight. '.repeat(10)}</p>
</body></html>`;

const INDEX_HTML = `<!DOCTYPE html><html><head><title>Marine Biology Index</title></head><body>
<h1>Marine Biology</h1>
<ul>${Array.from({ length: 20 }, (_, i) => `<li><a href="/topic-${i}">Topic ${i}</a></li>`).join('')}</ul>
</body></html>`;

const HOST_PAGE_HTML = `<!DOCTYPE html><html><head><title>PDF Resources</title></head><body>
<h1>PDF Resources</h1>
<p>Download documents:</p>
<ul>
  <li><a href="https://pipeline.example.com/report.pdf">Annual Report 2024</a></li>
  <li><a href="https://pipeline.example.com/guide.pdf">User Guide</a></li>
</ul>
</body></html>`;

const REDIRECT_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0; url=https://pipeline.example.com/deep-sea-corals">
</head><body><p>Redirecting...</p></body></html>`;

function setupPage(db, mDir, url, slug, html, extra = {}) {
  const localPath = join(mDir, `${slug}.html`);
  writeFileSync(localPath, html, 'utf8');
  db.prepare(`INSERT INTO pages (url, path_slug, local_path, mime_type, content_hash, depth, first_seen_at, last_seen_at, gone)
    VALUES (?, ?, ?, 'text/html', 'sha256:test', 1, ?, ?, 0)`)
    .run(url, slug, localPath, new Date().toISOString(), new Date().toISOString());
  if (extra.page_role) {
    db.prepare('UPDATE pages SET page_role=?, classify_method=? WHERE url=?')
      .run(extra.page_role, extra.classify_method || 'heuristic', url);
  }
}

describe('classify → export pipeline', () => {
  let db, mDir;

  beforeEach(() => {
    mDir = mirrorDir(DOMAIN);
    mkdirSync(mDir, { recursive: true });
    mkdirSync(mdDir(DOMAIN), { recursive: true });
    db = openDb(DOMAIN);
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('classifies content page correctly', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/deep-sea-corals', 'deep-sea-corals', CONTENT_HTML);
    const stats = await runClassify(db, { domain: DOMAIN });
    expect(stats.classified).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get('https://pipeline.example.com/deep-sea-corals');
    expect(row.page_role).toBe('content');
  });

  it('classifies index page correctly', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/index', 'index', INDEX_HTML);
    await runClassify(db, { domain: DOMAIN });
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get('https://pipeline.example.com/index');
    expect(row.page_role).toBe('index');
  });

  it('classifies host_page with PDF links and populates hosts table', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/resources', 'resources', HOST_PAGE_HTML);
    await runClassify(db, { domain: DOMAIN });
    const row = db.prepare('SELECT page_role FROM pages WHERE url=?').get('https://pipeline.example.com/resources');
    expect(row.page_role).toBe('host_page');
    const hosts = db.prepare('SELECT * FROM hosts WHERE host_url=?').all('https://pipeline.example.com/resources');
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    expect(hosts.map(h => h.hosted_url)).toContain('https://pipeline.example.com/report.pdf');
  });

  it('exports content page to MD with correct frontmatter', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/deep-sea-corals', 'deep-sea-corals', CONTENT_HTML, { page_role: 'content' });
    const stats = runExportHtml(db, { domain: DOMAIN });
    expect(stats.written).toBe(1);
    const mdPath = join(mdDir(DOMAIN), 'deep-sea-corals.md');
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toContain('source_url: https://pipeline.example.com/deep-sea-corals');
    expect(md).toContain('page_role: content');
    expect(md).toContain('Deep Sea Corals');
  });

  it('does not export pages without page_role (runExportHtml skips unclassified)', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/unclassified', 'unclassified', CONTENT_HTML);
    // page_role is null — runExportHtml only processes pages with page_role set
    const stats = runExportHtml(db, { domain: DOMAIN });
    expect(stats.written).toBe(0);
  });

  it('skips re-export when content unchanged', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/deep-sea-corals', 'deep-sea-corals', CONTENT_HTML, { page_role: 'content' });
    const first = runExportHtml(db, { domain: DOMAIN });
    expect(first.written).toBe(1);
    // Manually set export source_hash to match page content_hash to simulate up-to-date export
    db.prepare('UPDATE exports SET source_hash=? WHERE url=?').run('sha256:test', 'https://pipeline.example.com/deep-sea-corals');
    const second = runExportHtml(db, { domain: DOMAIN });
    expect(second.skipped).toBe(1);
    expect(second.written).toBe(0);
  });

  it('re-exports preliminary export (source_hash=null) after classify sets page_role', async () => {
    // Simulate inline mirror export: exportHtmlPage with page_role=null produces source_hash=null
    setupPage(db, mDir, 'https://pipeline.example.com/corals2', 'corals2', CONTENT_HTML);
    const pageRow = db.prepare('SELECT * FROM pages WHERE url=?').get('https://pipeline.example.com/corals2');
    exportHtmlPage(db, { domain: DOMAIN }, pageRow, CONTENT_HTML);
    // Verify the export has source_hash=null (preliminary)
    const exp = db.prepare('SELECT source_hash FROM exports WHERE url=?').get('https://pipeline.example.com/corals2');
    expect(exp.source_hash).toBeNull();
    // Now classify sets page_role
    db.prepare('UPDATE pages SET page_role=?, classify_method=? WHERE url=?').run('content', 'heuristic', 'https://pipeline.example.com/corals2');
    // runExportHtml should re-export because source_hash=null !== content_hash
    const stats = runExportHtml(db, { domain: DOMAIN });
    expect(stats.written).toBe(1);
    const exp2 = db.prepare('SELECT source_hash FROM exports WHERE url=?').get('https://pipeline.example.com/corals2');
    expect(exp2.source_hash).toBe('sha256:test');
  });

  it('full classify→export sequence produces correct MD for multiple page types', async () => {
    setupPage(db, mDir, 'https://pipeline.example.com/corals', 'corals', CONTENT_HTML);
    setupPage(db, mDir, 'https://pipeline.example.com/nav', 'nav', INDEX_HTML);
    setupPage(db, mDir, 'https://pipeline.example.com/docs', 'docs', HOST_PAGE_HTML);

    const classifyStats = await runClassify(db, { domain: DOMAIN });
    expect(classifyStats.classified).toBe(3);

    const exportStats = runExportHtml(db, { domain: DOMAIN });
    expect(exportStats.written).toBe(3);

    // Verify each page type got correct role in its MD
    const corals = readFileSync(join(mdDir(DOMAIN), 'corals.md'), 'utf8');
    expect(corals).toContain('page_role: content');

    const nav = readFileSync(join(mdDir(DOMAIN), 'nav.md'), 'utf8');
    expect(nav).toContain('page_role: index');

    const docs = readFileSync(join(mdDir(DOMAIN), 'docs.md'), 'utf8');
    expect(docs).toContain('page_role: host_page');
    expect(docs).toContain('hosts:');
  });
});
