import { describe, it, expect } from 'vitest';
import { PipelineContext, PIPELINE_VERSION } from '../../src/pipeline/context.js';
import { makeCtx } from './helpers.js';

describe('PipelineContext', () => {
  it('requires docId and sourcePath', () => {
    expect(() => new PipelineContext({})).toThrow('docId required');
    expect(() => new PipelineContext({ docId: 'x' })).toThrow('sourcePath required');
  });

  it('clamps importance to 0-5', () => {
    expect(makeCtx({ importance: -1 }).importance).toBe(0);
    expect(makeCtx({ importance: 99 }).importance).toBe(5);
    expect(makeCtx({ importance: 3 }).importance).toBe(3);
  });

  it('beginStage / endStage records a stage entry', () => {
    const ctx = makeCtx();
    ctx.beginStage('s0');
    ctx.endStage('s0', { pages_affected: 5, cost_usd: 0.001 });
    expect(ctx.metrics.stages).toHaveLength(1);
    const s = ctx.metrics.stages[0];
    expect(s.stage).toBe('s0');
    expect(s.duration_ms).toBeGreaterThanOrEqual(0);
    expect(s.pages_affected).toBe(5);
    expect(s.cost_usd).toBe(0.001);
  });

  it('addDecision records to decisions array', () => {
    const ctx = makeCtx();
    ctx.addDecision('s0', 'early_exit', 'score too high', 0.9);
    expect(ctx.metrics.decisions).toHaveLength(1);
    expect(ctx.metrics.decisions[0]).toMatchObject({ stage: 's0', decision: 'early_exit', value: 0.9 });
  });

  it('addError distinguishes recoverable/fatal', () => {
    const ctx = makeCtx();
    ctx.addError('s3', new Error('boom'), true);
    ctx.addError('s0', new Error('fatal'), false);
    expect(ctx.metrics.errors[0].recoverable).toBe(true);
    expect(ctx.metrics.errors[1].recoverable).toBe(false);
  });

  it('setBaseline / recordStageQuality / qualityDelta', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.3, readable_pages_pct: 0.5 });
    expect(ctx.quality.baseline.composite_score).toBe(0.3);
    expect(ctx.quality.perStage.s0).toBe(0.3);
    ctx.recordStageQuality('s6', 0.7);
    expect(ctx.qualityDelta('s0', 's6')).toBeCloseTo(0.4);
  });

  it('qualityDelta returns null for missing stages', () => {
    const ctx = makeCtx();
    expect(ctx.qualityDelta('s0', 's6')).toBeNull();
  });

  it('toReceipt includes all required fields', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.2 });
    ctx.quality.final = 0.7;
    const r = ctx.toReceipt();
    expect(r).toMatchObject({
      doc_id: ctx.docId,
      pipeline_version: PIPELINE_VERSION,
      importance: ctx.importance,
      quality: { baseline: { composite_score: 0.2 }, final: 0.7, gain: expect.closeTo(0.5, 2) },
      totals: { cost_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 },
    });
  });

  it('toReceipt computes cost_per_quality_point', () => {
    const ctx = makeCtx();
    ctx.beginStage('s6');
    ctx.endStage('s6', { cost_usd: 0.01 });
    ctx.setBaseline({ composite_score: 0.3 });
    ctx.quality.final = 0.8;
    const r = ctx.toReceipt();
    expect(r.quality.cost_per_quality_point).toBeCloseTo(0.01 / 0.5, 4);
  });

  it('toReceipt includes assessment and suggestions fields', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.3, has_text_layer: 0 });
    ctx.quality.final = 0.7;
    const r = ctx.toReceipt();
    expect(r.assessment).toBeDefined();
    expect(r.assessment.doc_type).toBe('image_pdf');
    expect(r.assessment.quality_gain_pct).toBe(40);
    expect(Array.isArray(r.suggestions)).toBe(true);
  });

  it('toReceipt suggestions flags gs_normalized when set', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = true;
    ctx.setBaseline({ composite_score: 0.3 });
    ctx.quality.final = 0.3;
    const r = ctx.toReceipt();
    expect(r.assessment.gs_normalized).toBe(true);
    const normSuggestion = r.suggestions.find(s => s.category === 'normalization');
    expect(normSuggestion).toBeDefined();
  });

  it('toReceipt suggestions flags high cost low gain', () => {
    const ctx = makeCtx();
    ctx.beginStage('s6');
    ctx.endStage('s6', { cost_usd: 0.05 });
    ctx.setBaseline({ composite_score: 0.5 });
    ctx.quality.final = 0.51; // near-zero gain
    const r = ctx.toReceipt();
    const costSuggestion = r.suggestions.find(s => s.category === 'cost_efficiency');
    expect(costSuggestion).toBeDefined();
    expect(costSuggestion.priority).toBe('medium');
  });

  it('serialises and restores via toJSON / fromJSON', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.4 });
    ctx.pageCount = 12;
    const json = ctx.toJSON();
    const restored = PipelineContext.fromJSON(json);
    expect(restored.docId).toBe(ctx.docId);
    expect(restored.quality.baseline.composite_score).toBe(0.4);
    expect(restored.pageCount).toBe(12);
  });
});
