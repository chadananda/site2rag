// Tests for s7Archive stage — PDF rebuild via rebuildPdf.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCtx } from './helpers.js';

vi.mock('../../src/pipeline/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, shouldRun: vi.fn(() => true) };
});
vi.mock('../../src/pdf-upgrade/rebuild.js', () => ({
  rebuildPdf: vi.fn(),
}));

import { shouldRun } from '../../src/pipeline/config.js';
import { rebuildPdf } from '../../src/pdf-upgrade/rebuild.js';
import { s7Archive } from '../../src/pipeline/stages/s7-archive.js';

beforeEach(() => {
  vi.clearAllMocks();
  shouldRun.mockReturnValue(true);
  rebuildPdf.mockResolvedValue({ success: true, method: 'ocrmypdf-pdfa3' });
});

describe('s7Archive stage', () => {
  it('skips when shouldRun returns false', async () => {
    shouldRun.mockReturnValue(false);
    const ctx = makeCtx();
    ctx.pages = [];
    await s7Archive(ctx);
    expect(ctx.metrics.stages).toHaveLength(0);
    expect(rebuildPdf).not.toHaveBeenCalled();
  });

  it('records s7 stage entry', async () => {
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/test.pdf';
    ctx.pages = [];
    await s7Archive(ctx);
    const stage = ctx.metrics.stages.find(s => s.stage === 's7');
    expect(stage).toBeDefined();
  });

  it('calls rebuildPdf with sourcePath and _archival output path', async () => {
    const ctx = makeCtx();
    ctx.sourcePath = '/tank/site2rag/docs/myfile.pdf';
    ctx.pages = [];
    await s7Archive(ctx);
    expect(rebuildPdf).toHaveBeenCalledWith(
      '/tank/site2rag/docs/myfile.pdf',
      '/tank/site2rag/docs/myfile_archival.pdf',
      null,
      expect.any(Object)
    );
  });

  it('sets ctx.outputs.archivalPdfPath on success', async () => {
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.pages = [];
    await s7Archive(ctx);
    expect(ctx.outputs.archivalPdfPath).toBe('/tmp/doc_archival.pdf');
  });

  it('passes meta title and author to rebuildPdf', async () => {
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.meta = { title: 'My Book', authors: ['Alice', 'Bob'], description: 'A story', language: 'fr' };
    ctx.pages = [];
    await s7Archive(ctx);
    const meta = rebuildPdf.mock.calls[0][3];
    expect(meta.title).toBe('My Book');
    expect(meta.author).toBe('Alice, Bob');
    expect(meta.subject).toBe('A story');
    expect(meta.keywords).toBe('fr');
  });

  it('passes single author string when authors is not an array', async () => {
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.meta = { authors: 'Single Author' };
    ctx.pages = [];
    await s7Archive(ctx);
    const meta = rebuildPdf.mock.calls[0][3];
    expect(meta.author).toBe('Single Author');
  });

  it('adds recoverable error and no archivalPdfPath when rebuildPdf returns failure', async () => {
    rebuildPdf.mockResolvedValue({ success: false, error: 'ocrmypdf not found' });
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.pages = [];
    await s7Archive(ctx);
    expect(ctx.outputs.archivalPdfPath).toBeNull();
    expect(ctx.metrics.errors.some(e => e.stage === 's7')).toBe(true);
  });

  it('adds recoverable error when rebuildPdf throws', async () => {
    rebuildPdf.mockRejectedValue(new Error('subprocess crashed'));
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.pages = [];
    await s7Archive(ctx);
    expect(ctx.metrics.errors.some(e => e.stage === 's7')).toBe(true);
    expect(ctx.outputs.archivalPdfPath).toBeNull();
  });

  it('throws when failFast=true and rebuild throws', async () => {
    rebuildPdf.mockRejectedValue(new Error('fatal'));
    const ctx = makeCtx({ config: { failFast: true } });
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.pages = [];
    await expect(s7Archive(ctx)).rejects.toThrow('fatal');
  });

  it('adds error (not throw) when sourcePath is missing', async () => {
    const ctx = makeCtx();
    ctx.sourcePath = null;
    ctx.pages = [];
    await expect(s7Archive(ctx)).resolves.not.toThrow();
    expect(ctx.metrics.errors.some(e => e.stage === 's7')).toBe(true);
  });

  it('records method in decision log on success', async () => {
    rebuildPdf.mockResolvedValue({ success: true, method: 'pdf-lib-overlay' });
    const ctx = makeCtx();
    ctx.sourcePath = '/tmp/doc.pdf';
    ctx.pages = [];
    await s7Archive(ctx);
    const dec = ctx.metrics.decisions.find(d => d.stage === 's7' && d.decision === 'rebuilt');
    expect(dec).toBeDefined();
    expect(dec.reason).toContain('pdf-lib-overlay');
  });
});
