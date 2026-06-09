// Mirror resume BDD tests -- verifies interrupted crawls resume where they left off.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-mirror-resume-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

vi.mock('undici', () => ({ fetch: vi.fn() }));
vi.mock('../src/score.js', () => ({
  scorePdf: vi.fn(),
  saveQualityScore: vi.fn(),
  maybeQueue: vi.fn()
}));

import { fetch } from 'undici';
import { openDb } from '../src/db.js';
import { runMirror } from '../src/mirror.js';

const DOMAIN = 'resume.example.com';
const SEED = `https://${DOMAIN}`;

const htmlPage = (links = []) =>
  `<html><head><title>T</title></head><body>${links.map(u => `<a href="${u}">x</a>`).join('')}</body></html>`;

const mockResponse = (body, mime = 'text/html') => ({
  ok: true, status: 200,
  headers: { get: (h) => h === 'content-type' ? mime : null },
  arrayBuffer: async () => Buffer.from(body)
});

afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

describe('mirror resume: pre-populates visited from DB', () => {
  it('does not re-fetch pages already seen in this run', async () => {
    const db = openDb(DOMAIN);
    const now = new Date().toISOString();
    const alreadySeen = `${SEED}/already-seen`;

    // Simulate a prior interrupted run: page was fetched, run_started_at is in DB
    db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run('mirror_run_started_at', now);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, last_seen_at, first_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(alreadySeen, 'already-seen', null, 'text/html', 0, now, now);

    // Seed returns HTML linking to the already-seen page
    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([alreadySeen]));
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 10 });

    const calls = fetch.mock.calls.map(c => c[0]);
    expect(calls).not.toContain(alreadySeen);
    db.close();
  });

  it('clears mirror_run_started_at from site_meta on completion', async () => {
    const db = openDb(DOMAIN);
    fetch.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 10 });

    const row = db.prepare('SELECT value FROM site_meta WHERE key=?').get('mirror_run_started_at');
    expect(row).toBeUndefined();
    db.close();
  });

  it('starts fresh run when no saved state exists', async () => {
    const db = openDb(DOMAIN);
    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage());
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    const before = Date.now();
    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 10 });
    const after = Date.now();

    // Seed URL should have been fetched
    const calls = fetch.mock.calls.map(c => c[0]);
    expect(calls.some(u => u === SEED || u === `${SEED}/`)).toBe(true);
    db.close();
  });

  it('resumes with correct runStartedAt so markGoneUrls uses original start time', async () => {
    const db = openDb(DOMAIN);
    const originalStart = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    const pageUrl = `${SEED}/page1`;

    // Simulate interrupted run: page was seen before the "resume"
    db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run('mirror_run_started_at', originalStart);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, last_seen_at, first_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(pageUrl, 'page1', null, 'text/html', 0, originalStart, originalStart);

    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage());
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 10 });

    // page1 should NOT be marked gone (it was seen in this run's window)
    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get(pageUrl);
    expect(row?.gone).toBe(0);
    db.close();
  });
});

describe('mirror robots.txt: respect_robots_txt option', () => {
  const robotsResponse = (body) => ({
    ok: true, status: 200,
    headers: { get: (h) => h === 'content-type' ? 'text/plain' : null },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body)
  });

  it('respects robots.txt disallow when respect_robots_txt=true', async () => {
    const db = openDb(DOMAIN);
    fetch.mockImplementation(async (url) => {
      if (url.endsWith('/robots.txt')) return robotsResponse('User-agent: *\nDisallow: /private/\n');
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([`${SEED}/private/secret`, `${SEED}/public`]));
      if (url === `${SEED}/public`) return mockResponse(htmlPage([]));
      return { ok: false, status: 404, headers: { get: () => null } };
    });
    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30, respect_robots_txt: true });
    const calls = fetch.mock.calls.map(c => c[0]);
    expect(calls).not.toContain(`${SEED}/private/secret`);
    db.close();
  });

  it('crawls disallowed paths when respect_robots_txt=false', async () => {
    const db = openDb(DOMAIN);
    fetch.mockImplementation(async (url) => {
      if (url.endsWith('/robots.txt')) return robotsResponse('User-agent: *\nDisallow: /private/\n');
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([`${SEED}/private/secret`]));
      if (url === `${SEED}/private/secret`) return mockResponse(htmlPage([]));
      return { ok: false, status: 404, headers: { get: () => null } };
    });
    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30, respect_robots_txt: false });
    const calls = fetch.mock.calls.map(c => c[0]);
    expect(calls).toContain(`${SEED}/private/secret`);
    db.close();
  });
});

describe('mirror 404 response', () => {
  it('marks existing page as gone when server returns 404', async () => {
    const db = openDb(DOMAIN);
    const knownUrl = `${SEED}/known-page`;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, last_seen_at, first_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(knownUrl, 'known-page', null, 'text/html', 0, now, now);

    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([knownUrl]));
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30 });

    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get(knownUrl);
    expect(row?.gone).toBe(1);
    db.close();
  });
});

describe('mirror depth limiting', () => {
  it('does not crawl links discovered beyond max_depth', async () => {
    const db = openDb(DOMAIN);
    const level1 = `${SEED}/level1`;
    const level2 = `${SEED}/level2`;

    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([level1]));
      if (url === level1) return mockResponse(htmlPage([level2]));
      if (url === level2) return mockResponse(htmlPage([]));
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    // max_depth=1 means seed (depth=0) is crawled, level1 (depth=1) is crawled, level2 (depth=2) is NOT
    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30, max_depth: 1 });

    const calls = fetch.mock.calls.map(c => c[0]);
    expect(calls.some(u => u === level1)).toBe(true);
    expect(calls).not.toContain(level2);
    db.close();
  });
});

describe('mirror follow_overrides', () => {
  it('does not fetch URLs when follow_override=false', async () => {
    const db = openDb(DOMAIN);
    const skippedUrl = `${SEED}/skip-this/page`;

    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([skippedUrl]));
      return mockResponse(htmlPage([]));
    });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30,
      rules: { follow_overrides: [{ pattern: '/skip-this/', follow: false }] } });

    const calls = fetch.mock.calls.map(c => c[0]);
    expect(calls).not.toContain(skippedUrl);
    db.close();
  });
});

describe('mirror markGoneUrls: only on complete runs', () => {
  it('does NOT mark pages gone when run times out (partial crawl)', async () => {
    const db = openDb(DOMAIN);
    const existingUrl = `${SEED}/existing-page`;
    const oldDate = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 days ago
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, last_seen_at, first_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(existingUrl, 'existing', null, 'text/html', 0, oldDate, oldDate);

    fetch.mockImplementation(async () => mockResponse(htmlPage([])));

    // timeout_seconds: 0 → loop condition is false immediately → toVisit not empty → partial run
    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 0 });

    // existingUrl was not seen — but run was incomplete, so must NOT be marked gone
    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get(existingUrl);
    expect(row?.gone).toBe(0);
    db.close();
  });

  it('304 response updates last_seen_at and extracts links from cached HTML', async () => {
    const db = openDb(DOMAIN);
    const childUrl = `${SEED}/child-discovered`;
    // Pre-populate the seed page with cached HTML that has a link to childUrl
    const cachedHtml = htmlPage([childUrl]);
    const mirrorDir = join(testRoot, DOMAIN);
    mkdirSync(mirrorDir, { recursive: true });
    const cachedPath = join(mirrorDir, 'index.html');
    writeFileSync(cachedPath, cachedHtml);
    const oldDate = new Date(Date.now() - 2 * 86400000).toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, last_seen_at, first_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(SEED, 'index', cachedPath, 'text/html', 0, oldDate, oldDate);

    let childFetched = false;
    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) {
        return { ok: true, status: 304, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('') };
      }
      if (url === childUrl) {
        childFetched = true;
        return mockResponse(htmlPage([]));
      }
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30 });

    // 304 path should have extracted links from cached HTML and queued child
    expect(childFetched).toBe(true);
    const seedRow = db.prepare('SELECT last_seen_at FROM pages WHERE url=?').get(SEED);
    expect(seedRow.last_seen_at).not.toBe(oldDate);
    db.close();
  });

  it('DOES mark pages gone when crawl completes fully', async () => {
    const db = openDb(DOMAIN);
    const ghostUrl = `${SEED}/ghost-page`;
    // Must be old enough to pass the 3× staleMs cutoff used by safe gone detection
    const oldDate = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, last_seen_at, first_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(ghostUrl, 'ghost', null, 'text/html', 0, oldDate, oldDate);

    // Seed returns no links — crawl finishes immediately (only seed URL checked)
    fetch.mockImplementation(async (url) => {
      if (url === SEED || url === `${SEED}/`) return mockResponse(htmlPage([]));
      return { ok: false, status: 404, headers: { get: () => null } };
    });

    await runMirror(db, { domain: DOMAIN, url: SEED, timeout_seconds: 30 });

    // ghostUrl was not seen in this complete run → should be marked gone
    const row = db.prepare('SELECT gone FROM pages WHERE url=?').get(ghostUrl);
    expect(row?.gone).toBe(1);
    db.close();
  });
});
