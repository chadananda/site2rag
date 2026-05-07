import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeCtx, makePageWords } from './helpers.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/pipeline/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, shouldRun: vi.fn(() => true) };
});

import { execFile } from 'child_process';
import { shouldRun } from '../../src/pipeline/config.js';
import { s4Escalate, parseHocr, meanConf, buildDraftPrompt } from '../../src/pipeline/stages/s4-escalate.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('skips pages with fewer than 3 dirty words in a large word set (low ratio)', async () => {
    const ctx = makeCtx();
    // 11 words total, only 2 dirty — ratio too low to escalate
    const manyClean = Array.from({ length: 9 }, (_, i) =>
      ({ text: `clean${i}`, conf: 95, x1: i*10, y1: 0, x2: i*10+8, y2: 10, source: 'tesseract', pageNo: 1 }));
    const twoDirty = [
      { text: 'bad1', conf: 15, x1: 100, y1: 0, x2: 120, y2: 10, source: 'tesseract', pageNo: 1 },
      { text: 'bad2', conf: 20, x1: 130, y1: 0, x2: 150, y2: 10, source: 'tesseract', pageNo: 1 },
    ];
    ctx.pages = [{
      pageNo: 1, _lang: 'eng',
      words: [...manyClean, ...twoDirty],
      regions: [], quality: {},
      _bucketed: { clean: 9, fuzzy: 0, dirty: 2, needs_vision: 0 },
    }];
    await s4Escalate(ctx);
    expect(execFile).not.toHaveBeenCalled();
    // No decisions from s4 for this page
    expect(ctx.metrics.decisions.filter(d => d.stage === 's4' && d.decision?.startsWith('page_'))).toHaveLength(0);
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

describe('s4Escalate — vision broker path', () => {
  const dirtyPage = (pngPath = null) => ({
    pageNo: 1, _lang: 'eng', _pngPath: pngPath,
    words: [
      { text: 'dirty1', conf: 15, x1: 0, y1: 0, x2: 50, y2: 20, source: 'tesseract', pageNo: 1 },
      { text: 'dirty2', conf: 20, x1: 0, y1: 30, x2: 50, y2: 50, source: 'tesseract', pageNo: 1 },
      { text: 'dirty3', conf: 18, x1: 0, y1: 60, x2: 50, y2: 80, source: 'tesseract', pageNo: 1 },
    ],
    regions: [], quality: {},
    _bucketed: { clean: 0, fuzzy: 0, dirty: 3, needs_vision: 0 },
  });

  beforeEach(() => {
    // Default: pdftoppm + tesseract produce low-conf hOCR (no improvement → keeps original)
    mockExecFile(LOW_HOCR);
  });

  it('sets page._visionDraft to { boss: null, marker: null } when no URLs configured', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const ctx = makeCtx({ config: { bossUrl: undefined, markerUrl: undefined } });
    ctx.pages = [dirtyPage()];
    await s4Escalate(ctx);
    expect(ctx.pages[0]._visionDraft).toEqual({ boss: null, marker: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches boss draft when bossUrl is configured and _pngPath exists', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Boss vision text' } }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: 'http://boss:11434' } });
    // _pngPath must point to an existing file — use the test file itself as a stand-in
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath)];
    await s4Escalate(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://boss:11434/chat/completions',
      expect.objectContaining({ method: 'POST' })
    );
    expect(ctx.pages[0]._visionDraft.boss).toBe('Boss vision text');
  });

  it('fetches marker draft via POST /convert with PDF path (not PNG image)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: 'Full document markdown from marker', ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Disable boss so only the marker call is made
    const ctx = makeCtx({ config: { bossUrl: null, markerUrl: 'http://marker:7842' } });
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath)];
    await s4Escalate(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://marker:7842/convert',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Must send PDF path (ctx.sourcePath), not a base64 image
    expect(body).toHaveProperty('pdf_path');
    expect(body).not.toHaveProperty('image');
    expect(ctx.pages[0]._visionDraft.marker).toBe('Full document markdown from marker');
  });

  it('boss draft returns null when fetch response is not ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: 'http://boss:11434' } });
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath)];
    await s4Escalate(ctx);

    expect(ctx.pages[0]._visionDraft.boss).toBeNull();
  });

  it('boss draft returns null when fetch throws (network error)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: 'http://boss:11434' } });
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath)];
    // Should not throw even if fetch fails
    await expect(s4Escalate(ctx)).resolves.toBeDefined();
    expect(ctx.pages[0]._visionDraft.boss).toBeNull();
  });

  it('marker draft returns null when fetch response is not ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: null, markerUrl: 'http://marker:7842' } });
    ctx.pages = [dirtyPage()];
    await s4Escalate(ctx);

    expect(ctx.pages[0]._visionDraft.marker).toBeNull();
  });

  it('marker result is cached: only one /convert call even with multiple dirty pages', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: 'Document markdown', ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: null, markerUrl: 'http://marker:7842' } });
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath), dirtyPage(pngPath)];
    ctx.pages[1].pageNo = 2;
    await s4Escalate(ctx);

    // marker /convert should only be called once despite 2 dirty pages
    const markerCalls = mockFetch.mock.calls.filter(c => c[0].includes('/convert'));
    expect(markerCalls).toHaveLength(1);
    expect(ctx.pages[0]._visionDraft.marker).toBe('Document markdown');
    expect(ctx.pages[1]._visionDraft.marker).toBe('Document markdown');
  });

  it('fetches boss and marker in parallel for dirty pages', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('chat/completions')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'boss text' } }] }) };
      }
      return { ok: true, json: async () => ({ markdown: 'marker text', ok: true }) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: 'http://boss:11434', markerUrl: 'http://marker:7842' } });
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath)];
    await s4Escalate(ctx);

    expect(ctx.pages[0]._visionDraft.boss).toBe('boss text');
    expect(ctx.pages[0]._visionDraft.marker).toBe('marker text');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sets _visionDraft on noOutput page (empty words) even though re-OCR is skipped', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Vision for blank page' } }] }),
    });
    vi.stubGlobal('fetch', mockFetch);
    // execFile should NOT be called for re-OCR on noOutput pages
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback(null, { stdout: '', stderr: '' });
    });

    const ctx = makeCtx({ config: { bossUrl: 'http://boss:11434' } });
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [{
      pageNo: 1, _lang: 'eng', _pngPath: pngPath,
      words: [],  // noOutput=true
      regions: [], quality: {},
      _bucketed: { clean: 0, fuzzy: 0, dirty: 0, needs_vision: 0 },
    }];
    await s4Escalate(ctx);

    // Vision draft should still be set even for noOutput pages
    expect(ctx.pages[0]._visionDraft.boss).toBe('Vision for blank page');
    expect(ctx.pages[0]._needsFullVision).toBe(true);
  });

  it('boss request body includes document metadata from ctx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'text' } }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = makeCtx({ config: { bossUrl: 'http://boss:11434' } });
    ctx.meta = { title: 'The Journal of History', language: 'french' };
    ctx.domain = { prompt_context: 'Expert context about history.' };
    const pngPath = new URL(import.meta.url).pathname;
    ctx.pages = [dirtyPage(pngPath)];
    await s4Escalate(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userText = body.messages[0].content.find(c => c.type === 'text')?.text ?? '';
    expect(userText).toContain('The Journal of History');
    expect(userText).toContain('french');
    expect(userText).toContain('Expert context about history.');
  });
});

describe('parseHocr (s4)', () => {
  it('returns empty array for empty string', () => {
    expect(parseHocr('', 1)).toEqual([]);
  });

  it('parses a single word with bbox and conf', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 10 20 80 40; x_wconf 85'>hello</span>`;
    const words = parseHocr(hocr, 3);
    expect(words).toHaveLength(1);
    expect(words[0].text).toBe('hello');
    expect(words[0].x1).toBe(10);
    expect(words[0].y1).toBe(20);
    expect(words[0].conf).toBe(85);
    expect(words[0].pageNo).toBe(3);
    expect(words[0].source).toBe('tesseract-600');
  });

  it('skips words with no bbox', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='x_wconf 90'>nobox</span>`;
    expect(parseHocr(hocr, 1)).toEqual([]);
  });

  it('skips words with empty text after stripping tags', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 90'>   </span>`;
    expect(parseHocr(hocr, 1)).toEqual([]);
  });

  it('decodes HTML entities', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20; x_wconf 90'>&amp;&lt;&gt;</span>`;
    const words = parseHocr(hocr, 1);
    expect(words[0].text).toBe('&<>');
  });

  it('uses conf=0 when x_wconf is missing', () => {
    const hocr = `<span class='ocrx_word' id='w1' title='bbox 0 0 50 20'>word</span>`;
    const words = parseHocr(hocr, 1);
    expect(words[0].conf).toBe(0);
  });
});

describe('meanConf', () => {
  it('returns 0 for empty array', () => {
    expect(meanConf([])).toBe(0);
  });

  it('returns the average conf of all words', () => {
    expect(meanConf([{ conf: 80 }, { conf: 100 }])).toBe(90);
  });

  it('treats missing conf as 0', () => {
    expect(meanConf([{ conf: 60 }, {}])).toBe(30);
  });

  it('returns exact conf for single-element array', () => {
    expect(meanConf([{ conf: 75 }])).toBe(75);
  });
});

describe('buildDraftPrompt', () => {
  it('returns base transcription instruction alone when ctx has no meta/domain', () => {
    const ctx = makeCtx();
    const prompt = buildDraftPrompt(ctx);
    expect(prompt).toContain('Transcribe all text');
    expect(prompt).toContain('Do not add commentary');
  });

  it('prepends document title when meta.title is set', () => {
    const ctx = makeCtx();
    ctx.meta = { title: 'Annual Report 2024' };
    const prompt = buildDraftPrompt(ctx);
    expect(prompt).toContain('Document: "Annual Report 2024"');
  });

  it('includes language when meta.language is set', () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'Persian' };
    const prompt = buildDraftPrompt(ctx);
    expect(prompt).toContain('Language: Persian');
  });

  it('includes domain prompt_context when set', () => {
    const ctx = makeCtx();
    ctx.domain = { prompt_context: 'This is a Bahá\'í religious text from 1890.' };
    const prompt = buildDraftPrompt(ctx);
    expect(prompt).toContain('Bahá\'í religious text');
  });

  it('assembles all fields in order: title, language, domain, instruction', () => {
    const ctx = makeCtx();
    ctx.meta = { title: 'Doc', language: 'English' };
    ctx.domain = { prompt_context: 'Historical text.' };
    const prompt = buildDraftPrompt(ctx);
    const titleIdx = prompt.indexOf('Document:');
    const langIdx = prompt.indexOf('Language:');
    const domainIdx = prompt.indexOf('Historical text.');
    const instrIdx = prompt.indexOf('Transcribe');
    expect(titleIdx).toBeLessThan(langIdx);
    expect(langIdx).toBeLessThan(domainIdx);
    expect(domainIdx).toBeLessThan(instrIdx);
  });
});
