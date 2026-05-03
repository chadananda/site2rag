import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-score-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';
import { scorePdf, saveQualityScore, maybeQueue } from '../src/pdf-upgrade/score.js';

const DOMAIN = 'score.example.com';

/** Build a minimal valid 1-page text PDF with the given ASCII text. */
function makeTextPdf(text) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objs = [
    null,
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = body.length;
  const entries = ['0000000000 65535 f ', ...offsets.slice(1).map(o => o.toString().padStart(10, '0') + ' 00000 n ')].join('\n') + '\n';
  body += `xref\n0 6\n${entries}trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body);
}

describe('scorePdf', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = join(testRoot, 'pdfs');
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns zero metrics for nonexistent path', async () => {
    const result = await scorePdf(join(tmpDir, 'ghost.pdf'));
    expect(result.composite_score).toBe(0);
    expect(result.has_text_layer).toBe(0);
    expect(result.pages).toBe(0);
  });

  it('returns zero metrics for a non-PDF file', async () => {
    const path = join(tmpDir, 'fake.pdf');
    writeFileSync(path, 'this is not a pdf');
    const result = await scorePdf(path);
    expect(result.composite_score).toBe(0);
  });

  it('detects text layer and scores above zero for a text PDF', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const path = join(tmpDir, 'text.pdf');
    writeFileSync(path, makeTextPdf(text.slice(0, 200)));
    const result = await scorePdf(path);
    expect(result.has_text_layer).toBe(1);
    expect(result.composite_score).toBeGreaterThan(0);
    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.language).toBe('english');
  });

  it('returns language=unknown for a PDF with no recognisable text', async () => {
    const path = join(tmpDir, 'empty-stream.pdf');
    // PDF with empty stream — has_text_layer=0, language=unknown
    writeFileSync(path, makeTextPdf(''));
    const result = await scorePdf(path);
    expect(result.language).toBe('unknown');
  });
});

describe('saveQualityScore', () => {
  let db;
  beforeEach(() => {
    mkdirSync(join(testRoot, 'pdfs'), { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('inserts a new quality row', () => {
    const metrics = { avg_chars_per_page: 500, readable_pages_pct: 0.9, has_text_layer: 1, word_quality_estimate: 0.8, composite_score: 0.75, pages: 3, pdf_title: 'Test', excerpt: 'Sample text', language: 'english' };
    saveQualityScore(db, 'https://score.example.com/doc.pdf', 'sha256:abc', metrics);
    const row = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get('https://score.example.com/doc.pdf');
    expect(row).toBeTruthy();
    expect(row.composite_score).toBe(0.75);
    expect(row.has_text_layer).toBe(1);
    expect(row.ai_language).toBe('english');
    expect(row.pages).toBe(3);
  });

  it('upserts on re-score (same url, new hash)', () => {
    const base = { avg_chars_per_page: 100, readable_pages_pct: 0.5, has_text_layer: 0, word_quality_estimate: 0.3, composite_score: 0.2, pages: 1, pdf_title: '', excerpt: '', language: 'unknown' };
    saveQualityScore(db, 'https://score.example.com/doc.pdf', 'sha256:v1', base);
    saveQualityScore(db, 'https://score.example.com/doc.pdf', 'sha256:v2', { ...base, composite_score: 0.85 });
    const row = db.prepare('SELECT composite_score FROM pdf_quality WHERE url=?').get('https://score.example.com/doc.pdf');
    expect(row.composite_score).toBe(0.85);
  });
});

describe('maybeQueue', () => {
  let db;
  beforeEach(() => {
    mkdirSync(join(testRoot, 'pdfs'), { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('queues a low-score PDF', () => {
    const result = maybeQueue(db, 'https://score.example.com/low.pdf', 'sha256:low', 0.3, 0.7, 'english');
    expect(result).toBe(true);
    const row = db.prepare("SELECT * FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/low.pdf');
    expect(row).toBeTruthy();
    expect(row.status).toBe('pending');
    expect(row.priority).toBeGreaterThan(0);
  });

  it('does not queue a high-score PDF', () => {
    const result = maybeQueue(db, 'https://score.example.com/high.pdf', 'sha256:high', 0.85, 0.7, 'english');
    expect(result).toBe(false);
    const row = db.prepare("SELECT * FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/high.pdf');
    expect(row).toBeUndefined();
  });

  it('does not re-queue a doc already processing or done', () => {
    db.prepare("INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at) VALUES (?,?,?,?,?)").run('https://score.example.com/inprog.pdf', 'sha256:x', 0.5, 'processing', new Date().toISOString());
    const result = maybeQueue(db, 'https://score.example.com/inprog.pdf', 'sha256:x', 0.2, 0.7, 'english');
    expect(result).toBe(false);
  });

  it('priority is higher for english than arabic at same score', () => {
    maybeQueue(db, 'https://score.example.com/en.pdf', 'sha256:en', 0.3, 0.7, 'english');
    maybeQueue(db, 'https://score.example.com/ar.pdf', 'sha256:ar', 0.3, 0.7, 'arabic');
    const en = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/en.pdf');
    const ar = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/ar.pdf');
    expect(en.priority).toBeGreaterThan(ar.priority);
  });
});
