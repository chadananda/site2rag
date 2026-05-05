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
});
