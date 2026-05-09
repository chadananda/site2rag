import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCtx, makePageWords } from './helpers.js';

// Mock the external spell-fix dependency so tests never call the real API
vi.mock('../../src/pdf-upgrade/spell-fix.js', () => ({
  spellFixWordObjects: vi.fn(),
}));

import { spellFixWordObjects } from '../../src/pdf-upgrade/spell-fix.js';
import { s6SpellFix } from '../../src/pipeline/stages/s6-spellfix.js';

// CONTRACT tests: verify shape and behavior regardless of API implementation

describe('s6SpellFix — contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spellFixWordObjects.mockResolvedValue({
      words: [],
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: 0.0001,
    });
  });

  it('skips when no API key is configured', async () => {
    const ctx = makeCtx({ config: { apiKey: undefined } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [makePageWords(1, [{ text: 'wrold', conf: 75 }])];

    await s6SpellFix(ctx);

    expect(spellFixWordObjects).not.toHaveBeenCalled();
    expect(ctx.metrics.decisions.some(d => d.decision === 'skip' && d.stage === 's6')).toBe(true);
  });

  it('skips when baseline score is below spellFixMin threshold', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key', thresholds: { spellFixMin: 0.50 } } });
    ctx.quality.baseline = { composite_score: 0.30 };
    ctx.pages = [makePageWords(1, [{ text: 'wrold', conf: 75 }])];

    await s6SpellFix(ctx);

    expect(spellFixWordObjects).not.toHaveBeenCalled();
    const skip = ctx.metrics.decisions.find(d => d.decision === 'skip' && d.stage === 's6');
    expect(skip).toBeDefined();
    expect(skip.reason).toMatch(/too broken/);
  });

  it('only sends fuzzy-confidence words to spellFixWordObjects', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    const cleanWord = { text: 'clean', conf: 95, x1: 10, y1: 10, x2: 50, y2: 20 };
    const fuzzyWord = { text: 'wrold', conf: 75, x1: 60, y1: 10, x2: 100, y2: 20 };
    const dirtyWord = { text: 'x#!z', conf: 20, x1: 110, y1: 10, x2: 150, y2: 20 };
    ctx.pages = [{
      pageNo: 1,
      words: [cleanWord, fuzzyWord, dirtyWord].map(w => ({ ...w, source: 'tesseract', pageNo: 1 })),
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ ...fuzzyWord, text: 'world', _srcIdx: 0 }],
      tokens_in: 5, tokens_out: 3, cost_usd: 0.00005,
    });

    await s6SpellFix(ctx);

    expect(spellFixWordObjects).toHaveBeenCalledOnce();
    const calledWords = spellFixWordObjects.mock.calls[0][0];
    // Only the fuzzy word should be sent
    expect(calledWords).toHaveLength(1);
    expect(calledWords[0].text).toBe('wrold');
    // Dirty word NOT included
    expect(calledWords.some(w => w.text === 'x#!z')).toBe(false);
  });

  it('leaves clean and dirty words untouched in page.words after fix', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [
        { text: 'Hello', conf: 95, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 },
        { text: 'wrold', conf: 72, x1: 55, y1: 10, x2: 90, y2: 20, source: 'ocr', pageNo: 1 },
        { text: 'junk', conf: 15, x1: 95, y1: 10, x2: 130, y2: 20, source: 'ocr', pageNo: 1 },
      ],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ text: 'world', conf: 72, x1: 55, y1: 10, x2: 90, y2: 20, _srcIdx: 0 }],
      tokens_in: 5, tokens_out: 3, cost_usd: 0.00005,
    });

    await s6SpellFix(ctx);

    const words = ctx.pages[0].words;
    expect(words[0].text).toBe('Hello');  // clean — unchanged
    expect(words[1].text).toBe('world');  // fuzzy — corrected
    expect(words[2].text).toBe('junk');   // dirty — unchanged
  });

  it('records stage entry with cost/token fields', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 }],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ text: 'world', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, _srcIdx: 0 }],
      tokens_in: 12, tokens_out: 8, cost_usd: 0.0002,
    });

    await s6SpellFix(ctx);

    const stage = ctx.metrics.stages.find(s => s.stage === 's6');
    expect(stage).toBeDefined();
    expect(stage.duration_ms).toBeGreaterThanOrEqual(0);
    expect(stage.cost_usd).toBeCloseTo(0.0002, 5);
    expect(stage.tokens_in).toBe(12);
    expect(stage.tokens_out).toBe(8);
  });

  it('stops processing pages when token budget is exceeded', async () => {
    const ctx = makeCtx({
      config: {
        apiKey: 'test-key',
        maxTokenBudget: 1,  // 1-token budget forces immediate stop
      }
    });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [
      { pageNo: 1, words: [{ text: 'a'.repeat(500), conf: 72, x1: 0, y1: 0, x2: 10, y2: 10, source: 'ocr', pageNo: 1 }], regions: [], quality: {} },
      { pageNo: 2, words: [{ text: 'wrold', conf: 72, x1: 0, y1: 0, x2: 10, y2: 10, source: 'ocr', pageNo: 2 }], regions: [], quality: {} },
    ];
    spellFixWordObjects.mockResolvedValue({ words: [], tokens_in: 0, tokens_out: 0, cost_usd: 0 });

    await s6SpellFix(ctx);

    // With budget=1, the first page's fuzzy words exceed it → budget_stop decision
    const budgetStop = ctx.metrics.decisions.find(d => d.decision === 'budget_stop');
    expect(budgetStop).toBeDefined();
    // Should not have tried to fix both pages
    expect(spellFixWordObjects).not.toHaveBeenCalled();
  });

  it('returns the same ctx object (mutation, not copy)', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [];
    const returned = await s6SpellFix(ctx);
    expect(returned).toBe(ctx);
  });

  it('handles spellFixWordObjects throwing without re-throwing (recoverable)', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key', failFast: false } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 }],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockRejectedValue(new Error('API timeout'));

    await expect(s6SpellFix(ctx)).resolves.toBeDefined();
    expect(ctx.metrics.errors.some(e => e.stage === 's6')).toBe(true);
  });

  it('re-throws when failFast=true', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key', failFast: true } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 }],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockRejectedValue(new Error('API timeout'));

    await expect(s6SpellFix(ctx)).rejects.toThrow('API timeout');
  });

  it('skips stage when s6 is in ctx.config.skip', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key', skip: ['s6'] } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 }],
      regions: [],
      quality: {},
    }];

    await s6SpellFix(ctx);

    expect(spellFixWordObjects).not.toHaveBeenCalled();
    expect(ctx.metrics.stages.find(s => s.stage === 's6')).toBeUndefined();
  });

  it('forwards page._visionDraft to spellFixWordObjects', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    const draft = { boss: 'Boss sees: world history text', marker: null };
    ctx.pages = [{
      pageNo: 1,
      _visionDraft: draft,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 }],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ text: 'world', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, _srcIdx: 0 }],
      tokens_in: 5, tokens_out: 3, cost_usd: 0.00005,
    });

    await s6SpellFix(ctx);

    const ctxArg = spellFixWordObjects.mock.calls[0][2];
    expect(ctxArg.visionDraft).toEqual(draft);
  });

  it('passes null visionDraft when page has no _visionDraft', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 1 }],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ text: 'world', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, _srcIdx: 0 }],
      tokens_in: 5, tokens_out: 3, cost_usd: 0.00005,
    });

    await s6SpellFix(ctx);

    const ctxArg = spellFixWordObjects.mock.calls[0][2];
    expect(ctxArg.visionDraft).toBeNull();
  });

  it('correctly drops second-half of hyphen-merged pair from page.words', async () => {
    // spellFixWordObjects merges "antici-" + "pates" into one entry and returns 2 result words
    // for 3 input words. The second-half "pates" must be dropped, not replace the next word.
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.pages = [{
      pageNo: 1,
      words: [
        { text: 'antici-', conf: 72, x1: 0, y1: 0, x2: 40, y2: 10, source: 'ocr', pageNo: 1 },
        { text: 'pates', conf: 71, x1: 0, y1: 15, x2: 30, y2: 25, source: 'ocr', pageNo: 1 },
        { text: 'good', conf: 75, x1: 0, y1: 30, x2: 30, y2: 40, source: 'ocr', pageNo: 1 },
      ],
      regions: [], quality: {},
    }];
    // Simulate spellFixWordObjects merging "antici-¶pates" → "anticipates" (srcIdx=0, mergedSrcIdx=1)
    // and returning "good" unchanged (srcIdx=2)
    spellFixWordObjects.mockResolvedValue({
      words: [
        { text: 'anticipates', conf: 72, x1: 0, y1: 0, x2: 40, y2: 25, _srcIdx: 0, _mergedSrcIdx: 1 },
        { text: 'good', conf: 75, x1: 0, y1: 30, x2: 30, y2: 40, _srcIdx: 2 },
      ],
      tokens_in: 10, tokens_out: 5, cost_usd: 0.0001,
    });

    await s6SpellFix(ctx);

    const words = ctx.pages[0].words;
    // "antici-" becomes "anticipates", "pates" is dropped (merged), "good" stays
    expect(words).toHaveLength(2);
    expect(words[0].text).toBe('anticipates');
    expect(words[1].text).toBe('good');
  });

  it('passes title, language, and domainContext to spellFixWordObjects', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.7 };
    ctx.meta = { title: 'Ottoman History Journal', language: 'turkish' };
    ctx.domain = { prompt_context: 'Expert context about Ottoman history.' };
    ctx.pageCount = 5;
    ctx.pages = [{
      pageNo: 2,
      words: [{ text: 'wrold', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, source: 'ocr', pageNo: 2 }],
      regions: [],
      quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ text: 'world', conf: 72, x1: 10, y1: 10, x2: 50, y2: 20, _srcIdx: 0 }],
      tokens_in: 5, tokens_out: 3, cost_usd: 0.00005,
    });

    await s6SpellFix(ctx);

    const ctxArg = spellFixWordObjects.mock.calls[0][2];
    expect(ctxArg.title).toBe('Ottoman History Journal');
    expect(ctxArg.language).toBe('turkish');
    expect(ctxArg.domainContext).toBe('Expert context about Ottoman history.');
    expect(ctxArg.pageNo).toBe(2);
    expect(ctxArg.totalPages).toBe(5);
  });

  it('records quality.perStage.s6 when pages were fixed', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.6 };
    ctx.quality.perStage['s3'] = 0.6;
    ctx.pages = [{
      pageNo: 1,
      words: [{ text: 'wrold', conf: 72, x1: 0, y1: 0, x2: 40, y2: 10, source: 'ocr', pageNo: 1 }],
      regions: [], quality: {},
    }];
    spellFixWordObjects.mockResolvedValue({
      words: [{ text: 'world', conf: 72, x1: 0, y1: 0, x2: 40, y2: 10, _srcIdx: 0 }],
      tokens_in: 5, tokens_out: 3, cost_usd: 0.0001,
    });

    await s6SpellFix(ctx);

    // New semantic: s6 restores to the un-adjusted prior; s3 is adjusted down by correction rate.
    // 1 word corrected out of 1 total → correctionRate=1.0 → s3 adjusted to 0.0, s6 restored to 0.6.
    expect(ctx.quality.perStage['s6']).toBeDefined();
    expect(ctx.quality.perStage['s6']).toBe(0.6);      // restored to un-adjusted prior
    expect(ctx.quality.perStage['s3']).toBeLessThan(0.6); // retroactively adjusted down
  });

  it('does NOT record quality.perStage.s6 when no pages were fixed', async () => {
    const ctx = makeCtx({ config: { apiKey: 'test-key' } });
    ctx.quality.baseline = { composite_score: 0.6 };
    ctx.pages = [{
      pageNo: 1,
      words: [
        { text: 'good', conf: 95, x1: 0, y1: 0, x2: 40, y2: 10, source: 'ocr', pageNo: 1 },
      ],
      regions: [], quality: {},
    }];

    await s6SpellFix(ctx);

    expect(ctx.quality.perStage['s6']).toBeUndefined();
  });
});
