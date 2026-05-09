// Archive stage BDD tests. Mocks @aws-sdk/client-s3 — no real S3.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-archive-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn(params => ({ ...params, _cmd: 'Put' })),
  HeadObjectCommand: vi.fn(params => ({ ...params, _cmd: 'Head' })),
}));

import { openDb } from '../src/db.js';
import { runArchive } from '../src/archive.js';

const DOMAIN = 'archive.example.com';
const SITE_URL = `https://${DOMAIN}`;
const archiveCfg = {
  enabled: true,
  upload_html: true,
  upload_documents: true,
  s3_bucket: 'test-bucket',
  s3_region: 'us-east-1',
  public_url_template: 'https://cdn.example.com/{domain}/{path}'
};

describe('runArchive', () => {
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

  const insertPage = (slug, html, extra = {}) => {
    const path = join(pagesDir, `${slug}.html`);
    writeFileSync(path, html);
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, content_hash) VALUES (?,?,?,?,?,?)')
      .run(`${SITE_URL}/${slug}`, slug, path, 'text/html', 0, extra.content_hash || `hash-${slug}`);
    return path;
  };

  it('returns zeroed stats when archive disabled', async () => {
    insertPage('page', '<html>hi</html>');
    const stats = await runArchive(db, { domain: DOMAIN, archive: { enabled: false } });
    expect(stats).toMatchObject({ uploaded: 0, skipped: 0, failed: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uploads pages to S3 and records backup_url', async () => {
    insertPage('page', '<html><body>content</body></html>');
    mockSend.mockResolvedValue({ ETag: '"abc123"' });

    const stats = await runArchive(db, { domain: DOMAIN, archive: archiveCfg });
    expect(stats.uploaded).toBe(1);
    expect(mockSend).toHaveBeenCalled();
    const row = db.prepare('SELECT backup_url FROM pages WHERE url=?').get(`${SITE_URL}/page`);
    expect(row.backup_url).toBeTruthy();
  });

  it('skips page with noarchive meta directive', async () => {
    insertPage('noarchive', '<html><head><meta name="robots" content="noarchive"></head><body>hi</body></html>');

    const stats = await runArchive(db, { domain: DOMAIN, archive: { ...archiveCfg, respect_archive_block: true } });
    expect(stats.uploaded).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips page when backup_etag matches content_hash (unchanged)', async () => {
    const path = insertPage('unchanged', '<html>same</html>', { content_hash: 'hash-same' });
    db.prepare('UPDATE pages SET backup_etag=? WHERE url=?').run('hash-same', `${SITE_URL}/unchanged`);

    const stats = await runArchive(db, { domain: DOMAIN, archive: archiveCfg });
    expect(stats.skipped).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('handles S3 upload failure gracefully (increments failed, no crash)', async () => {
    insertPage('page', '<html>content</html>');
    mockSend.mockRejectedValue(new Error('S3 error'));

    const stats = await runArchive(db, { domain: DOMAIN, archive: archiveCfg });
    expect(stats.failed).toBe(1);
    expect(stats.uploaded).toBe(0);
  });

  it('uploads PDF documents when upload_documents is true', async () => {
    const pdfPath = join(pagesDir, 'report.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake content'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, content_hash) VALUES (?,?,?,?,?,?)')
      .run(`${SITE_URL}/report.pdf`, 'report', pdfPath, 'application/pdf', 0, 'hash-pdf');
    mockSend.mockResolvedValue({ ETag: '"pdf123"' });

    const stats = await runArchive(db, { domain: DOMAIN, archive: { ...archiveCfg, upload_html: false, upload_documents: true } });
    expect(stats.uploaded).toBe(1);
    const row = db.prepare('SELECT backup_url FROM pages WHERE url=?').get(`${SITE_URL}/report.pdf`);
    expect(row.backup_url).toBeTruthy();
  });

  it('returns empty stats when neither upload_html nor upload_documents is set', async () => {
    insertPage('page', '<html>hi</html>');
    const stats = await runArchive(db, { domain: DOMAIN, archive: { enabled: true, s3_bucket: 'test' } });
    expect(stats.uploaded).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uploads assets when upload_assets is true', async () => {
    const assetPath = join(pagesDir, 'image.png');
    writeFileSync(assetPath, Buffer.from('PNG_FAKE'));
    // backup_etag NULL means not yet uploaded — will be picked up by archive
    db.prepare('INSERT INTO assets (hash, path, original_url, mime_type, bytes, ref_count, backup_etag) VALUES (?,?,?,?,?,?,?)')
      .run('sha256:imgabc', assetPath, `${SITE_URL}/image.png`, 'image/png', 8, 1, null);
    mockSend.mockResolvedValue({ ETag: '"img123"' });

    const stats = await runArchive(db, { domain: DOMAIN, archive: { ...archiveCfg, upload_html: false, upload_assets: true } });
    expect(stats.uploaded).toBe(1);
    const row = db.prepare('SELECT backup_url FROM assets WHERE hash=?').get('sha256:imgabc');
    expect(row.backup_url).toBeTruthy();
  });

  it('rewrites asset URLs in HTML when rewrite_html_assets is true', async () => {
    const path = insertPage('rewrite', `<html><body><img src="${SITE_URL}/logo.png"></body></html>`);
    // Add an asset with backup_url in the DB
    db.prepare('INSERT INTO assets (hash, path, original_url, mime_type, bytes, ref_count, backup_url) VALUES (?,?,?,?,?,?,?)')
      .run('sha256:logoabc', path, `${SITE_URL}/logo.png`, 'image/png', 10, 1, 'https://cdn.example.com/logo.png');
    mockSend.mockResolvedValue({ ETag: '"rewrite123"' });

    await runArchive(db, { domain: DOMAIN, archive: { ...archiveCfg, rewrite_html_assets: true } });
    // Should have called send with a rewritten body containing the CDN URL
    const sendCall = mockSend.mock.calls.find(c => c[0]._cmd === 'Put');
    expect(sendCall).toBeTruthy();
    const uploadedBody = sendCall[0].Body.toString('utf8');
    expect(uploadedBody).toContain('https://cdn.example.com/logo.png');
  });

  it('gone pages are excluded from upload', async () => {
    const path = join(pagesDir, 'gone.html');
    writeFileSync(path, '<html>gone</html>');
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, content_hash) VALUES (?,?,?,?,?,?)')
      .run(`${SITE_URL}/gone`, 'gone', path, 'text/html', 1, 'hash-gone');
    mockSend.mockResolvedValue({ ETag: '"etag"' });

    const stats = await runArchive(db, { domain: DOMAIN, archive: archiveCfg });
    expect(stats.uploaded).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
