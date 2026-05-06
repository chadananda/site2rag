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

  it('decodes &#NNN; numeric entities', () => {
    // &#233; = é (latin small letter e with acute)
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 90'>caf&#233;</span>`;
    const words = parseHocr(hocr, 1);
    expect(words[0].text).toBe('café');
  });

  it('accepts ocr_word class (not just ocrx_word)', () => {
    const hocr = `<span class='ocr_word' id='w1' title='bbox 10 20 80 40; x_wconf 88'>Test</span>`;
    const words = parseHocr(hocr, 1);
    expect(words).toHaveLength(1);
    expect(words[0].text).toBe('Test');
    expect(words[0].conf).toBe(88);
  });

  it('assigns correct pageNo to each word', () => {
    const words = parseHocr(SAMPLE_HOCR, 7);
    expect(words.every(w => w.pageNo === 7)).toBe(true);
  });

  it('assigns source=tesseract to each word', () => {
    const words = parseHocr(SAMPLE_HOCR, 1);
    expect(words.every(w => w.source === 'tesseract')).toBe(true);
  });

  it('handles spans with nested markup (bold, italic) by stripping tags', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 90'><strong>bold</strong></span>`;
    const words = parseHocr(hocr, 1);
    expect(words[0].text).toBe('bold');
  });

  it('returns empty array for empty hOCR string', () => {
    expect(parseHocr('', 1)).toHaveLength(0);
  });
});

const HIGH_HOCR = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 95'>good</span>
<span class='ocrx_word' id='w2' title='bbox 60 0 120 20; x_wconf 92'>great</span>
<span class='ocrx_word' id='w3' title='bbox 130 0 180 20; x_wconf 91'>word</span>`;

describe('s3Ocr stage — contrast enhancement', () => {
  it('uses enhanced version when python3+tesseract improves clean ratio', async () => {
    // 3 calls: pdftoppm, tesseract(original=low), python3(enhance success), tesseract(enhanced=high)
    let callIdx = 0;
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callIdx++;
      if (_cmd === 'pdftoppm') {
        callback(null, { stdout: '', stderr: '' });
      } else if (_cmd === 'tesseract' && callIdx === 2) {
        // First tesseract: low-conf original
        callback(null, { stdout: `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 30'>bad</span>`, stderr: '' });
      } else if (_cmd === 'python3') {
        callback(null, { stdout: JSON.stringify({ enhanced: true, applied: ['clahe'] }), stderr: '' });
      } else if (_cmd === 'tesseract') {
        // Second tesseract: high-conf enhanced
        callback(null, { stdout: HIGH_HOCR, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx({ config: { preprocessing: { forceContrast: false } } });
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    // Enhanced words should have source 'tesseract+contrast'
    expect(ctx.pages[0].words.some(w => w.source === 'tesseract+contrast')).toBe(true);
    const dec = ctx.metrics.decisions.find(d => d.decision?.startsWith('contrast_p'));
    expect(dec).toBeDefined();
    expect(dec.reason).toContain('clahe');
  });

  it('keeps original when enhanced version does not improve clean ratio', async () => {
    let callIdx = 0;
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callIdx++;
      if (_cmd === 'pdftoppm') {
        callback(null, { stdout: '', stderr: '' });
      } else if (_cmd === 'python3') {
        callback(null, { stdout: JSON.stringify({ enhanced: true, applied: ['clahe'] }), stderr: '' });
      } else if (_cmd === 'tesseract') {
        // Both tesseract calls return same low-conf hOCR — enhanced doesn't help
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    // Should keep original source words (tesseract, not tesseract+contrast)
    const words = ctx.pages[0].words;
    expect(words.every(w => w.source === 'tesseract')).toBe(true);
    const dec = ctx.metrics.decisions.find(d => d.decision?.startsWith('contrast_p'));
    expect(dec).toBeDefined();
    expect(dec.reason).toContain('kept original');
  });

  it('passes --force flag to python3 when forceContrast=true', async () => {
    const capturedArgs = [];
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (_cmd === 'python3') {
        capturedArgs.push([..._args]);
        callback(null, { stdout: JSON.stringify({ enhanced: true, applied: ['clahe'] }), stderr: '' });
      } else if (_cmd === 'tesseract') {
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx({ config: { preprocessing: { forceContrast: true } } });
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    expect(capturedArgs.length).toBeGreaterThan(0);
    expect(capturedArgs[0]).toContain('--force');
  });

  it('passes --method to python3 when preprocessing.method is set', async () => {
    const capturedArgs = [];
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (_cmd === 'python3') {
        capturedArgs.push([..._args]);
        callback(null, { stdout: JSON.stringify({ enhanced: false }), stderr: '' });
      } else if (_cmd === 'tesseract') {
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx({ config: { preprocessing: { forceContrast: true, method: 'otsu' } } });
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    expect(capturedArgs[0]).toContain('--method');
    expect(capturedArgs[0]).toContain('otsu');
  });

  it('keeps original when python3 enhancement fails (returns { enhanced: false })', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (_cmd === 'python3') {
        callback(null, { stdout: JSON.stringify({ enhanced: false }), stderr: '' });
      } else if (_cmd === 'tesseract') {
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    // No contrast decision should be logged — enhancement not attempted
    const dec = ctx.metrics.decisions.find(d => d.decision?.startsWith('contrast_p'));
    expect(dec).toBeUndefined();
    // Words should be from original OCR
    expect(ctx.pages[0].words).toHaveLength(3);
  });

  it('keeps original when python3 throws (subprocess error)', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (_cmd === 'python3') {
        callback(new Error('python3 not found'), null);
      } else if (_cmd === 'tesseract') {
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    // No crash, original words kept
    expect(ctx.pages[0].words).toHaveLength(3);
    expect(ctx.metrics.errors.filter(e => e.stage === 's3')).toHaveLength(0);
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

  it('routes ISO 639-1 language code "fr" to fra', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.meta = { language: 'fr' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    const summary = JSON.parse(ctx.metrics.decisions.find(d => d.decision === 'routing_summary').reason);
    expect(summary.fra).toBe(1);
  });

  it('routes full language name "french" to fra', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.meta = { language: 'french' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    const summary = JSON.parse(ctx.metrics.decisions.find(d => d.decision === 'routing_summary').reason);
    expect(summary.fra).toBe(1);
  });

  it('falls back to eng when language is unknown', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.meta = { language: 'klingon' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    const summary = JSON.parse(ctx.metrics.decisions.find(d => d.decision === 'routing_summary').reason);
    expect(summary.eng).toBe(1);
  });

  it('routes printed_cjk region type to chi_sim+jpn', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [{ type: 'printed_cjk' }], quality: {} }];
    await s3Ocr(ctx);
    const summary = JSON.parse(ctx.metrics.decisions.find(d => d.decision === 'routing_summary').reason);
    expect(summary['chi_sim+jpn']).toBe(1);
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

  it('records quality.perStage.s3 when pages have words', async () => {
    mockExecFile();
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.3 });
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    expect(ctx.quality.perStage['s3']).toBeDefined();
    expect(ctx.quality.perStage['s3']).toBeGreaterThan(0);
  });

  it('does NOT record quality.perStage.s3 when no pages have words', async () => {
    // execFile always returns empty hOCR → no words
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback(null, { stdout: '', stderr: '' });
    });
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.3 });
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);
    expect(ctx.quality.perStage['s3']).toBeUndefined();
  });
});
