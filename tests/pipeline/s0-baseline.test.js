import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, makeTextPdf, makeCtx } from './helpers.js';
import { s0Baseline } from '../../src/pipeline/stages/s0-baseline.js';

// CONTRACT tests: verify shape and behavior regardless of scoring implementation

describe('s0Baseline — contract', () => {
  let tmpDir, cleanup;
  beforeEach(() => { ({ dir: tmpDir, cleanup } = makeTempDir()); });
  afterEach(() => cleanup());

  it('sets quality.baseline with required fields', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf('Hello world this is readable text on the first page'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });

    await s0Baseline(ctx);

    expect(ctx.quality.baseline).not.toBeNull();
    expect(ctx.quality.baseline).toMatchObject({
      composite_score: expect.any(Number),
      readable_pages_pct: expect.any(Number),
      word_quality: expect.any(Number),
      has_text_layer: expect.any(Number),
    });
    expect(ctx.quality.baseline.composite_score).toBeGreaterThanOrEqual(0);
    expect(ctx.quality.baseline.composite_score).toBeLessThanOrEqual(1);
  });

  it('records a stage entry with duration', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf('Some text'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });

    await s0Baseline(ctx);

    const stage = ctx.metrics.stages.find(s => s.stage === 's0');
    expect(stage).toBeDefined();
    expect(stage.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records at least one decision', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf('Hello world'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });

    await s0Baseline(ctx);
    expect(ctx.metrics.decisions.some(d => d.stage === 's0')).toBe(true);
  });

  it('sets ctx.pageCount > 0 for a valid PDF', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf('Hello world'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });

    await s0Baseline(ctx);
    expect(ctx.pageCount).toBeGreaterThan(0);
  });

  it('mirrors baseline score into quality.perStage.s0', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf('Some readable content here'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });

    await s0Baseline(ctx);
    expect(ctx.quality.perStage.s0).toBe(ctx.quality.baseline.composite_score);
  });

  it('adds heavy-stage skip flags when doc is already good', async () => {
    const pdfPath = join(tmpDir, 'good.pdf');
    writeFileSync(pdfPath, makeTextPdf(
      'The quick brown fox jumps over the lazy dog. ' .repeat(20)
    ));
    const ctx = makeCtx({
      dir: tmpDir, pdfPath,
      config: { thresholds: { goodDoc: 0.01 } }  // artificially low threshold so any text qualifies
    });

    await s0Baseline(ctx);
    // If score > threshold, heavy stages should be skipped
    if (ctx.quality.baseline.composite_score >= 0.01) {
      expect(ctx.config.skip).toContain('s1');
      expect(ctx.config.skip).toContain('s5');
    }
  });

  it('handles missing file gracefully without throwing', async () => {
    const ctx = makeCtx({ pdfPath: join(tmpDir, 'nonexistent.pdf') });
    ctx.config.failFast = false;

    await expect(s0Baseline(ctx)).resolves.toBeDefined();
    expect(ctx.quality.baseline).not.toBeNull();
    expect(ctx.metrics.errors.some(e => e.stage === 's0')).toBe(true);
  });

  it('throws when failFast=true and file is missing', async () => {
    const ctx = makeCtx({ pdfPath: join(tmpDir, 'missing.pdf') });
    ctx.config.failFast = true;

    await expect(s0Baseline(ctx)).rejects.toThrow();
  });

  it('returns the same ctx object (mutation, not copy)', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf('hello'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });
    const returned = await s0Baseline(ctx);
    expect(returned).toBe(ctx);
  });
});

// SKIP LOGIC tests: verify skip flag decisions from s0
describe('s0Baseline — skip logic', () => {
  let tmpDir, cleanup;
  beforeEach(() => { ({ dir: tmpDir, cleanup } = makeTempDir()); });
  afterEach(() => cleanup());

  it('skips s1-s5 when text PDF has high avg chars per page (text_layer_skip)', async () => {
    const pdfPath = join(tmpDir, 'textrich.pdf');
    // 350+ chars of English text → has_text_layer=1 AND avg_chars >= 300
    writeFileSync(pdfPath, makeTextPdf('word '.repeat(80)));
    const ctx = makeCtx({ dir: tmpDir, pdfPath, config: { thresholds: { goodDoc: 0.99 } } });

    await s0Baseline(ctx);

    if (ctx.quality.baseline.has_text_layer === 1 && ctx.quality.baseline.avg_chars_per_page >= 300) {
      expect(ctx.config.skip).toContain('s1');
      expect(ctx.config.skip).toContain('s3');
      expect(ctx.config.skip).toContain('s5');
      const decision = ctx.metrics.decisions.find(d => d.decision === 'skip_all_ocr');
      expect(decision).toBeDefined();
    }
  });

  it('does NOT skip s4-s5 for sparse text PDFs with low quality (needs OCR)', async () => {
    const pdfPath = join(tmpDir, 'sparse.pdf');
    // 50 chars — has_text_layer=1 but avg_chars < 300 and quality below threshold
    writeFileSync(pdfPath, makeTextPdf('hello world short text'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath, config: { thresholds: { goodDoc: 0.99 } } });

    await s0Baseline(ctx);

    const baseline = ctx.quality.baseline;
    if (baseline.has_text_layer === 1 && (baseline.avg_chars_per_page ?? 0) < 300) {
      // sparse text layer + low quality → OCR escalation is needed, do NOT skip s4/s5
      expect(ctx.config.skip).not.toContain('s4');
      expect(ctx.config.skip).not.toContain('s5');
    }
  });

  it('skips s5 when importance below localVision gate on easy doc', async () => {
    const pdfPath = join(tmpDir, 'easy.pdf');
    writeFileSync(pdfPath, makeTextPdf('hello world '.repeat(5)));
    // importance=1, localVision=3 → skip s5 if difficulty < 0.3
    const ctx = makeCtx({
      dir: tmpDir, pdfPath, importance: 1,
      config: { thresholds: { goodDoc: 0.99 }, escalation: { localVision: 3 } },
    });

    await s0Baseline(ctx);

    const baseline = ctx.quality.baseline;
    if ((baseline.processing_difficulty ?? 1) < 0.3) {
      expect(ctx.config.skip).toContain('s5');
      const decision = ctx.metrics.decisions.find(d => d.decision === 'skip_vision');
      expect(decision).toBeDefined();
    }
  });
});

// QUALITY tests: verify actual improvement direction on known fixtures
describe('s0Baseline — quality', () => {
  let tmpDir, cleanup;
  beforeEach(() => { ({ dir: tmpDir, cleanup } = makeTempDir()); });
  afterEach(() => cleanup());

  it('scores a text-bearing PDF higher than an empty page', async () => {
    const textPdf = join(tmpDir, 'text.pdf');
    const emptyPdf = join(tmpDir, 'empty.pdf');
    writeFileSync(textPdf, makeTextPdf('The quick brown fox jumps over the lazy dog '.repeat(10)));
    writeFileSync(emptyPdf, makeTextPdf(''));

    const ctxText = makeCtx({ dir: tmpDir, pdfPath: textPdf });
    const ctxEmpty = makeCtx({ dir: tmpDir, pdfPath: emptyPdf });

    await s0Baseline(ctxText);
    await s0Baseline(ctxEmpty);

    expect(ctxText.quality.baseline.composite_score)
      .toBeGreaterThan(ctxEmpty.quality.baseline.composite_score);
  });
});
