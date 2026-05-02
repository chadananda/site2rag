// Assets stage BDD tests. Mocks undici fetch — no real HTTP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-assets-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

vi.mock('undici', () => ({ fetch: vi.fn() }));

import { fetch } from 'undici';
import { openDb } from '../src/db.js';
import { runAssets } from '../src/assets.js';

const DOMAIN = 'assets.example.com';
const SITE_URL = `https://${DOMAIN}`;

const fakePng = Buffer.from('PNG_FAKE_DATA');
const fakePdf = Buffer.from('%PDF-1.4 FAKE');

const mockAsset = (contentType, buf) => ({
  ok: true,
  status: 200,
  headers: { get: (h) => h === 'content-type' ? contentType : null },
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
});

describe('runAssets', () => {
  let db, pagesDir;

  beforeEach(() => {
    pagesDir = join(testRoot, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    db = openDb(DOMAIN);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  const insertPage = (slug, html) => {
    const path = join(pagesDir, `${slug}.html`);
    writeFileSync(path, html);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(`${SITE_URL}/${slug}`, slug, path, 'text/html', 0);
    return path;
  };

  it('downloads images from img[src] tags', async () => {
    insertPage('gallery', `<html><body><img src="${SITE_URL}/photo.png"></body></html>`);
    fetch.mockResolvedValue(mockAsset('image/png', fakePng));

    const stats = await runAssets(db, { domain: DOMAIN });
    expect(stats.new_assets).toBe(1);
    const asset = db.prepare('SELECT * FROM assets WHERE original_url=?').get(`${SITE_URL}/photo.png`);
    expect(asset).toBeTruthy();
    expect(asset.mime_type).toBe('image/png');
    expect(existsSync(asset.path)).toBe(true);
  });

  it('downloads PDF documents from a[href] links', async () => {
    insertPage('papers', `<html><body><a href="${SITE_URL}/report.pdf">Report</a></body></html>`);
    fetch.mockResolvedValue(mockAsset('application/pdf', fakePdf));

    const stats = await runAssets(db, { domain: DOMAIN });
    expect(stats.new_assets).toBe(1);
    const asset = db.prepare('SELECT * FROM assets WHERE original_url=?').get(`${SITE_URL}/report.pdf`);
    expect(asset).toBeTruthy();
    expect(asset.mime_type).toBe('application/pdf');
  });

  it('deduplicates assets by content hash (same file, two pages)', async () => {
    insertPage('page1', `<html><body><img src="${SITE_URL}/logo.png"></body></html>`);
    insertPage('page2', `<html><body><img src="${SITE_URL}/logo.png"></body></html>`);
    fetch.mockResolvedValue(mockAsset('image/png', fakePng));

    const stats = await runAssets(db, { domain: DOMAIN });
    // Only 1 new asset (deduplicated), but 2 total refs
    expect(stats.new_assets).toBe(1);
    const refs = db.prepare('SELECT * FROM asset_refs WHERE asset_hash=?')
      .all(db.prepare('SELECT hash FROM assets LIMIT 1').get()?.hash);
    expect(refs.length).toBe(2);
  });

  it('skips already-downloaded assets on second run', async () => {
    insertPage('page', `<html><body><img src="${SITE_URL}/img.png"></body></html>`);
    fetch.mockResolvedValue(mockAsset('image/png', fakePng));

    await runAssets(db, { domain: DOMAIN });
    const callsAfterFirst = fetch.mock.calls.length;

    await runAssets(db, { domain: DOMAIN });
    expect(fetch.mock.calls.length).toBe(callsAfterFirst); // no new fetches
  });

  it('skips oversized images', async () => {
    insertPage('page', `<html><body><img src="${SITE_URL}/huge.png"></body></html>`);
    const bigBuf = Buffer.alloc(20 * 1024 * 1024); // 20MB
    fetch.mockResolvedValue(mockAsset('image/png', bigBuf));

    const stats = await runAssets(db, { domain: DOMAIN, assets: { image_max_bytes: 10 * 1024 * 1024 } });
    expect(stats.new_assets).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('handles fetch errors gracefully (skips, no crash)', async () => {
    insertPage('page', `<html><body><img src="${SITE_URL}/broken.png"></body></html>`);
    fetch.mockRejectedValue(new Error('network error'));

    const stats = await runAssets(db, { domain: DOMAIN });
    expect(stats.new_assets).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('returns zero stats when no pages in DB', async () => {
    const stats = await runAssets(db, { domain: DOMAIN });
    expect(stats).toMatchObject({ total: 0, new_assets: 0, skipped: 0 });
  });
});
