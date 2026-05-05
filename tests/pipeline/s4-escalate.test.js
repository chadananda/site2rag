import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCtx, makePageWords } from './helpers.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/pipeline/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, shouldRun: vi.fn(() => true) };
});

import { execFile } from 'child_process';
import { shouldRun } from '../../src/pipeline/config.js';
import { s4Escalate } from '../../src/pipeline/stages/s4-escalate.js';

const LOW_HOCR = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 20'>bad</span>
<span class='ocrx_word' id='w2' title='bbox 60 0 120 20; x_wconf 25'>worse</span>`;
const HIGH_HOCR = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 92'>good</span>
<span class='ocrx_word' id='w2' title='bbox 60 0 120 20; x_wconf 95'>great</span>`;

function mockExecFile(stdout) {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    callback(null, { stdout, stderr: '' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  shouldRun.mockReturnValue(true);
});

describe('s4Escalate stage', () => {
  it('skips pages with no dirty words', async () => {
    const ctx = makeCtx();
    ctx.pages = [makePageWords(1, [{ text: 'hello', conf: 95 }, { text: 'world', conf: 92 }])];
    await s4Escalate(ctx);
    expect(ctx.metrics.decisions.filter(d => d.stage === 's4')).toHaveLength(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('marks dirty words as needs_vision when 600 DPI does not improve', async () => {
    mockExecFile(LOW_HOCR); // low conf result — won't beat original by 5pts
    const ctx = makeCtx();
    ctx.pages = [{
      pageNo: 1, _lang: 'eng',
      words: [
        { text: 'clean', conf: 95, x1: 0, y1: 0, x2: 50, y2: 20, source: 'tesseract', pageNo: 1 },
        { text: 'dirty1', conf: 20, x1: 0, y1: 30, x2: 50, y2: 50, source: 'tesseract', pageNo: 1 },
        { text: 'dirty2', conf: 22, x1: 0, y1: 60, x2: 50, y2: 80, source: 'tesseract', pageNo: 1 },
        { text: 'dirty3', conf: 18, x1: 0, y1: 90, x2: 50, y2: 110, source: 'tesseract', pageNo: 1 },
      ],
      regions: [], quality: {},
      _bucketed: { clean: 1, fuzzy: 0, dirty: 3, needs_vision: 0 },
    }];
    await s4Escalate(ctx);
    const dirtyWords = ctx.pages[0].words.filter(w => w.conf < 40);
    expect(dirtyWords.every(w => w.needs_vision === true)).toBe(true);
  });

  it('replaces words when 600 DPI improves confidence significantly', async () => {
    // pdftoppm succeeds then tesseract returns high-conf hOCR
    let call = 0;
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      call++;
      if (call === 1) callback(null, { stdout: '', stderr: '' }); // pdftoppm
      else callback(null, { stdout: HIGH_HOCR, stderr: '' }); // tesseract
    });
    const ctx = makeCtx();
    ctx.pages = [{
      pageNo: 1, _lang: 'eng',
      words: [
        { text: 'bad1', conf: 15, x1: 0, y1: 0, x2: 50, y2: 20, source: 'tesseract', pageNo: 1 },
        { text: 'bad2', conf: 18, x1: 0, y1: 30, x2: 50, y2: 50, source: 'tesseract', pageNo: 1 },
        { text: 'bad3', conf: 20, x1: 0, y1: 60, x2: 50, y2: 80, source: 'tesseract', pageNo: 1 },
      ],
      regions: [], quality: {},
      _bucketed: { clean: 0, fuzzy: 0, dirty: 3, needs_vision: 0 },
    }];
    await s4Escalate(ctx);
    // HIGH_HOCR returns conf 92 and 95 → mean ~93 vs old mean ~17
    expect(ctx.pages[0].words[0].conf).toBe(92);
    const dec = ctx.metrics.decisions.find(d => d.stage === 's4');
    expect(dec?.reason).toBe('replaced-600dpi');
  });

  it('sets page._needsFullVision when words is empty', async () => {
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, _lang: 'eng', words: [], regions: [], quality: {},
      _bucketed: { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 } }];
    await s4Escalate(ctx);
    expect(ctx.pages[0]._needsFullVision).toBe(true);
  });

  it('per-page error is recoverable and dirty words get needs_vision from catch', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback(new Error('pdftoppm crashed'), null);
    });
    const ctx = makeCtx();
    ctx.pages = [{
      pageNo: 1, _lang: 'eng',
      words: [
        { text: 'bad', conf: 15, x1: 0, y1: 0, x2: 50, y2: 20, source: 'tesseract', pageNo: 1 },
        { text: 'bad2', conf: 20, x1: 0, y1: 30, x2: 50, y2: 50, source: 'tesseract', pageNo: 1 },
        { text: 'bad3', conf: 25, x1: 0, y1: 60, x2: 50, y2: 80, source: 'tesseract', pageNo: 1 },
      ],
      regions: [], quality: {},
      _bucketed: { clean: 0, fuzzy: 0, dirty: 3, needs_vision: 0 },
    }];
    await s4Escalate(ctx);
    expect(ctx.metrics.errors.some(e => e.stage === 's4' && e.recoverable)).toBe(true);
    const dirtyWords = ctx.pages[0].words.filter(w => w.conf < 40);
    expect(dirtyWords.every(w => w.needs_vision === true)).toBe(true);
  });

  it('skips when shouldRun returns false', async () => {
    shouldRun.mockReturnValue(false);
    const ctx = makeCtx();
    ctx.pages = [makePageWords(1, [{ text: 'bad', conf: 15 }])];
    await s4Escalate(ctx);
    expect(execFile).not.toHaveBeenCalled();
    expect(ctx.metrics.stages).toHaveLength(0);
  });
});
