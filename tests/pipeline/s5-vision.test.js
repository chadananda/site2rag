import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { makeTempDir, makeCtx } from './helpers.js';

const makeVisionPage = (pageNo, lang = 'eng') => ({
  pageNo, words: [], regions: [{ type: 'printed_latin', bbox: null }],
  _needsFullVision: true, _lang: lang,
  _bucketed: { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 }, quality: {},
});

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let tempDir, cleanup;

beforeEach(() => { ({ dir: tempDir, cleanup } = makeTempDir()); vi.unstubAllGlobals(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const makePageWithPng = (pageNo, lang = 'eng') => {
  const page = makeVisionPage(pageNo, lang);
  page._pngPath = join(tempDir, `page-${pageNo}.png`);
  writeFileSync(page._pngPath, TINY_PNG);
  return page;
};

// Helper: mock execFileAsync to simulate surya_ocr CLI
// surya_ocr --help exits non-zero but code !== 'ENOENT' → available
// surya_ocr <dir> ... → writes results.json to outDir
const mockSuryaUnavailable = () => {
  vi.mock('child_process', async (orig) => {
    const real = await orig();
    return {
      ...real,
      execFile: (cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'surya_ocr') {
          const err = new Error('not found'); err.code = 'ENOENT';
          callback(err);
        } else real.execFile(cmd, args, opts, cb);
      },
    };
  });
};

describe('s5Vision — skip logic', () => {
  it('skips when shouldRun returns false', async () => {
    const ctx = makeCtx({ config: { skip: ['s5'] } });
    ctx.pages = [makeVisionPage(1)];
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.metrics.stages.find(s => s.stage === 's5')).toBeUndefined();
    expect(ctx.pages[0].visionMd).toBeUndefined();
  });

  it('skips all pages when surya unavailable and no HTTP backends', async () => {
    // surya not available, boss unreachable, no API keys
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null } });
    ctx.pages = [makeVisionPage(1)];
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toBeUndefined();
    expect(ctx.metrics.stages.find(s => s.stage === 's5')).toBeDefined();
  });
});

describe('s5Vision — surya batch pre-pass', () => {
  it('uses surya results when CLI is available', async () => {
    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null } });
    ctx.pages = [makePageWithPng(1)];
    // Mock ctx.run directly: surya --help succeeds (non-ENOENT = installed),
    // surya batch writes results.json; other tools pass through.
    const { existsSync: fsExists, writeFileSync: wfs, mkdirSync: mds } = await import('fs');
    const { join: pjoin } = await import('path');
    ctx.run = vi.fn(async (tool, args, opts) => {
      if (tool === 'surya_ocr') {
        if (args[0] === '--help') throw new Error('usage'); // installed but exits non-zero
        // new API: surya_ocr <inDir> --output_dir <outDir>; results at outDir/basename(inDir)/results.json
        const inDir = args[0];
        const outDir = args[args.indexOf('--output_dir') + 1];
        const { basename: pb } = await import('path');
        const resultDir = pjoin(outDir, pb(inDir));
        mds(resultDir, { recursive: true });
        const results = { 'page-0001': [{ text_lines: [{ text: 'Surya OCR transcription of the document page' }] }] };
        wfs(pjoin(resultDir, 'results.json'), JSON.stringify(results));
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toBe('Surya OCR transcription of the document page');
  });

  it('chunks large documents into SURYA_CHUNK_SIZE batches', async () => {
    const { writeFileSync: wfs2, mkdirSync: mds2, readdirSync: rds2 } = await import('fs');
    const { join: pjoin2 } = await import('path');
    const batchCalls = [];
    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null } });
    ctx.pages = Array.from({ length: 25 }, (_, i) => makePageWithPng(i + 1));
    ctx.run = vi.fn(async (tool, args) => {
      if (tool === 'surya_ocr') {
        if (args[0] === '--help') throw new Error('usage'); // installed
        batchCalls.push(args);
        // new API: surya_ocr <inDir> --output_dir <outDir>; results at outDir/basename(inDir)/
        const chunkDir = args[0];
        const outDir = args[args.indexOf('--output_dir') + 1];
        const { basename: pb } = await import('path');
        const resultDir = pjoin2(outDir, pb(chunkDir));
        mds2(resultDir, { recursive: true });
        const files = rds2(chunkDir).filter(f => f.endsWith('.png'));
        const results = Object.fromEntries(files.map(f => [f, [{ text_lines: [{ text: `text-${f}-long-enough-result` }] }]]));
        wfs2(pjoin2(resultDir, 'results.json'), JSON.stringify(results));
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    // Should produce 2 surya_ocr batch calls (25 pages / SURYA_CHUNK_SIZE=20 = 2 chunks)
    expect(batchCalls.length).toBe(2);
  });

  it('falls back to HTTP chain when surya CLI not found', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })   // boss health
      .mockResolvedValueOnce({ ok: true, json: async () => ({                  // boss ocr
        choices: [{ message: { content: 'Boss text' } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      })}));

    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null, toolBackends: {} } });
    ctx.pages = [makePageWithPng(1)];
    // Mock ctx.run: surya ENOENT = not installed; Python engines available (--check ok) but produce no output
    ctx.run = vi.fn(async (tool, args) => {
      if (tool === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
      if (args?.[0] === '--check') return { stdout: 'ok', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toBe('Boss text');
  });
});

describe('s5Vision — HTTP backend chain', () => {
  it('sets visionMd from boss when surya unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })   // boss health
      .mockResolvedValueOnce({ ok: true, json: async () => ({                  // boss ocr
        choices: [{ message: { content: 'Boss OCR result' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      })}));
    const ctx = makeCtx({ config: { apiKey: null, toolBackends: {} } });
    ctx.pages = [makePageWithPng(1)];
    ctx.run = vi.fn(async (tool, args) => {
      if (tool === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
      if (args?.[0] === '--check') return { stdout: 'ok', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toContain('Boss OCR result');
  });

  it('falls through boss to azure on boss failure', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })   // boss health ok
      .mockResolvedValueOnce({ ok: false, status: 500 })                       // boss call fails
      .mockResolvedValueOnce({ ok: true,                                       // azure start
        headers: { get: (h) => h === 'Operation-Location' ? 'https://azure.test/op/1' : null } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({                  // azure poll
        status: 'succeeded', analyzeResult: { content: 'Azure text' },
      })}));
    vi.useFakeTimers();
    const ctx = makeCtx({ importance: 3, config: {
      apiKey: null, azureKey: 'key', azureEndpoint: 'https://azure.test', googleKey: null,
      toolBackends: {},
      implementations: { vision: ['boss', 'azure'] } } });
    ctx.pages = [makePageWithPng(1)];
    ctx.run = vi.fn(async (tool, args) => {
      if (tool === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
      if (args?.[0] === '--check') return { stdout: 'ok', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    const p = s5Vision(ctx);
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(ctx.pages[0].visionMd).toBe('Azure text');
  });

  it('calls google with correct language hint', async () => {
    // Arabic page: boss is skipped (RTL_LANGS), so first fetch is google directly
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        responses: [{ fullTextAnnotation: { text: 'Google Arabic text' } }],
      })}));
    const ctx = makeCtx({ importance: 3, config: {
      apiKey: null, azureKey: null, googleKey: 'goog-key',
      escalation: { cloudVision: 3 },
      toolBackends: {},
      implementations: { vision: ['boss', 'google'] } } });
    ctx.pages = [makePageWithPng(1, 'ara')];
    ctx.run = vi.fn(async (tool, args) => {
      if (tool === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
      if (args?.[0] === '--check') return { stdout: 'ok', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toBe('Google Arabic text');
  });
});

describe('s5Vision — page filtering', () => {
  it('skips clean pages that do not need vision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; callback(e); return; }
      callback(null, '', '');
    });
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.pages = [{
      pageNo: 1, words: [{ text: 'Hello', conf: 95, x1: 0, y1: 0, x2: 50, y2: 20 }],
      regions: [], _needsFullVision: false, _lang: 'eng',
      _bucketed: { clean: 1, fuzzy: 0, dirty: 0 }, quality: {},
    }];
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toBeUndefined();
  });
});

describe('s5Vision — stage record', () => {
  it('records a stage entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; callback(e); return; }
      callback(null, '', '');
    });
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.pages = [];
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    const stage = ctx.metrics.stages.find(s => s.stage === 's5');
    expect(stage).toBeDefined();
    expect(stage.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── shouldVisionPage unit tests ───────────────────────────────────────────────

describe('shouldVisionPage', () => {
  let shouldVisionPage;
  beforeEach(async () => {
    vi.resetModules();
    ({ shouldVisionPage } = await import('../../src/pipeline/stages/s5-vision.js'));
  });

  const makePage = (overrides = {}) => ({
    pageNo: 1,
    words: [],
    regions: [],
    _bucketed: { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 },
    _needsFullVision: false,
    ...overrides,
  });

  it('returns shouldVision=true when _needsFullVision is true', () => {
    const page = makePage({ _needsFullVision: true });
    expect(shouldVisionPage(page).shouldVision).toBe(true);
    expect(shouldVisionPage(page).needsFull).toBe(true);
  });

  it('returns shouldVision=true when page has no words and non-figure region', () => {
    const page = makePage({
      words: [],
      regions: [{ type: 'printed_arabic' }],
    });
    expect(shouldVisionPage(page).shouldVision).toBe(true);
    expect(shouldVisionPage(page).needsFull).toBe(true);
  });

  it('returns shouldVision=false when page has no words but all regions are figures', () => {
    const page = makePage({
      words: [],
      regions: [{ type: 'figure' }],
    });
    expect(shouldVisionPage(page).shouldVision).toBe(false);
  });

  it('returns shouldVision=true when dirty words > 50% of total', () => {
    const words = [
      { text: 'a', conf: 20, needs_vision: false },
      { text: 'b', conf: 20, needs_vision: false },
      { text: 'c', conf: 20, needs_vision: false },
      { text: 'd', conf: 95, needs_vision: false },
    ];
    const page = makePage({ words, _bucketed: { dirty: 3, clean: 1, fuzzy: 0, needs_vision: 0 } });
    expect(shouldVisionPage(page).shouldVision).toBe(true);
  });

  it('returns shouldVision=true when dirty <= 50% but quality below 0.90 threshold', () => {
    // 1 dirty out of 4 = 25% dirty (not high-dirty), but 3/4 = 0.75 quality < 0.90 → belowThreshold
    const words = Array.from({ length: 4 }, () => ({ text: 'w', conf: 95, needs_vision: false }));
    words[0].conf = 20; // 1 dirty out of 4
    const page = makePage({ words, _bucketed: { dirty: 1, clean: 3, fuzzy: 0, needs_vision: 0 } });
    expect(shouldVisionPage(page).shouldVision).toBe(true);
  });

  it('returns shouldVision=true when >10 words need vision', () => {
    const words = Array.from({ length: 11 }, () => ({ text: 'w', conf: 30, needs_vision: true }));
    const page = makePage({ words, _bucketed: { dirty: 0, clean: 0, fuzzy: 0, needs_vision: 11 } });
    expect(shouldVisionPage(page).shouldVision).toBe(true);
  });

  it('returns shouldVision=true when exactly 10 words need vision (belowThreshold)', () => {
    // 10 words all conf=30 (below 60) → quality=0 < 0.90 → belowThreshold triggers vision
    const words = Array.from({ length: 10 }, () => ({ text: 'w', conf: 30, needs_vision: true }));
    const page = makePage({ words, _bucketed: { dirty: 0, clean: 0, fuzzy: 0, needs_vision: 10 } });
    expect(shouldVisionPage(page).shouldVision).toBe(true);
  });

  it('returns needsFull=false when _needsFullVision is false and words present', () => {
    const words = Array.from({ length: 20 }, () => ({ text: 'w', conf: 95, needs_vision: false }));
    const page = makePage({ words, _bucketed: { dirty: 15, clean: 5, fuzzy: 0, needs_vision: 0 } });
    // dirty/total = 0.75 > 0.5 → shouldVision=true, but needsFull=false (not _needsFullVision)
    const result = shouldVisionPage(page);
    expect(result.shouldVision).toBe(true);
    expect(result.needsFull).toBe(false);
  });
});
