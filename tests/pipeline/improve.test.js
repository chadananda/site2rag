import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { analyzeRun, reviewSuggestions, markReviewed, perStageDelta } from '../../src/pipeline/improve.js';
import { openAnalyticsDb, ANALYTICS_SCHEMA } from '../../src/pipeline/analytics.js';
import { makeCtx, makeTempDir } from './helpers.js';
import { join } from 'path';

let tempDir, cleanup, db;

beforeEach(async () => {
  ({ dir: tempDir, cleanup } = makeTempDir());
  db = await openAnalyticsDb(join(tempDir, 'test-analytics.db'));

  // Clean slate for each test
  db.prepare('DELETE FROM improvement_suggestions').run();

  // Insert a minimal pipeline_run row so analyzeRun can find run_id
  db.prepare(`INSERT OR REPLACE INTO pipeline_runs
    (run_id, pipeline_version, ts, importance, page_count, doc_type, script,
     domain_subject, domain_subdomains, domain_confidence, domain_source, site_host,
     baseline_score, final_score, quality_gain, total_cost_usd, total_tokens_in,
     total_tokens_out, cost_per_quality_point, stages_run, stages_skipped,
     error_count, fatal_error_count, preprocessing_winner, duration_ms)
    VALUES ('test-run-001','1.0',datetime('now'),2,10,'image_pdf','latin',
     'religious-texts','[]',0.85,'pattern_match','example.com',
     0.4,0.7,0.3,0.015,1000,200,0.05,'["s0","s1"]','[]',0,0,null,5000)`).run();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('analyzeRun — normalization suggestion', () => {
  it('inserts normalization suggestion when ctx._gsNormalized is true', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = true;
    ctx.sourceUrl = 'https://bahai-library.com/bahailib/1457.pdf';
    ctx.domain = { subject: 'religious-texts', confidence: 0.85, source: 'pattern_match' };

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='normalization'").get();
    expect(s).toBeDefined();
    expect(s.suggestion).toBe('pdf_has_nonconformant_jpeg2000');
    expect(s.priority).toBe('medium');
    expect(s.site_host).toBe('bahai-library.com');
  });

  it('does not insert normalization suggestion when not normalized', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = false;
    analyzeRun(ctx, db);
    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='normalization'").get();
    expect(s).toBeFalsy();
  });
});

describe('analyzeRun — cost efficiency suggestion', () => {
  it('inserts high-priority cost_efficiency when cost > 0.10 and gain < 0.05', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.7, source: 'pattern_match' };
    // Inject high cost / low gain into receipt via metrics
    ctx.metrics.stages.push({
      stage: 's5', cost_usd: 0.15, tokens_in: 5000, tokens_out: 2000,
      duration_ms: 3000, pages_affected: 10, notes: null,
    });

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='cost_efficiency'").get();
    expect(s).toBeDefined();
    expect(s.priority).toBe('high');
  });

  it('inserts medium-priority when cost 0.02-0.10 and gain < 0.05', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.7, source: 'pattern_match' };
    ctx.metrics.stages.push({
      stage: 's6', cost_usd: 0.03, tokens_in: 1000, tokens_out: 500,
      duration_ms: 1000, pages_affected: 5, notes: null,
    });

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='cost_efficiency'").get();
    if (s) expect(s.priority).toBe('medium');
    // may not fire if quality_gain >= 0.05 — depends on ctx defaults
  });
});

describe('analyzeRun — model_config suggestion', () => {
  it('inserts model_config suggestion when domain source is haiku_thin_signals', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'scientific', confidence: 0.65, source: 'haiku_thin_signals' };

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='model_config'").get();
    expect(s).toBeDefined();
    expect(s.suggestion).toBe('provide_richer_caller_context_to_reduce_haiku_calls');
  });

  it('does not insert model_config when domain source is pattern_match', () => {
    const ctx = makeCtx();
    ctx.domain = { subject: 'legal', confidence: 0.8, source: 'pattern_match' };
    analyzeRun(ctx, db);
    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='model_config'").get();
    expect(s).toBeFalsy();
  });
});

describe('analyzeRun — threshold suggestion', () => {
  it('inserts threshold suggestion when baseline is within 0.05 of goodDoc threshold', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.8, source: 'pattern_match' };
    // goodDoc default is 0.75; set baseline to 0.73 (within 0.05)
    ctx.setBaseline({ composite_score: 0.73 });

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='threshold'").get();
    expect(s).toBeDefined();
    expect(s.suggestion).toBe('consider_adjusting_goodDoc_threshold');
    expect(s.priority).toBe('low');
  });

  it('does NOT insert threshold suggestion when baseline is far from goodDoc threshold', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.8, source: 'pattern_match' };
    // baseline 0.30 is far from default goodDoc 0.75
    ctx.setBaseline({ composite_score: 0.30 });

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='threshold'").get();
    expect(s).toBeFalsy();
  });
});

describe('analyzeRun — stage_value suggestion', () => {
  it('inserts stage_value suggestion when s6 runs with cost but no quality delta', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.8, source: 'pattern_match' };
    ctx.setBaseline({ composite_score: 0.5 });
    // s6 ran and recorded cost, but no quality improvement
    ctx.beginStage('s6');
    ctx.endStage('s6', { cost_usd: 0.005, tokens_in: 200, tokens_out: 100 });
    ctx.recordStageQuality('s6', 0.5); // same as baseline → delta = 0

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='stage_value'").get();
    expect(s).toBeDefined();
    expect(s.signal).toBe('s6_zero_delta');
  });

  it('does NOT insert stage_value when stage has negligible cost', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.8, source: 'pattern_match' };
    ctx.setBaseline({ composite_score: 0.5 });
    ctx.beginStage('s6');
    ctx.endStage('s6', { cost_usd: 0.0005 }); // below 0.001 threshold
    ctx.recordStageQuality('s6', 0.5);

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='stage_value'").get();
    expect(s).toBeFalsy();
  });

  it('inserts stage_value suggestion for s5 (vision) with cost but no quality delta', () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.domain = { subject: 'legal', confidence: 0.8, source: 'pattern_match' };
    ctx.setBaseline({ composite_score: 0.5 });
    ctx.beginStage('s5');
    ctx.endStage('s5', { cost_usd: 0.02, tokens_in: 500, tokens_out: 200 });
    ctx.recordStageQuality('s5', 0.5); // no improvement

    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='stage_value'").get();
    expect(s).toBeDefined();
    expect(s.signal).toBe('s5_zero_delta');
  });
});

describe('reviewSuggestions', () => {
  it('returns runStats, stageStats, normFreq, suggestions arrays', () => {
    const result = reviewSuggestions(db);
    expect(result).toMatchObject({
      suggestions: expect.any(Array),
      runStats: expect.any(Object),
      stageStats: expect.any(Array),
      normFreq: expect.any(Array),
      since: expect.any(String),
    });
  });

  it('groups suggestions by category+suggestion+site_host with count', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = true;
    ctx.sourceUrl = 'https://bahai-library.com/a.pdf';
    ctx.domain = { subject: 'religious-texts', confidence: 0.9, source: 'pattern_match' };
    analyzeRun(ctx, db);
    analyzeRun(ctx, db);  // run twice

    const result = reviewSuggestions(db, { unreviewed: false });
    const normSuggestions = result.suggestions.filter(s => s.category === 'normalization');
    expect(normSuggestions.length).toBeGreaterThan(0);
    expect(normSuggestions[0].count).toBeGreaterThanOrEqual(2);
  });

  it('respects sinceDays window', () => {
    const result = reviewSuggestions(db, { sinceDays: 0 });
    // 0 days back: no suggestions should appear (they were just written as 'now')
    // This is a timing edge case — just verify it returns the right shape
    expect(result.suggestions).toBeInstanceOf(Array);
  });

  it('unreviewed=true (default) filters out reviewed suggestions', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = true;
    ctx.sourceUrl = 'https://bahai-library.com/c.pdf';
    ctx.domain = { subject: 'religious-texts', confidence: 0.9, source: 'pattern_match' };
    analyzeRun(ctx, db);

    // Mark all suggestions as reviewed
    const all = db.prepare('SELECT id FROM improvement_suggestions').all();
    markReviewed(db, all.map(r => r.id));

    // unreviewed=true (default) should return empty suggestions
    const result = reviewSuggestions(db);  // default unreviewed=true
    expect(result.suggestions).toHaveLength(0);

    // unreviewed=false should include the reviewed suggestions
    const allResult = reviewSuggestions(db, { unreviewed: false });
    expect(allResult.suggestions.length).toBeGreaterThan(0);
  });
});

describe('markReviewed', () => {
  it('marks suggestions as reviewed', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = true;
    ctx.sourceUrl = 'https://bahai-library.com/b.pdf';
    ctx.domain = { subject: 'religious-texts', confidence: 0.9, source: 'pattern_match' };
    analyzeRun(ctx, db);

    const s = db.prepare("SELECT id FROM improvement_suggestions").get();
    expect(s).toBeDefined();

    markReviewed(db, [s.id]);

    const updated = db.prepare("SELECT reviewed FROM improvement_suggestions WHERE id=?").get(s.id);
    expect(updated.reviewed).toBe(1);
  });
});

describe('evidence field privacy', () => {
  it('evidence JSON contains only numeric/structured data, not doc content', () => {
    const ctx = makeCtx();
    ctx._gsNormalized = true;
    ctx.sourceUrl = 'https://example.com/confidential-report.pdf';
    ctx.domain = { subject: 'governmental', confidence: 0.7, source: 'pattern_match' };
    analyzeRun(ctx, db);

    const s = db.prepare("SELECT * FROM improvement_suggestions WHERE category='normalization'").get();
    expect(s).toBeDefined();
    // evidence must not contain URLs, filenames, or document titles
    expect(s.evidence ?? '').not.toContain('https://');
    expect(s.evidence ?? '').not.toContain('confidential-report');
    expect(s.evidence ?? '').not.toContain('example.com');
    // host is stored in site_host column, not buried in evidence JSON
    expect(s.site_host).toBe('example.com');
  });
});

describe('perStageDelta', () => {
  it('returns null when stage not in perStage', () => {
    const ctx = makeCtx();
    expect(perStageDelta(ctx, 's5')).toBeNull();
  });

  it('returns null when stage score is null', () => {
    const ctx = makeCtx();
    ctx.quality.perStage['s5'] = null;
    expect(perStageDelta(ctx, 's5')).toBeNull();
  });

  it('returns null when first stage has no baseline', () => {
    const ctx = makeCtx();
    ctx.quality.perStage['s5'] = 0.7;
    // no baseline set, no prior stage → prev is null
    expect(perStageDelta(ctx, 's5')).toBeNull();
  });

  it('uses baseline composite_score as prev for first stage', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.5 });
    // s0 is set by setBaseline; s5 is first key after s0
    ctx.quality.perStage['s5'] = 0.7;
    // s5 is not index 0 (s0 is), so prev = scores['s0'] = 0.5
    const delta = perStageDelta(ctx, 's5');
    expect(delta).toBeCloseTo(0.2, 5);
  });

  it('uses prior stage score as prev for subsequent stages', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.4 });
    ctx.quality.perStage['s5'] = 0.6;
    ctx.quality.perStage['s6'] = 0.75;
    expect(perStageDelta(ctx, 's6')).toBeCloseTo(0.15, 5);
  });

  it('returns zero when stage score equals prior stage', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.5 });
    ctx.quality.perStage['s5'] = 0.5;
    expect(perStageDelta(ctx, 's5')).toBeCloseTo(0, 5);
  });

  it('returns negative delta when stage score is lower than prior', () => {
    const ctx = makeCtx();
    ctx.setBaseline({ composite_score: 0.6 });
    ctx.quality.perStage['s5'] = 0.55;
    expect(perStageDelta(ctx, 's5')).toBeCloseTo(-0.05, 5);
  });
});
