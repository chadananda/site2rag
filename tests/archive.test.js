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
});
