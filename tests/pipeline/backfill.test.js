// Tests for backfill.js: backfillHostsFromMirror behavior with in-memory SQLite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { makeTempDir } from './helpers.js';
import { backfillHostsFromMirror } from '../../src/pdf-upgrade/backfill.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS pages (
    url TEXT PRIMARY KEY, local_path TEXT, mime_type TEXT, gone INT DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS hosts (
    host_url TEXT NOT NULL, hosted_url TEXT NOT NULL, hosted_title TEXT, detected_at TEXT,
    PRIMARY KEY (host_url, hosted_url)
  );
`;

let db, tmpDir, cleanup;

beforeEach(() => {
  ({ dir: tmpDir, cleanup } = makeTempDir());
  db = new Database(':memory:');
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('backfillHostsFromMirror — skip logic', () => {
  it('returns early when already backfilled (hosts_backfilled_at set)', async () => {
    db.prepare("INSERT INTO site_meta (key, value) VALUES ('hosts_backfilled_at', '2026-01-01')").run();
    const htmlPath = join(tmpDir, 'page.html');
    writeFileSync(htmlPath, '<a href="doc.pdf">Document</a>');
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const hosts = db.prepare('SELECT * FROM hosts').all();
    expect(hosts).toHaveLength(0);
  });
});

describe('backfillHostsFromMirror — insertion', () => {
  it('inserts PDF links found in HTML pages into hosts table', async () => {
    const htmlPath = join(tmpDir, 'page.html');
    writeFileSync(htmlPath, '<a href="https://example.com/doc.pdf">My Document</a>');
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const hosts = db.prepare('SELECT * FROM hosts').all();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hosted_url).toBe('https://example.com/doc.pdf');
    expect(hosts[0].hosted_title).toBe('My Document');
    expect(hosts[0].host_url).toBe('https://example.com/');
  });

  it('sets hosts_backfilled_at in site_meta after completion', async () => {
    const htmlPath = join(tmpDir, 'empty.html');
    writeFileSync(htmlPath, '<p>no pdfs here</p>');
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const meta = db.prepare("SELECT value FROM site_meta WHERE key='hosts_backfilled_at'").get();
    expect(meta).toBeDefined();
    expect(meta.value).toBeTruthy();
  });

  it('uses href filename as title when anchor text is empty', async () => {
    const htmlPath = join(tmpDir, 'page.html');
    writeFileSync(htmlPath, '<a href="https://example.com/some-document.pdf"></a>');
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const host = db.prepare('SELECT * FROM hosts').get();
    expect(host).toBeDefined();
    expect(host.hosted_title).toBe('some-document.pdf');
  });

  it('skips non-PDF hrefs', async () => {
    const htmlPath = join(tmpDir, 'page.html');
    writeFileSync(htmlPath, '<a href="page.html">HTML</a><a href="doc.pdf">PDF</a>');
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const hosts = db.prepare('SELECT * FROM hosts').all();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hosted_url).toContain('.pdf');
  });

  it('skips HTML pages with missing local_path files', async () => {
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', join(tmpDir, 'nonexistent.html'), 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const hosts = db.prepare('SELECT * FROM hosts').all();
    expect(hosts).toHaveLength(0);
  });

  it('resolves relative PDF hrefs against the host page URL', async () => {
    const htmlPath = join(tmpDir, 'page.html');
    writeFileSync(htmlPath, '<a href="/files/report.pdf">Report</a>');
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/pages/index.html', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const host = db.prepare('SELECT * FROM hosts').get();
    expect(host?.hosted_url).toBe('https://example.com/files/report.pdf');
  });

  it('inserts multiple PDFs from a single HTML page', async () => {
    const htmlPath = join(tmpDir, 'page.html');
    writeFileSync(htmlPath, `
      <a href="https://example.com/a.pdf">Doc A</a>
      <a href="https://example.com/b.pdf">Doc B</a>
      <a href="https://example.com/c.pdf">Doc C</a>
    `);
    db.prepare('INSERT INTO pages (url, local_path, mime_type) VALUES (?,?,?)').run(
      'https://example.com/', htmlPath, 'text/html'
    );
    await backfillHostsFromMirror(db, {});
    const hosts = db.prepare('SELECT * FROM hosts').all();
    expect(hosts).toHaveLength(3);
  });
});
