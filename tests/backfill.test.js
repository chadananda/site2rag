import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-backfill-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';
import { backfillHostsFromMirror } from '../src/pdf-upgrade/backfill.js';

const DOMAIN = 'backfill.example.com';
const SITE_URL = `https://${DOMAIN}`;

describe('backfillHostsFromMirror', () => {
  let db, pagesDir;

  beforeEach(() => {
    pagesDir = join(testRoot, DOMAIN);
    mkdirSync(pagesDir, { recursive: true });
    db = openDb(DOMAIN);
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('inserts PDF links from HTML pages into hosts table', async () => {
    const htmlPath = join(pagesDir, 'index.html');
    writeFileSync(htmlPath, `<html><body><a href="${SITE_URL}/report.pdf">Annual Report</a></body></html>`);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(`${SITE_URL}/`, 'index', htmlPath, 'text/html', 0);

    await backfillHostsFromMirror(db, DOMAIN);

    const row = db.prepare('SELECT * FROM hosts WHERE hosted_url=?').get(`${SITE_URL}/report.pdf`);
    expect(row).toBeTruthy();
    expect(row.hosted_title).toBe('Annual Report');
    expect(row.host_url).toBe(`${SITE_URL}/`);
  });

  it('sets hosts_backfilled_at in site_meta after run', async () => {
    const htmlPath = join(pagesDir, 'page.html');
    writeFileSync(htmlPath, '<html><body><p>No PDF links here.</p></body></html>');
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(`${SITE_URL}/page`, 'page', htmlPath, 'text/html', 0);

    await backfillHostsFromMirror(db, DOMAIN);

    const row = db.prepare("SELECT value FROM site_meta WHERE key='hosts_backfilled_at'").get();
    expect(row).toBeTruthy();
    expect(row.value).toBeTruthy();
  });

  it('skips pages with no .pdf links (HTML without PDF content)', async () => {
    const htmlPath = join(pagesDir, 'nopdf.html');
    writeFileSync(htmlPath, '<html><body><a href="/about">About</a></body></html>');
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(`${SITE_URL}/nopdf`, 'nopdf', htmlPath, 'text/html', 0);

    await backfillHostsFromMirror(db, DOMAIN);

    const rows = db.prepare('SELECT * FROM hosts').all();
    expect(rows).toHaveLength(0);
  });

  it('does not run again if hosts_backfilled_at already set', async () => {
    db.prepare("INSERT OR REPLACE INTO site_meta (key, value) VALUES ('hosts_backfilled_at', ?)")
      .run(new Date().toISOString());

    const htmlPath = join(pagesDir, 'skip.html');
    writeFileSync(htmlPath, `<html><body><a href="${SITE_URL}/skip.pdf">Skip</a></body></html>`);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(`${SITE_URL}/skip`, 'skip', htmlPath, 'text/html', 0);

    await backfillHostsFromMirror(db, DOMAIN);

    const rows = db.prepare('SELECT * FROM hosts').all();
    expect(rows).toHaveLength(0); // not inserted because already backfilled
  });

  it('uses href basename as title when link text is empty', async () => {
    const htmlPath = join(pagesDir, 'notitle.html');
    writeFileSync(htmlPath, `<html><body><a href="${SITE_URL}/annual-report-2024.pdf"></a></body></html>`);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(`${SITE_URL}/notitle`, 'notitle', htmlPath, 'text/html', 0);

    await backfillHostsFromMirror(db, DOMAIN);

    const row = db.prepare('SELECT * FROM hosts WHERE hosted_url=?').get(`${SITE_URL}/annual-report-2024.pdf`);
    expect(row).toBeTruthy();
    expect(row.hosted_title).toContain('annual-report-2024.pdf');
  });
});
