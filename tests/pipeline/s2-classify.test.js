// Tests for s2Classify stage — region assignment based on language stub.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCtx } from './helpers.js';

vi.mock('../../src/pipeline/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, shouldRun: vi.fn(() => true) };
});

import { shouldRun } from '../../src/pipeline/config.js';
import { s2Classify } from '../../src/pipeline/stages/s2-classify.js';

beforeEach(() => {
  vi.clearAllMocks();
  shouldRun.mockReturnValue(true);
});

describe('s2Classify stage', () => {
  it('skips when shouldRun returns false', async () => {
    shouldRun.mockReturnValue(false);
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.metrics.stages).toHaveLength(0);
  });

  it('records s2 stage entry', async () => {
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    const stage = ctx.metrics.stages.find(s => s.stage === 's2');
    expect(stage).toBeDefined();
  });

  it('assigns printed_latin region to pages when no language set', async () => {
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions).toHaveLength(1);
    expect(ctx.pages[0].regions[0].type).toBe('printed_latin');
  });

  it('assigns printed_arabic when language is "ar"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'ar' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_arabic');
  });

  it('assigns printed_arabic when language is "ara"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'ara' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_arabic');
  });

  it('assigns printed_persian when language is "fa"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'fa' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_persian');
  });

  it('assigns printed_persian when language is "fas"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'fas' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_persian');
  });

  it('assigns printed_cjk when language is "zh"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'zh' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_cjk');
  });

  it('assigns printed_cjk when language is "ja"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'ja' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_cjk');
  });

  it('assigns printed_cjk when language is "ko"', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'ko' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_cjk');
  });

  it('falls back to printed_latin for unknown language', async () => {
    const ctx = makeCtx();
    ctx.meta = { language: 'klingon' };
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].type).toBe('printed_latin');
  });

  it('does NOT override existing regions', async () => {
    const ctx = makeCtx();
    ctx.pages = [{
      pageNo: 1,
      regions: [{ type: 'handwritten', bbox: [0, 0, 100, 200] }],
      quality: {},
    }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions).toHaveLength(1);
    expect(ctx.pages[0].regions[0].type).toBe('handwritten');
  });

  it('processes all pages', async () => {
    const ctx = makeCtx();
    ctx.pages = [
      { pageNo: 1, regions: [], quality: {} },
      { pageNo: 2, regions: [], quality: {} },
      { pageNo: 3, regions: [], quality: {} },
    ];
    await s2Classify(ctx);
    expect(ctx.pages.every(p => p.regions.length === 1)).toBe(true);
  });

  it('handles empty pages array without throwing', async () => {
    const ctx = makeCtx();
    ctx.pages = [];
    await expect(s2Classify(ctx)).resolves.not.toThrow();
  });

  it('region bbox is null (stub — full page)', async () => {
    const ctx = makeCtx();
    ctx.pages = [{ pageNo: 1, regions: [], quality: {} }];
    await s2Classify(ctx);
    expect(ctx.pages[0].regions[0].bbox).toBeNull();
  });
});
