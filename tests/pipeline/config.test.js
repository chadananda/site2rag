// Tests for pipeline config.js: stagesForImportance, shouldRun, withinBudget, mergeConfig, llmCost.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG, mergeConfig, stagesForImportance, shouldRun, withinBudget, llmCost, MODEL_RATES,
} from '../../src/pipeline/config.js';
import { makeCtx } from './helpers.js';

describe('DEFAULT_CONFIG', () => {
  it('has all required stage names', () => {
    expect(DEFAULT_CONFIG.stages).toContain('s0');
    expect(DEFAULT_CONFIG.stages).toContain('s3');
    expect(DEFAULT_CONFIG.stages).toContain('s6');
    expect(DEFAULT_CONFIG.stages).toContain('s8');
  });

  it('has escalation thresholds', () => {
    expect(typeof DEFAULT_CONFIG.escalation.preprocessing).toBe('number');
    expect(typeof DEFAULT_CONFIG.escalation.localVision).toBe('number');
  });
});

describe('mergeConfig', () => {
  it('returns a complete config when called with no args', () => {
    const cfg = mergeConfig();
    expect(cfg.stages).toBeDefined();
    expect(cfg.thresholds).toBeDefined();
    expect(cfg.escalation).toBeDefined();
  });

  it('overrides top-level key', () => {
    const cfg = mergeConfig({ failFast: true });
    expect(cfg.failFast).toBe(true);
  });

  it('merges nested thresholds without dropping defaults', () => {
    const firstKey = Object.keys(DEFAULT_CONFIG.thresholds)[0];
    const override = { thresholds: { [firstKey]: 0.99 } };
    const cfg = mergeConfig(override);
    expect(cfg.thresholds[firstKey]).toBe(0.99);
    // Other threshold keys should still be present
    const otherKey = Object.keys(DEFAULT_CONFIG.thresholds)[1];
    expect(cfg.thresholds[otherKey]).toBeDefined();
  });

  it('merges nested escalation without dropping defaults', () => {
    const cfg = mergeConfig({ escalation: { preprocessing: 999 } });
    expect(cfg.escalation.preprocessing).toBe(999);
    expect(cfg.escalation.localVision).toBeDefined();
  });

  it('does not mutate DEFAULT_CONFIG', () => {
    const originalPreprocessing = DEFAULT_CONFIG.escalation.preprocessing;
    mergeConfig({ escalation: { preprocessing: 9999 } });
    expect(DEFAULT_CONFIG.escalation.preprocessing).toBe(originalPreprocessing);
  });
});

describe('stagesForImportance', () => {
  it('includes base stages for typical importance', () => {
    const stages = stagesForImportance(5);
    expect(stages).toContain('s0');
    expect(stages).toContain('s3');
  });

  it('excludes s2 when importance below regionClassify threshold', () => {
    const cfg = mergeConfig({ escalation: { regionClassify: 10 } });
    const stages = stagesForImportance(5, cfg);
    expect(stages).not.toContain('s2');
  });

  it('includes s2 when importance at or above regionClassify threshold', () => {
    const cfg = mergeConfig({ escalation: { regionClassify: 5 } });
    const stages = stagesForImportance(5, cfg);
    expect(stages).toContain('s2');
  });

  it('respects skip list in config', () => {
    const cfg = mergeConfig({ skip: ['s6'] });
    const stages = stagesForImportance(5, cfg);
    expect(stages).not.toContain('s6');
  });
});

describe('shouldRun', () => {
  it('returns true for unlocked stage with adequate importance', () => {
    const ctx = makeCtx({ importance: 100 });
    expect(shouldRun('s3', ctx)).toBe(true);
  });

  it('returns false when stage is in skip list', () => {
    const ctx = makeCtx({ config: { skip: ['s3'] } });
    expect(shouldRun('s3', ctx)).toBe(false);
  });

  it('returns false when importance below s4 escalation gate', () => {
    // importance is clamped to [0,5] by PipelineContext
    const ctx = makeCtx({ importance: 1, config: { escalation: { preprocessing: 3 } } });
    expect(shouldRun('s4', ctx)).toBe(false);
  });

  it('returns true when importance meets s4 escalation gate', () => {
    const ctx = makeCtx({ importance: 3, config: { escalation: { preprocessing: 3 } } });
    expect(shouldRun('s4', ctx)).toBe(true);
  });

  it('returns false when importance below s5 localVision gate', () => {
    const ctx = makeCtx({ importance: 1, config: { escalation: { localVision: 3 } } });
    expect(shouldRun('s5', ctx)).toBe(false);
  });

  it('returns true for s0 regardless of importance', () => {
    const ctx = makeCtx({ importance: 1 });
    expect(shouldRun('s0', ctx)).toBe(true);
  });
});

describe('withinBudget', () => {
  it('always returns true when maxTokenBudget is not set', () => {
    const ctx = makeCtx({ config: { maxTokenBudget: null } });
    expect(withinBudget(ctx, 999999)).toBe(true);
  });

  it('returns true when usage plus additional is within budget', () => {
    const ctx = makeCtx({ config: { maxTokenBudget: 10000 } });
    ctx.beginStage('s3');
    ctx.endStage('s3', { tokens_in: 2000, tokens_out: 500, cost_usd: 0 });
    expect(withinBudget(ctx, 5000)).toBe(true);
  });

  it('returns false when usage plus additional would exceed budget', () => {
    const ctx = makeCtx({ config: { maxTokenBudget: 5000 } });
    ctx.beginStage('s3');
    ctx.endStage('s3', { tokens_in: 4000, tokens_out: 500, cost_usd: 0 });
    expect(withinBudget(ctx, 1000)).toBe(false);
  });

  it('returns true for zero additionalTokens even at full budget', () => {
    const ctx = makeCtx({ config: { maxTokenBudget: 5000 } });
    ctx.beginStage('s3');
    ctx.endStage('s3', { tokens_in: 5000, tokens_out: 0, cost_usd: 0 });
    expect(withinBudget(ctx, 0)).toBe(true);
  });
});

describe('llmCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(llmCost('claude-haiku-4-5-20251001', 0, 0)).toBe(0);
  });

  it('computes correct cost for known Haiku model', () => {
    // MODEL_RATES['claude-haiku-4-5-20251001'] = [inputPerM, outputPerM]
    const rate = MODEL_RATES['claude-haiku-4-5-20251001'];
    expect(rate).toBeDefined();
    const inputRate = Array.isArray(rate) ? rate[0] : rate.input;
    const cost = llmCost('claude-haiku-4-5-20251001', 1_000_000, 0);
    expect(cost).toBeCloseTo(inputRate, 5);
  });

  it('falls back to default rate for unknown model', () => {
    // Unknown model should not throw
    const cost = llmCost('gpt-totally-unknown', 1_000_000, 0);
    expect(cost).toBeGreaterThan(0);
  });

  it('output tokens cost more than input tokens (typical models)', () => {
    const inputCost = llmCost('claude-haiku-4-5-20251001', 1_000_000, 0);
    const outputCost = llmCost('claude-haiku-4-5-20251001', 0, 1_000_000);
    expect(outputCost).toBeGreaterThan(inputCost);
  });
});
