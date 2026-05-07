// Tests for lang-detect.js: detectLanguageForImagePdfs Stage 1 (free detection).
// Stage 2 (Tesseract+Haiku identify) requires file system access; only Stage 1 is tested here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-lang-detect-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../../src/db.js';
import { detectLanguageForImagePdfs } from '../../src/pdf-upgrade/lang-detect.js';

const DOMAIN = 'lang-detect-test.example.com';

const insertPdfDoc = (db, url, opts = {}) => {
  const { aiLanguage = null, hasTextLayer = 0, readablePct = 0.1, wordQuality = 0.1 } = opts;
  db.prepare('INSERT OR IGNORE INTO pages (url, mime_type, gone) VALUES (?,?,0)').run(url, 'application/pdf');
  db.prepare(`INSERT OR REPLACE INTO pdf_quality
    (url, has_text_layer, readable_pages_pct, word_quality_estimate, composite_score, ai_language)
    VALUES (?,?,?,?,?,?)`)
    .run(url, hasTextLayer, readablePct, wordQuality, 0.3, aiLanguage);
};

describe('detectLanguageForImagePdfs — Stage 1 URL-based detection', () => {
  let db;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    db = openDb(DOMAIN);
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('detects arabic from /arabic/ URL pattern', async () => {
    const url = 'https://example.com/arabic/document.pdf';
    insertPdfDoc(db, url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_language).toBe('arabic');
  });

  it('detects french from /fr/ URL pattern', async () => {
    const url = 'https://example.com/fr/document.pdf';
    insertPdfDoc(db, url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_language).toBe('french');
  });

  it('detects persian from /persian/ URL pattern', async () => {
    const url = 'https://example.com/persian/text.pdf';
    insertPdfDoc(db, url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_language).toBe('persian');
  });

  it('detects german from /de/ URL pattern', async () => {
    const url = 'https://example.com/de/dokument.pdf';
    insertPdfDoc(db, url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_language).toBe('german');
  });

  it('sets ai_language to some value (not null) for a URL with no hints', async () => {
    const url = 'https://example.com/documents/file123.pdf';
    insertPdfDoc(db, url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    // Stage 1 always writes some ai_language value (unknown or a detected language) — never leaves it null
    expect(row?.ai_language).toBeTruthy();
  });

  it('skips docs that already have a non-unknown language set', async () => {
    const url = 'https://example.com/arabic/doc.pdf';
    // Has ai_language already set to 'arabic' (not unknown)
    insertPdfDoc(db, url, { aiLanguage: 'arabic', hasTextLayer: 1, readablePct: 0.9, wordQuality: 0.8 });
    // Stage 1 query filters out docs with ai_language not null/unknown with good quality
    await detectLanguageForImagePdfs(db, DOMAIN);
    // ai_language should remain arabic (not overwritten)
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_language).toBe('arabic');
  });

  it('re-evaluates docs labeled english with low readability (likely mislabeled)', async () => {
    // english + low readable_pages_pct + low word_quality = suspect, re-detect
    const url = 'https://example.com/arabic/suspicious.pdf';
    insertPdfDoc(db, url, { aiLanguage: 'english', hasTextLayer: 1, readablePct: 0.2, wordQuality: 0.3 });
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    // /arabic/ in URL should override the mislabeled 'english'
    expect(row?.ai_language).toBe('arabic');
  });

  it('detects arabic language from URL path keyword /arabic/', async () => {
    // This tests URL-hint detection for the /arabic/ keyword path (URL_LANG_HINTS)
    const url = 'https://example.com/arabic/important-document.pdf';
    insertPdfDoc(db, url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(url);
    expect(row?.ai_language).toBe('arabic');
  });

  it('reprioritizes pending queue entries after language detection', async () => {
    const url = 'https://example.com/arabic/queued.pdf';
    insertPdfDoc(db, url);
    // Insert a pending queue entry
    db.prepare("INSERT INTO pdf_upgrade_queue (url, status, priority) VALUES (?,?,?)").run(url, 'pending', 1.0);
    const before = db.prepare('SELECT priority FROM pdf_upgrade_queue WHERE url=?').get(url);
    await detectLanguageForImagePdfs(db, DOMAIN);
    const after = db.prepare('SELECT priority FROM pdf_upgrade_queue WHERE url=?').get(url);
    // Priority should be updated (LANG_PRIORITY[arabic] is lower than english, so different value)
    expect(after?.priority).not.toBe(before?.priority);
  });
});
