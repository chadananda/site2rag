// Mirror resume BDD tests -- verifies interrupted crawls resume where they left off.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-mirror-resume-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

vi.mock('undici', () => ({ fetch: vi.fn() }));
vi.mock('../src/pdf-upgrade/score.js', () => ({
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
