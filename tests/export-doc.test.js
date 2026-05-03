// export-doc.js regression tests. Tests addBacklink, assembleDocMd, exportTextPdf skip logic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const testRoot = join(tmpdir(), `site2rag-export-doc-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { addBacklink, assembleDocMd, exportTextPdf } from '../src/export-doc.js';
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
