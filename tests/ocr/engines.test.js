// Tests for src/ocr/engines.js — cache hit, unknown engine, runAllEngines fault tolerance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-ocr-engines-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb, saveOcrPage } from '../../src/db.js';
import { runEngine, runAllEngines } from '../../src/ocr/engines.js';

const DOMAIN = 'ocr-engines.example.com';
const DOC_URL = `https://${DOMAIN}/doc.pdf`;

describe('runEngine', () => {
  let db;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    db = openDb(DOMAIN);
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns cached result without calling runner when cache hit exists', async () => {
    saveOcrPage(db, { docUrl: DOC_URL, pageNo: 1, engine: 'tesseract', text_md: 'cached text', confidence: 0.9, bboxes_json: '[]', bytes: 11 });
    const result = await runEngine(db, DOC_URL, 1, 'tesseract', '/nonexistent.png');
    expect(result.fromCache).toBe(true);
    expect(result.text_md).toBe('cached text');
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('throws for unknown engine name', async () => {
    await expect(runEngine(db, DOC_URL, 1, 'bogus-engine', '/nonexistent.png')).rejects.toThrow('Unknown OCR engine: bogus-engine');
  });
});

describe('runAllEngines', () => {
  let db;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    db = openDb(DOMAIN);
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns cached results for all engines with populated cache', async () => {
    saveOcrPage(db, { docUrl: DOC_URL, pageNo: 2, engine: 'tesseract', text_md: 'cached page 2', confidence: 0.8, bboxes_json: '[]', bytes: 13 });
    const results = await runAllEngines(db, DOC_URL, 2, '/nonexistent.png', ['tesseract']);
    expect(results).toHaveLength(1);
    expect(results[0].engine).toBe('tesseract');
    expect(results[0].fromCache).toBe(true);
    expect(results[0].text_md).toBe('cached page 2');
  });

  it('returns empty text for failed engine (graceful degradation)', async () => {
    // 'bogus' engine will throw — runAllEngines should return empty result, not reject
    const results = await runAllEngines(db, DOC_URL, 3, '/nonexistent.png', ['bogus-engine']);
    expect(results).toHaveLength(1);
    expect(results[0].engine).toBe('bogus-engine');
    expect(results[0].text_md).toBe('');
    expect(results[0].confidence).toBe(0);
  });

  it('handles mixed success/failure across multiple engines', async () => {
    // tesseract has cached result; bogus-engine will fail
    saveOcrPage(db, { docUrl: DOC_URL, pageNo: 4, engine: 'tesseract', text_md: 'good text', confidence: 0.85, bboxes_json: '[]', bytes: 9 });
    const results = await runAllEngines(db, DOC_URL, 4, '/nonexistent.png', ['tesseract', 'bogus-engine']);
    expect(results).toHaveLength(2);
    expect(results[0].text_md).toBe('good text');
    expect(results[1].text_md).toBe('');
  });
});
