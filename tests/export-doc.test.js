// export-doc.js regression tests. Tests addBacklink, assembleDocMd, exportTextPdf skip logic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const testRoot = join(tmpdir(), `site2rag-export-doc-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { addBacklink, assembleDocMd, exportTextPdf, runExportDoc, withTimeout, buildFrontmatter } from '../src/export-doc.js';
import { openDb, upsertExport } from '../src/db.js';
import { mdDir } from '../src/config.js';
const DOMAIN = 'exportdoc.example.com';
const SOURCE_URL = `https://${DOMAIN}/report.pdf`;
describe('addBacklink', () => {
  it('format=both includes visible link AND data span', () => {
    const result = addBacklink('Paragraph text.', SOURCE_URL, 3, 2, 'both', 'paragraph');
    expect(result).toContain('[↗ p.3]');
    expect(result).toContain(`<span data-pdf-page="3"`);
  });
  it('format=visible has NO span element', () => {
    const result = addBacklink('Paragraph text.', SOURCE_URL, 3, 2, 'visible', 'paragraph');
    expect(result).toContain('[↗ p.3]');
    expect(result).not.toContain('<span');
  });
  it('format=comment has span but NO visible link text', () => {
    const result = addBacklink('Paragraph text.', SOURCE_URL, 3, 2, 'comment', 'paragraph');
    expect(result).toContain('<span data-pdf-page="3"');
    expect(result).not.toContain('[↗ p.3]');
  });
  it('granularity=page returns text unchanged', () => {
    const text = 'Should not be modified.';
    const result = addBacklink(text, SOURCE_URL, 1, 1, 'both', 'page');
    expect(result).toBe(text);
  });
  it('anchor URL contains correct page number fragment', () => {
    const result = addBacklink('text', SOURCE_URL, 5, 1, 'both', 'paragraph');
    expect(result).toContain(`${SOURCE_URL}#page=5`);
  });
  it('data-pdf-para attribute reflects paraNo', () => {
    const result = addBacklink('text', SOURCE_URL, 2, 7, 'both', 'paragraph');
    expect(result).toContain('data-pdf-para="7"');
  });
});
describe('assembleDocMd', () => {
  it('granularity=page produces page headers (## Page N)', () => {
    const pageResults = [
      { pageNo: 1, text_md: 'First page content.\n\nSecond paragraph.' },
      { pageNo: 2, text_md: 'Second page content.' }
    ];
    const md = assembleDocMd(pageResults, SOURCE_URL, 'both', 'page');
    expect(md).toContain('## Page 1');
    expect(md).toContain('## Page 2');
    // No span elements in page granularity
    expect(md).not.toContain('<span data-pdf-page');
  });
  it('granularity=paragraph appends backlinks to each non-empty paragraph', () => {
    const pageResults = [
      { pageNo: 1, text_md: 'First paragraph.\n\nSecond paragraph.' }
    ];
    const md = assembleDocMd(pageResults, SOURCE_URL, 'both', 'paragraph');
    // Each paragraph should have a backlink
    expect(md).toContain('[↗ p.1]');
    expect(md).toContain('<span data-pdf-page="1"');
  });
  it('granularity=paragraph skips empty paragraphs (no backlink added)', () => {
    const pageResults = [{ pageNo: 1, text_md: 'Real paragraph.\n\n\n\nAnother.' }];
    const md = assembleDocMd(pageResults, SOURCE_URL, 'both', 'paragraph');
    // Should not error on empty paragraph sections
    expect(md).toContain('Real paragraph.');
  });
  it('returns empty string for empty pageResults array', () => {
    expect(assembleDocMd([], SOURCE_URL, 'both', 'paragraph')).toBe('');
  });

  it('page header includes link to source PDF at correct page', () => {
    const pageResults = [{ pageNo: 3, text_md: 'Content.' }];
    const md = assembleDocMd(pageResults, SOURCE_URL, 'both', 'page');
    expect(md).toContain(`${SOURCE_URL}#page=3`);
  });
});
describe('exportTextPdf', () => {
  let db, tmpDir;
  beforeEach(() => {
    tmpDir = join(testRoot, 'pdfs');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(mdDir(DOMAIN), { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });
  it('returns false when source_hash already matches content_hash in exports (skip)', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'));
    const page = {
      url: SOURCE_URL, local_path: pdfPath, content_hash: 'sha256:existing',
      path_slug: 'report', last_seen_at: new Date().toISOString(),
      backup_url: null, mime_type: 'application/pdf'
    };
    // Pre-populate exports with matching hash
    upsertExport(db, {
      url: SOURCE_URL, md_path: '/tmp/report.md', source_hash: 'sha256:existing',
      md_hash: null, exported_at: new Date().toISOString(), conversion_method: 'pdf-text',
      word_count: 100, ocr_used: 0, ocr_engines: null, reconciler: null, pages: 1,
      agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'ok', error: null
    });
    const result = await exportTextPdf(db, { domain: DOMAIN, ocr: {}, document: {} }, page);
    expect(result).toBe(false);
  });
  it('returns false when local_path does not exist', async () => {
    const page = {
      url: SOURCE_URL, local_path: join(tmpDir, 'nonexistent.pdf'), content_hash: 'sha256:abc',
      path_slug: 'nonexistent', last_seen_at: new Date().toISOString(),
      backup_url: null, mime_type: 'application/pdf'
    };
    const result = await exportTextPdf(db, { domain: DOMAIN, ocr: {}, document: {} }, page);
    expect(result).toBe(false);
  });
});

describe('runExportDoc', () => {
  let db, tmpDir;
  beforeEach(() => {
    tmpDir = join(testRoot, 'pdfs2');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(mdDir(DOMAIN), { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns empty stats immediately when prefer_format=html', async () => {
    // Insert a PDF page that would normally be processed
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(SOURCE_URL, 'report', join(tmpDir, 'report.pdf'), 'application/pdf', 0);
    const stats = await runExportDoc(db, { domain: DOMAIN, rules: { prefer_format: 'html' } });
    expect(stats.written).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('increments failed when PDF local_path does not exist', async () => {
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone) VALUES (?,?,?,?,?)')
      .run(SOURCE_URL, 'report', join(tmpDir, 'nonexistent.pdf'), 'application/pdf', 0);
    const stats = await runExportDoc(db, { domain: DOMAIN });
    expect(stats.failed).toBe(1);
  });

  it('skips PDF when exp_hash matches content_hash (unchanged)', async () => {
    const pdfPath = join(tmpDir, 'cached.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'));
    db.prepare('INSERT INTO pages (url, path_slug, local_path, mime_type, gone, content_hash) VALUES (?,?,?,?,?,?)')
      .run(`${SOURCE_URL}cached`, 'cached', pdfPath, 'application/pdf', 0, 'sha256:cached');
    upsertExport(db, {
      url: `${SOURCE_URL}cached`, md_path: '/tmp/cached.md', source_hash: 'sha256:cached',
      md_hash: null, exported_at: new Date().toISOString(), conversion_method: 'pdf-text',
      word_count: 50, ocr_used: 0, ocr_engines: null, reconciler: null, pages: 1,
      agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'ok', error: null
    });
    const stats = await runExportDoc(db, { domain: DOMAIN });
    expect(stats.skipped).toBe(1);
    expect(stats.written).toBe(0);
  });
});

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  it('rejects with timeout error when promise takes too long', async () => {
    const slow = new Promise(r => setTimeout(r, 200));
    await expect(withTimeout(slow, 10, 'slow-op')).rejects.toThrow('slow-op timed out after 10ms');
  });

  it('propagates original rejection when promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow('original error');
  });

  it('timeout error message includes label and ms', async () => {
    const neverResolves = new Promise(() => {});
    try {
      await withTimeout(neverResolves, 5, 'pdf-parse');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).toBe('pdf-parse timed out after 5ms');
    }
  });
});

describe('buildFrontmatter', () => {
  it('wraps key-value pairs in YAML front matter delimiters', () => {
    const result = buildFrontmatter({ title: 'Test Doc', author: 'Smith' });
    expect(result).toMatch(/^---\n/);
    expect(result).toContain('title: Test Doc');
    expect(result).toContain('author: Smith');
    expect(result).toContain('\n---\n\n');
  });

  it('omits null values', () => {
    const result = buildFrontmatter({ title: 'Valid', missing: null });
    expect(result).toContain('title: Valid');
    expect(result).not.toContain('missing');
  });

  it('omits undefined values', () => {
    const result = buildFrontmatter({ title: 'Valid', extra: undefined });
    expect(result).not.toContain('extra');
  });

  it('serializes object values as JSON', () => {
    const result = buildFrontmatter({ tags: ['a', 'b'] });
    expect(result).toContain('tags: ["a","b"]');
  });

  it('converts numbers to strings', () => {
    const result = buildFrontmatter({ count: 42 });
    expect(result).toContain('count: 42');
  });

  it('returns valid YAML block for empty object', () => {
    const result = buildFrontmatter({});
    expect(result).toBe('---\n\n---\n\n');
  });
});
