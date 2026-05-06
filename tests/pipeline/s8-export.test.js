import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { s8Export } from '../../src/pipeline/stages/s8-export.js';
import { makeTempDir, makeTextPdf, makeCtx, makePageWords } from './helpers.js';

let tempDir, cleanup;

beforeEach(() => { ({ dir: tempDir, cleanup } = makeTempDir()); });
afterEach(() => cleanup());

describe('s8Export — contract', () => {
  it('writes ctx.outputs.mdPath', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [makePageWords(1, [{ text: 'Hello', x1: 10, y1: 10, x2: 60, y2: 25 }])];
    await s8Export(ctx);
    expect(ctx.outputs.mdPath).toBeTruthy();
  });

  it('records a stage entry', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [];
    await s8Export(ctx);
    const stage = ctx.metrics.stages.find(s => s.stage === 's8');
    expect(stage).toBeDefined();
    expect(stage.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns ctx for chaining', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    const result = await s8Export(ctx);
    expect(result).toBe(ctx);
  });
});

describe('s8Export — with bbox words', () => {
  it('writes a markdown file with page anchors', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [
      makePageWords(1, [
        { text: 'Hello', x1: 10, y1: 10, x2: 60, y2: 25 },
        { text: 'world', x1: 70, y1: 10, x2: 110, y2: 25 },
      ]),
      makePageWords(2, [
        { text: 'Second', x1: 10, y1: 10, x2: 70, y2: 25 },
        { text: 'page', x1: 80, y1: 10, x2: 120, y2: 25 },
      ]),
    ];
    await s8Export(ctx);
    const md = readFileSync(ctx.outputs.mdPath, 'utf8');
    expect(md).toContain('<!-- p.1 -->');
    expect(md).toContain('<!-- p.2 -->');
    expect(md).toContain('Hello');
    expect(md).toContain('Second');
  });

  it('uses archivalPdfPath for output location when set', async () => {
    const pdfPath = join(tempDir, 'orig.pdf');
    const archivePath = join(tempDir, 'archive.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    writeFileSync(archivePath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.outputs.archivalPdfPath = archivePath;
    ctx.pages = [makePageWords(1, [{ text: 'Test', x1: 10, y1: 10, x2: 50, y2: 25 }])];
    await s8Export(ctx);
    expect(ctx.outputs.mdPath).toBe(archivePath.replace(/\.pdf$/i, '.md'));
  });
});

describe('s8Export — no bbox words fallback', () => {
  it('writes stub with page anchors when pages have no words', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [{ pageNo: 1, words: [], regions: [], quality: {} },
                 { pageNo: 2, words: [], regions: [], quality: {} }];
    await s8Export(ctx);
    const md = readFileSync(ctx.outputs.mdPath, 'utf8');
    expect(md).toContain('<!-- p.1 -->');
    expect(md).toContain('<!-- p.2 -->');
    const notes = ctx.metrics.stages.find(s => s.stage === 's8')?.notes;
    expect(notes).toContain('no_words_from_s3');
  });

  it('writes empty-pages stub when ctx.pages is empty', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [];
    await s8Export(ctx);
    expect(existsSync(ctx.outputs.mdPath)).toBe(true);
  });
});

describe('s8Export — visionMd path', () => {
  it('uses page.visionMd instead of bbox words when visionMd is set', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [{
      pageNo: 1,
      visionMd: '# Title\n\nSome vision content here.',
      words: [{ text: 'ignored', conf: 95, x1: 0, y1: 0, x2: 50, y2: 10, source: 'ocr', pageNo: 1 }],
      regions: [], quality: {},
    }];
    await s8Export(ctx);
    const md = readFileSync(ctx.outputs.mdPath, 'utf8');
    expect(md).toContain('Some vision content here.');
    expect(md).not.toContain('ignored');
  });

  it('mixes vision and bbox pages correctly', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [
      { pageNo: 1, visionMd: 'Vision page one.', words: [], regions: [], quality: {} },
      makePageWords(2, [{ text: 'BboxWord', x1: 10, y1: 10, x2: 80, y2: 25 }]),
    ];
    await s8Export(ctx);
    const md = readFileSync(ctx.outputs.mdPath, 'utf8');
    expect(md).toContain('Vision page one.');
    expect(md).toContain('BboxWord');
    expect(md).toContain('<!-- p.1 -->');
    expect(md).toContain('<!-- p.2 -->');
  });

  it('records quality.perStage.s8 when pages have content', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath });
    ctx.pages = [makePageWords(1, [{ text: 'Hello', conf: 95, x1: 10, y1: 10, x2: 60, y2: 25 }])];
    await s8Export(ctx);
    expect(ctx.quality.perStage['s8']).toBeDefined();
    expect(ctx.quality.perStage['s8']).toBeGreaterThan(0);
  });
});

describe('s8Export — skip logic', () => {
  it('skips when shouldRun returns false', async () => {
    const pdfPath = join(tempDir, 'doc.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const ctx = makeCtx({ dir: tempDir, pdfPath, config: { skip: ['s8'] } });
    ctx.pages = [];
    await s8Export(ctx);
    expect(ctx.outputs.mdPath).toBeNull();
    expect(ctx.metrics.stages.find(s => s.stage === 's8')).toBeUndefined();
  });
});
