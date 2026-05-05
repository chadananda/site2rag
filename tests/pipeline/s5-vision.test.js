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
    // Mock execFile: surya_ocr --help exits with error (but code ≠ ENOENT = installed)
    // surya_ocr <dir> writes results.json
    const { execFile: realExecFile } = await import('child_process');
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd !== 'surya_ocr') return realExecFile(cmd, args, opts, cb);
      if (args[0] === '--help') { callback(new Error('usage')); return; } // installed, exits non-zero
      // surya_ocr <chunkDir> --langs en --results_dir <outDir>
      const outDir = args[args.indexOf('--results_dir') + 1];
      const { writeFileSync: wfs, mkdirSync: mds } = require('fs');
      mds(outDir, { recursive: true });
      // Keys are stems without extension (matches surya 0.6.x directory-input format)
      const results = { 'page-0001': [{ text_lines: [{ text: 'Surya OCR text' }] }] };
      wfs(require('path').join(outDir, 'results.json'), JSON.stringify(results));
      callback(null, '', '');
    });

    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null } });
    ctx.pages = [makePageWithPng(1)];
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    expect(ctx.pages[0].visionMd).toBe('Surya OCR text');
  });

  it('chunks large documents into SURYA_CHUNK_SIZE batches', async () => {
    const callArgs = [];
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd !== 'surya_ocr') { callback(null, '', ''); return; }
      if (args[0] === '--help') { callback(new Error('usage')); return; }
      callArgs.push(args);
      const outDir = args[args.indexOf('--results_dir') + 1];
      const { writeFileSync: wfs, mkdirSync: mds, readdirSync: rds } = require('fs');
      mds(outDir, { recursive: true });
      // Generate results for each PNG in the chunk dir
      const chunkDir = args[0];
      const files = rds(chunkDir).filter(f => f.endsWith('.png'));
      const results = Object.fromEntries(files.map(f => [f, [{ text_lines: [{ text: `text-${f}` }] }]]));
      wfs(require('path').join(outDir, 'results.json'), JSON.stringify(results));
      callback(null, '', '');
    });

    // Create 25 pages (> SURYA_CHUNK_SIZE=20) — should produce 2 surya_ocr calls
    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null } });
    ctx.pages = Array.from({ length: 25 }, (_, i) => makePageWithPng(i + 1));
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    await s5Vision(ctx);
    // Subtract 1 for the --help check; remaining calls should be 2 chunks
    const batchCalls = callArgs.filter(a => a[0] !== '--help');
    expect(batchCalls.length).toBe(2);
  });

  it('falls back to HTTP chain when surya CLI not found', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })   // boss health
      .mockResolvedValueOnce({ ok: true, json: async () => ({                  // boss ocr
        choices: [{ message: { content: 'Boss text' } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      })}));

    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; callback(e); return; }
      callback(null, '', '');
    });

    const ctx = makeCtx({ config: { apiKey: null, azureKey: null, googleKey: null } });
    ctx.pages = [makePageWithPng(1)];
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
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; callback(e); return; }
      callback(null, '', '');
    });
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.pages = [makePageWithPng(1)];
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
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; callback(e); return; }
      callback(null, '', '');
    });
    const ctx = makeCtx({ importance: 3, config: {
      apiKey: null, azureKey: 'key', azureEndpoint: 'https://azure.test', googleKey: null,
      implementations: { vision: ['boss', 'azure'] } } });
    ctx.pages = [makePageWithPng(1)];
    vi.resetModules();
    const { s5Vision } = await import('../../src/pipeline/stages/s5-vision.js');
    const p = s5Vision(ctx);
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(ctx.pages[0].visionMd).toBe('Azure text');
  });

  it('calls google with correct language hint', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false })   // boss health fails
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        responses: [{ fullTextAnnotation: { text: 'Google Arabic text' } }],
      })}));
    vi.spyOn(await import('child_process'), 'execFile').mockImplementation((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (cmd === 'surya_ocr') { const e = new Error('not found'); e.code = 'ENOENT'; callback(e); return; }
      callback(null, '', '');
    });
    const ctx = makeCtx({ importance: 3, config: {
      apiKey: null, azureKey: null, googleKey: 'goog-key',
      escalation: { cloudVision: 3 },
      implementations: { vision: ['boss', 'google'] } } });
    ctx.pages = [makePageWithPng(1, 'ara')];
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
