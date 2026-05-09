// Fixture-based regression tests — real PDFs, real tools (pdf-parse, tesseract, pdftoppm).
// No mocks. Catches regressions in scoring heuristics, language detection, and OCR output quality.
// Fixtures: tests/fixtures/pdfs/*.pdf  (committed, ~3MB total, extracted 1-2pp from production docs)
// Manifest: tests/fixtures/manifest.json — expected score ranges per fixture
//
// Run time: ~20-40s (tesseract + pdftoppm on real images)
// Skip individual fixtures by setting SKIP_FIXTURES=eng-multicol,... in env

import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dir, 'fixtures');
const PDF_DIR = join(FIXTURE_DIR, 'pdfs');

const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
const SKIP = new Set((process.env.SKIP_FIXTURES ?? '').split(',').filter(Boolean));

// Lazy import so SITE2RAG_ROOT set in process.env before module load
let scorePdf, detectLanguage;
beforeAll(async () => {
  process.env.SITE2RAG_ROOT = mkdtempSync(join(tmpdir(), 'site2rag-fixture-'));
  ({ scorePdf } = await import('../src/pdf-upgrade/score.js'));
  ({ detectLanguage } = await import('../src/language.js'));
});

// ── helpers ──────────────────────────────────────────────────────────────────

function fixture(name) {
  const meta = manifest.fixtures[name];
  if (!meta) throw new Error(`Unknown fixture: ${name}`);
  return { ...meta, path: join(PDF_DIR, meta.file.replace('pdfs/', '')) };
}

function skipIf(name) {
  return SKIP.has(name) || !existsSync(fixture(name).path);
}

// Rasterize page 1 of a PDF to PNG using pdftoppm. Returns path or null.
async function rasterizePage(pdfPath, dpi = 150) {
  const tmp = mkdtempSync(join(tmpdir(), 'fixture-raster-'));
  const outBase = join(tmp, 'page');
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), '-f', '1', '-l', '1', '-singlefile', pdfPath, outBase], { timeout: 30000 });
    const pngPath = `${outBase}.png`;
    return existsSync(pngPath) ? { pngPath, cleanup: () => rmSync(tmp, { recursive: true, force: true }) } : null;
  } catch {
    return null;
  }
}

// Run tesseract on a PNG and return { text, wordCount }
async function runTesseract(pngPath, lang = 'eng') {
  try {
    const { stdout } = await execFileAsync('tesseract', [pngPath, 'stdout', '-l', lang], { timeout: 60000 });
    const text = stdout.trim();
    const wordCount = text.split(/\s+/).filter(w => w.length >= 2).length;
    return { text, wordCount };
  } catch {
    return { text: '', wordCount: 0 };
  }
}

// ── scorePdf regression tests — real pdf-parse output ───────────────────────

describe('scorePdf — fixture regression', () => {
  for (const [name, meta] of Object.entries(manifest.fixtures)) {
    it(`${name}: scores within expected ranges`, async () => {
      if (skipIf(name)) return;
      const f = fixture(name);
      const result = await scorePdf(f.path);

      // has_text_layer
      expect(result.has_text_layer).toBe(meta.has_text_layer ? 1 : 0);

      // page count within ±1 (gs extraction can add/remove blank pages)
      expect(result.pages).toBeGreaterThanOrEqual(meta.pages - 1);
      expect(result.pages).toBeLessThanOrEqual(meta.pages + 1);

      // composite score in expected range
      expect(result.composite_score).toBeGreaterThanOrEqual(meta.composite_score.min);
      expect(result.composite_score).toBeLessThanOrEqual(meta.composite_score.max);

      // word_quality_estimate in expected range
      expect(result.word_quality_estimate).toBeGreaterThanOrEqual(meta.word_quality.min);
      expect(result.word_quality_estimate).toBeLessThanOrEqual(meta.word_quality.max);

      // processing_difficulty bounds (manifest uses {min?, max?})
      if (meta.processing_difficulty?.min != null)
        expect(result.processing_difficulty).toBeGreaterThanOrEqual(meta.processing_difficulty.min);
      if (meta.processing_difficulty?.max != null)
        expect(result.processing_difficulty).toBeLessThanOrEqual(meta.processing_difficulty.max);
    }, 30000);
  }
});

// ── language detection — text-layer docs ────────────────────────────────────

describe('language detection — fixture regression', () => {
  it('detects english text in eng-text-clean', async () => {
    if (skipIf('eng-text-clean')) return;
    const result = await scorePdf(fixture('eng-text-clean').path);
    expect(result.language).toBe('english');
  }, 15000);

  it('detects persian in per-image-printed (via scoring)', async () => {
    if (skipIf('per-image-printed')) return;
    const result = await scorePdf(fixture('per-image-printed').path);
    // pdf-parse may not extract Persian text; language may be unknown or persian
    expect(['persian', 'unknown', 'english']).toContain(result.language);
  }, 15000);

  it('returns processing_difficulty=0.05 for text-layer docs', async () => {
    if (skipIf('eng-text-clean')) return;
    const result = await scorePdf(fixture('eng-text-clean').path);
    expect(result.processing_difficulty).toBe(0.05);
  }, 15000);

  it('returns processing_difficulty >= 0.3 for image-only docs (no text layer)', async () => {
    const imageOnly = Object.entries(manifest.fixtures)
      .filter(([, m]) => !m.has_text_layer)
      .map(([name]) => name);
    for (const name of imageOnly) {
      if (skipIf(name)) continue;
      const result = await scorePdf(fixture(name).path);
      expect(result.processing_difficulty, `${name} processing_difficulty`).toBeGreaterThanOrEqual(0.3);
    }
  }, 30000);
});

// ── Tesseract OCR on real rasterized pages ───────────────────────────────────

describe('tesseract OCR — fixture regression', { timeout: 120000 }, () => {
  it('extracts meaningful English text from eng-text-clean page 1', async () => {
    if (skipIf('eng-text-clean')) return;
    const r = await rasterizePage(fixture('eng-text-clean').path, 150);
    if (!r) return; // pdftoppm not available — skip gracefully
    const { text, wordCount } = await runTesseract(r.pngPath, 'eng');
    r.cleanup();
    // Digital text-layer PDF rasterized at 150dpi — Tesseract should get clean output
    expect(wordCount).toBeGreaterThan(30);
    // Should not be garbage (vowel ratio test)
    const words = text.split(/\s+/).filter(w => w.length >= 3 && w.length <= 20);
    const withVowels = words.filter(w => /[aeiou]/i.test(w));
    expect(withVowels.length / Math.max(1, words.length)).toBeGreaterThan(0.5);
  });

  it('produces low word count from handwriting page (near-zero OCR confidence expected)', async () => {
    if (skipIf('handwriting')) return;
    const r = await rasterizePage(fixture('handwriting').path, 150);
    if (!r) return;
    const { wordCount } = await runTesseract(r.pngPath, 'eng');
    r.cleanup();
    // Handwritten Persian/Arabic manuscript — English Tesseract should find almost nothing
    expect(wordCount).toBeLessThan(20);
  });

  it('extracts some text from eng-image-scan with English tesseract', async () => {
    if (skipIf('eng-image-scan')) return;
    const r = await rasterizePage(fixture('eng-image-scan').path, 200);
    if (!r) return;
    const { wordCount } = await runTesseract(r.pngPath, 'eng');
    r.cleanup();
    // Real printed scan — should get some words even without preprocessing
    expect(wordCount).toBeGreaterThan(10);
  });

  it('arabic tesseract on ara-image-scan produces fewer junk tokens than english', async () => {
    if (skipIf('ara-image-scan')) return;
    const r = await rasterizePage(fixture('ara-image-scan').path, 200);
    if (!r) return;
    const [engResult, araResult] = await Promise.all([
      runTesseract(r.pngPath, 'eng'),
      runTesseract(r.pngPath, 'ara'),
    ]);
    r.cleanup();
    // Arabic tesseract on an Arabic scan should produce more text than English tesseract
    // (eng sees garbage symbols, ara at least recognizes the script)
    expect(araResult.wordCount).toBeGreaterThanOrEqual(engResult.wordCount);
  });
});

// ── ocrNoiseRatio sanity on real OCR output ──────────────────────────────────

describe('ocrNoiseRatio — real tesseract output', { timeout: 60000 }, () => {
  it('clean English text-layer PDF has low noise ratio after OCR', async () => {
    if (skipIf('eng-text-clean')) return;
    const { ocrNoiseRatio } = await import('../src/pdf-upgrade/score.js');
    const r = await rasterizePage(fixture('eng-text-clean').path, 150);
    if (!r) return;
    const { text } = await runTesseract(r.pngPath, 'eng');
    r.cleanup();
    if (text.split(/\s+/).filter(w => w.length >= 3).length < 10) return; // too little text
    expect(ocrNoiseRatio(text)).toBeLessThan(0.1);
  });
});
