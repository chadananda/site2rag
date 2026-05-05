import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCtx } from './helpers.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/pipeline/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, shouldRun: vi.fn(() => true) };
});

import { execFile } from 'child_process';
import { shouldRun } from '../../src/pipeline/config.js';
import { s3Ocr, parseHocr } from '../../src/pipeline/stages/s3-ocr.js';

const SAMPLE_HOCR = `<html><body>
<div class='ocr_page'>
<span class='ocr_line'>
<span class='ocrx_word' id='w1' title='bbox 10 20 80 40; x_wconf 95'>Hello</span>
<span class='ocrx_word' id='w2' title='bbox 90 20 160 40; x_wconf 72'>world</span>
</span>
<span class='ocr_line'>
<span class='ocrx_word' id='w3' title='bbox 10 60 90 80; x_wconf 38'>fuzzy&amp;dirty</span>
</span>
</div></body></html>`;

/** Wrap execFile to call callback-style with (err, result) */
function mockExecFile(stdout = SAMPLE_HOCR) {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    // vitest promisify passes opts as 3rd arg and cb as 4th
    const callback = typeof _opts === 'function' ? _opts : cb;
    callback(null, { stdout, stderr: '' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  shouldRun.mockReturnValue(true);
});

describe('parseHocr', () => {
  it('parses two ocrx_word spans correctly', () => {
    const words = parseHocr(SAMPLE_HOCR, 1);
    expect(words).toHaveLength(3);
    expect(words[0]).toMatchObject({ text: 'Hello', x1: 10, y1: 20, x2: 80, y2: 40, conf: 95 });
    expect(words[1]).toMatchObject({ text: 'world', x1: 90, y1: 20, x2: 160, y2: 40, conf: 72 });
  });

  it('decodes HTML entities', () => {
    const words = parseHocr(SAMPLE_HOCR, 1);
    expect(words[2].text).toBe('fuzzy&dirty');
  });

  it('includes conf values', () => {
    const words = parseHocr(SAMPLE_HOCR, 1);
    expect(words[0].conf).toBe(95);
    expect(words[1].conf).toBe(72);
    expect(words[2].conf).toBe(38);
  });

  it('skips empty text spans', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 0 0 10 10; x_wconf 90'>  </span>`;
    const words = parseHocr(hocr, 1);
    expect(words).toHaveLength(0);
  });
});

describe('s3Ocr stage', () => {
  it('skips when shouldRun returns false', async () => {
    shouldRun.mockReturnValue(false);
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], words: [], quality: {} }];
    await s3Ocr(ctx);
    expect(ctx.metrics.stages).toHaveLength(0);
  });

  it('calls endStage even with empty pages array', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.pages = [];
    await s3Ocr(ctx);
    const stage = ctx.metrics.stages.find(s => s.stage === 's3');
    expect(stage).toBeDefined();
  });

  it('per-page error is recoverable and page gets empty words', async () => {
    // First call (pdftoppm page 1) succeeds, second call (tesseract page 1) fails
    let callCount = 0;
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callCount++;
      if (callCount <= 1) callback(null, { stdout: '', stderr: '' }); // pdftoppm
      else callback(new Error('tesseract failed'), null);
    });
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    expect(ctx.pages[0].words).toEqual([]);
    expect(ctx.metrics.errors.some(e => e.stage === 's3' && e.recoverable)).toBe(true);
    const stage = ctx.metrics.stages.find(s => s.stage === 's3');
    expect(stage).toBeDefined();
  });

  it('routes printed_arabic region type to ara lang', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [{ type: 'printed_arabic' }], quality: {} }];
    await s3Ocr(ctx);
    // Check addDecision routing_summary contains ara
    const dec = ctx.metrics.decisions.find(d => d.decision === 'routing_summary');
    expect(dec).toBeDefined();
    const summary = JSON.parse(dec.reason);
    expect(summary.ara).toBe(1);
  });

  it('produces correct word buckets from sample hOCR', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    // SAMPLE_HOCR has conf 95 (clean), 72 (fuzzy), 38 (dirty) with defaults 90/60/40
    expect(ctx.pages[0]._bucketed.clean).toBe(1);
    expect(ctx.pages[0]._bucketed.fuzzy).toBe(1);
    expect(ctx.pages[0]._bucketed.dirty).toBe(1);
  });
});
