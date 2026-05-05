import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, makeTextPdf, makeCtx } from './helpers.js';
import { runPipeline, runStage, STAGES } from '../../src/pipeline/index.js';
import { PipelineContext } from '../../src/pipeline/context.js';

// Integration tests: run the full pipeline on real fixtures (no mocks)
// Only s0 (baseline) runs non-trivially; stages s1-s8 are stubs that record entries.

describe('runPipeline — integration', () => {
  let tmpDir, cleanup;
  beforeEach(() => { ({ dir: tmpDir, cleanup } = makeTempDir()); });
  afterEach(() => cleanup());

  it('runs all non-skipped stages and returns a populated context', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf('The quick brown fox jumps over the lazy dog. '.repeat(5)));

    const ctx = await runPipeline({
      docId: 'integ-001',
      sourcePath: pdfPath,
      sourceUrl: 'https://example.com/doc.pdf',
      importance: 2,
      config: { failFast: false },
      meta: { title: 'Integration Test Doc' },
    });

    expect(ctx).toBeInstanceOf(PipelineContext);
    expect(ctx.docId).toBe('integ-001');
  });

  it('quality.final is set after pipeline completes', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf('Some readable content '.repeat(10)));

    const ctx = await runPipeline({
      docId: 'integ-002',
      sourcePath: pdfPath,
      sourceUrl: 'https://example.com/doc.pdf',
      importance: 2,
      config: { failFast: false },
    });

    expect(ctx.quality.final).not.toBeNull();
    expect(typeof ctx.quality.final).toBe('number');
  });

  it('s0 stage record is always present', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf('readable text here'));

    const ctx = await runPipeline({
      docId: 'integ-003',
      sourcePath: pdfPath,
      sourceUrl: 'https://example.com/doc.pdf',
      importance: 2,
      config: { failFast: false },
    });

    const s0 = ctx.metrics.stages.find(s => s.stage === 's0');
    expect(s0).toBeDefined();
    expect(s0.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('produces a valid receipt via toReceipt()', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf('receipt test content'));

    const ctx = await runPipeline({
      docId: 'integ-004',
      sourcePath: pdfPath,
      sourceUrl: 'https://example.com/doc.pdf',
      importance: 2,
      config: { failFast: false },
    });

    const receipt = ctx.toReceipt();
    expect(receipt).toMatchObject({
      doc_id: 'integ-004',
      pipeline_version: expect.any(String),
      importance: expect.any(Number),
      quality: expect.objectContaining({ final: expect.any(Number) }),
      totals: expect.objectContaining({ cost_usd: expect.any(Number) }),
    });
  });

  it('no fatal errors on a valid text PDF', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf('no fatal errors test'));

    const ctx = await runPipeline({
      docId: 'integ-005',
      sourcePath: pdfPath,
      sourceUrl: 'https://example.com/doc.pdf',
      importance: 2,
      config: { failFast: false },
    });

    const fatalErrors = ctx.metrics.errors.filter(e => !e.recoverable);
    expect(fatalErrors).toHaveLength(0);
  });

  it('records a recoverable error (not fatal) for missing PDF when failFast=false', async () => {
    const ctx = await runPipeline({
      docId: 'integ-006',
      sourcePath: join(tmpDir, 'missing.pdf'),
      sourceUrl: 'https://example.com/missing.pdf',
      importance: 2,
      config: { failFast: false },
    });

    expect(ctx.metrics.errors.some(e => e.stage === 's0')).toBe(true);
    // Pipeline should complete without throwing
    expect(ctx.quality.final).not.toBeUndefined();
  });

  it('throws on missing PDF when failFast=true', async () => {
    await expect(runPipeline({
      docId: 'integ-007',
      sourcePath: join(tmpDir, 'missing.pdf'),
      sourceUrl: 'https://example.com/missing.pdf',
      importance: 2,
      config: { failFast: true },
    })).rejects.toThrow();
  });
});

describe('runStage — integration', () => {
  let tmpDir, cleanup;
  beforeEach(() => { ({ dir: tmpDir, cleanup } = makeTempDir()); });
  afterEach(() => cleanup());

  it('re-runs s0 on an existing context and updates baseline', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf('re-run test'));
    const ctx = makeCtx({ dir: tmpDir, pdfPath });

    await runStage('s0', ctx);

    expect(ctx.quality.baseline).not.toBeNull();
    expect(ctx.quality.baseline.composite_score).toBeGreaterThanOrEqual(0);
  });

  it('throws for unknown stage names', async () => {
    const ctx = makeCtx();
    await expect(runStage('s99', ctx)).rejects.toThrow('Unknown stage');
  });
});

describe('STAGES registry', () => {
  it('contains all 9 stage keys', () => {
    expect(Object.keys(STAGES)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
  });

  it('all stage values are functions', () => {
    for (const [name, fn] of Object.entries(STAGES)) {
      expect(typeof fn, `${name} should be a function`).toBe('function');
    }
  });
});
