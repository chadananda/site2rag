import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'fs';
import { makeCtx } from './helpers.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/pipeline/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, shouldRun: vi.fn(() => true) };
});

import { execFile } from 'child_process';
import { shouldRun } from '../../src/pipeline/config.js';
import { s3Ocr, parseHocr, repairHyphens, resolveLang, cleanRatio } from '../../src/pipeline/stages/s3-ocr.js';

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

// hOCR with one full-page ocr_carea block — returned by Tesseract layout pass (--psm 1)
const LAYOUT_HOCR = `<html><body>
<div class='ocr_page' title='bbox 0 0 612 792'>
<div class='ocr_carea' title='bbox 10 10 600 780'>
<span class='ocr_line'><span class='ocrx_word' title='bbox 10 10 50 30; x_wconf 95'>block</span></span>
</div></div></body></html>`;

/** Wrap execFile to call callback-style with (err, result).
 *  pdftoppm writes a 200-byte fake PNG so existsSync/statSync checks pass.
 *  convert -crop writes a fake crop PNG so the block crop pipeline can proceed.
 *  Tesseract --psm 1 (layout pass) returns LAYOUT_HOCR so block detection succeeds.
 *  All other Tesseract calls return ocrStdout. python3 returns empty. */
function mockExecFile(ocrStdout = SAMPLE_HOCR) {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (_cmd === 'pdftoppm') {
      const outBase = _args[_args.length - 1];
      try { writeFileSync(`${outBase}.png`, Buffer.alloc(200, 0)); } catch {}
      callback(null, { stdout: '', stderr: '' });
    } else if (_cmd === 'convert' && _args.includes('-crop')) {
      // Write the output crop file so existsSync check in s3 passes
      const outPath = _args[_args.length - 1];
      try { writeFileSync(outPath, Buffer.alloc(200, 0)); } catch {}
      callback(null, { stdout: '', stderr: '' });
    } else if (_cmd === 'tesseract' && Array.isArray(_args) && _args.includes('--psm')) {
      callback(null, { stdout: LAYOUT_HOCR, stderr: '' });
    } else if (_cmd === 'tesseract') {
      callback(null, { stdout: ocrStdout, stderr: '' });
    } else {
      callback(null, { stdout: '', stderr: '' });
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  shouldRun.mockReturnValue(true);
});

// tests: word parsing, HTML entity decode, conf values, empty spans, numeric entities, ocr_word class, pageNo, source field, nested markup, empty string
describe('parseHocr', () => {
  it('parses two ocrx_word spans correctly', () => {
    const words = parseHocr(SAMPLE_HOCR, 1);
    expect(words).toHaveLength(3);
    expect(words[0]).toMatchObject({ text: 'Hello ', x1: 10, y1: 20, x2: 80, y2: 40, conf: 95 });
    expect(words[1]).toMatchObject({ text: 'world ', x1: 90, y1: 20, x2: 160, y2: 40, conf: 72 });
  });

  it('decodes HTML entities', () => {
    const words = parseHocr(SAMPLE_HOCR, 1);
    expect(words[2].text).toBe('fuzzy&dirty ');
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
    expect(words[0].text).toBe('café ');
  });

  it('accepts ocr_word class (not just ocrx_word)', () => {
    const hocr = `<span class='ocr_word' id='w1' title='bbox 10 20 80 40; x_wconf 88'>Test</span>`;
    const words = parseHocr(hocr, 1);
    expect(words).toHaveLength(1);
    expect(words[0].text).toBe('Test ');
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
    expect(words[0].text).toBe('bold ');
  });

  it('returns empty array for empty hOCR string', () => {
    expect(parseHocr('', 1)).toHaveLength(0);
  });
});

// tests: trailing space appended, hyphen join, min-conf of joined pair, no-join single-char, empty array
describe('repairHyphens', () => {
  const w = (text, conf = 90, x2 = 100) => ({ text, conf, x1: 0, y1: 0, x2, y2: 20, source: 'tesseract', pageNo: 1 });

  it('appends trailing space to every word', () => {
    const result = repairHyphens([w('hello'), w('world')]);
    expect(result[0].text).toBe('hello ');
    expect(result[1].text).toBe('world ');
  });

  it('joins line-break hyphen with next word', () => {
    const result = repairHyphens([w('deter-'), w('mined')]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('determined ');
  });

  it('uses lower conf for joined word', () => {
    const result = repairHyphens([w('deter-', 95), w('mined', 70)]);
    expect(result[0].conf).toBe(70);
  });

  it('does not join single-char fragments', () => {
    const result = repairHyphens([w('a-'), w('b')]);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('a- ');
  });

  it('returns empty array unchanged', () => {
    expect(repairHyphens([])).toHaveLength(0);
  });
});

const HIGH_HOCR = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 95'>good</span>
<span class='ocrx_word' id='w2' title='bbox 60 0 120 20; x_wconf 92'>great</span>
<span class='ocrx_word' id='w3' title='bbox 130 0 180 20; x_wconf 91'>word</span>`;

// tests: uses enhanced when improves ratio, keeps original when no improvement, --force flag, --method flag, enhanced:false kept original, python3 throw kept original
describe('s3Ocr stage — no blocks found escalation', () => {
  // When all block detection methods fail (no usable blocks), s3 must NOT silently fall
  // back to full-page single-block Tesseract. That hides missing deps and produces poor output.
  // Instead: mark page for s4 escalation with a full-page _escalateBlocks entry.

  it('escalates to s4 when block detection finds no blocks', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (_cmd === 'pdftoppm') {
        callback(null, { stdout: '', stderr: '' });
      } else if (_cmd === 'tesseract') {
        // Layout pass returns no ocr_carea blocks; OCR pass returns words
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else if (_cmd === 'python3') {
        // detect_columns returns empty — no geometric columns found
        callback(null, { stdout: '[]', stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    // No words — block OCR never ran
    expect(ctx.pages[0].words).toEqual([]);
    // Full-page escalation block set for s4
    expect(ctx.pages[0]._escalateBlocks).toHaveLength(1);
    expect(ctx.pages[0]._escalateBlocks[0].fullPage).toBe(true);
    // needs_vision flag set
    expect(ctx.pages[0]._bucketed.needs_vision).toBe(1);
    // Error logged (recoverable)
    const err = ctx.metrics.errors.find(e => e.stage === 's3');
    expect(err).toBeDefined();
    expect(err.recoverable).toBe(true);
  });

  it('escalates to s4 when detect_columns.py throws (missing dep)', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (_cmd === 'pdftoppm') {
        callback(null, { stdout: '', stderr: '' });
      } else if (_cmd === 'tesseract') {
        callback(null, { stdout: SAMPLE_HOCR, stderr: '' });
      } else if (_cmd === 'python3') {
        callback(new Error('ModuleNotFoundError: No module named numpy'), null);
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s3Ocr(ctx);

    expect(ctx.pages[0].words).toEqual([]);
    expect(ctx.pages[0]._escalateBlocks).toHaveLength(1);
    expect(ctx.pages[0]._escalateBlocks[0].fullPage).toBe(true);
  });
});

// tests: skip when shouldRun false, endStage on empty pages, recoverable page error, ISO lang routing, full-name lang routing, unknown lang fallback, cjk region routing, arabic region routing, word buckets, quality.perStage.s3, no quality when no words
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

// tests: arabic region, persian region, cjk region, region priority over metaLang, full-name lookup, case-insensitive, ISO 639-1 lookup, null/null→eng, unknown→eng, unknown region→eng
describe('resolveLang', () => {
  it('returns "ara" for printed_arabic region type', () => {
    expect(resolveLang('printed_arabic', null)).toBe('ara');
  });

  it('returns "fas" for printed_persian region type', () => {
    expect(resolveLang('printed_persian', null)).toBe('fas');
  });

  it('returns "chi_sim+jpn" for printed_cjk region type', () => {
    expect(resolveLang('printed_cjk', null)).toBe('chi_sim+jpn');
  });

  it('region type takes priority over metaLang', () => {
    expect(resolveLang('printed_arabic', 'persian')).toBe('ara');
  });

  it('returns TESS_LANG lookup for known metaLang string', () => {
    expect(resolveLang(null, 'arabic')).toBe('ara');
    expect(resolveLang(null, 'persian')).toBe('fas');
    expect(resolveLang(null, 'french')).toBe('fra');
    expect(resolveLang(null, 'german')).toBe('deu');
    expect(resolveLang(null, 'russian')).toBe('rus');
    expect(resolveLang(null, 'japanese')).toBe('jpn');
  });

  it('is case-insensitive for metaLang', () => {
    expect(resolveLang(null, 'French')).toBe('fra');
    expect(resolveLang(null, 'ARABIC')).toBe('ara');
  });

  it('returns ISO code lookup when metaLang is ISO 639-1', () => {
    expect(resolveLang(null, 'fr')).toBe('fra');
    expect(resolveLang(null, 'de')).toBe('deu');
    expect(resolveLang(null, 'ar')).toBe('ara');
    expect(resolveLang(null, 'zh')).toBe('chi_sim');
  });

  it('returns "eng" for null region type and null metaLang', () => {
    expect(resolveLang(null, null)).toBe('eng');
  });

  it('returns "eng" for unknown metaLang string', () => {
    expect(resolveLang(null, 'klingon')).toBe('eng');
  });

  it('returns "eng" for unknown region type', () => {
    expect(resolveLang('handwritten_latin', null)).toBe('eng');
  });
});

// tests: empty array→0, all clean→1, none clean→0, partial fraction, conf exactly at threshold
describe('cleanRatio', () => {
  it('returns 0 for empty array', () => {
    expect(cleanRatio([], 90)).toBe(0);
  });

  it('returns 1 when all words meet threshold', () => {
    const words = [{ conf: 95 }, { conf: 92 }, { conf: 100 }];
    expect(cleanRatio(words, 90)).toBe(1);
  });

  it('returns 0 when no words meet threshold', () => {
    const words = [{ conf: 50 }, { conf: 60 }, { conf: 70 }];
    expect(cleanRatio(words, 90)).toBe(0);
  });

  it('returns correct fraction for partial match', () => {
    const words = [{ conf: 95 }, { conf: 80 }, { conf: 55 }, { conf: 91 }];
    expect(cleanRatio(words, 90)).toBeCloseTo(0.5, 5);
  });

  it('treats conf exactly at threshold as clean', () => {
    const words = [{ conf: 90 }, { conf: 89 }];
    expect(cleanRatio(words, 90)).toBeCloseTo(0.5, 5);
  });
});
