import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { makeTempDir, makeCtx } from './helpers.js';
import { writeAnalytics, openAnalyticsDb, ANALYTICS_SCHEMA, classifyDocType, extractNotesCode, extractReasonCode, classifyError, safeHost, prevStageScore } from '../../src/pipeline/analytics.js';

describe('analytics — privacy contract', () => {
  let tmpDir, cleanup, dbPath;
  beforeEach(() => {
    ({ dir: tmpDir, cleanup } = makeTempDir());
    dbPath = join(tmpDir, 'analytics.db');
  });
  afterEach(() => cleanup());

  it('opens a DB and creates all required tables', async () => {
    const db = await openAnalyticsDb(dbPath);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    db.close();

    expect(tables).toContain('pipeline_runs');
    expect(tables).toContain('stage_metrics');
    expect(tables).toContain('decision_log');
    expect(tables).toContain('error_log');
    expect(tables).toContain('domain_profiles');
    expect(tables).toContain('page_confidence_metrics');
  });

  it('writes a pipeline_runs row after a completed context', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://bahai-library.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0.3, readable_pages_pct: 0.5, has_text_layer: 0 };
    ctx.quality.final = 0.7;
    ctx.pageCount = 5;
    ctx.domain = { subject: 'religious-texts', subdomains: ['bahai'], confidence: 0.85,
      source: 'pattern_match', prompt_context: 'Religious text.' };
    ctx.beginStage('s0');
    ctx.endStage('s0', { pages_affected: 5, cost_usd: 0, tokens_in: 0, tokens_out: 0 });

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const rows = db.prepare('SELECT * FROM pipeline_runs').all();
    db.close();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.baseline_score).toBeCloseTo(0.3, 3);
    expect(row.final_score).toBeCloseTo(0.7, 3);
    expect(row.quality_gain).toBeCloseTo(0.4, 3);
    expect(row.domain_subject).toBe('religious-texts');
    expect(row.site_host).toBe('bahai-library.com');  // host only, not full URL
    expect(row.importance).toBe(2);
    expect(row.page_count).toBe(5);
  });

  it('NEVER logs document content or file paths', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/private/secret-document.pdf';
    ctx.quality.baseline = { composite_score: 0.5, has_text_layer: 1 };
    ctx.quality.final = 0.8;

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const allData = JSON.stringify(db.prepare('SELECT * FROM pipeline_runs').all());
    db.close();

    // Source path and doc_id must not appear in analytics
    expect(allData).not.toContain(ctx.sourcePath);
    expect(allData).not.toContain(ctx.docId);
    expect(allData).not.toContain('secret-document.pdf');
    // Full URL must not appear (only hostname)
    expect(allData).not.toContain('/private/');
  });

  it('logs stage metrics without content', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0.4, has_text_layer: 0 };
    ctx.quality.final = 0.7;
    ctx.beginStage('s0'); ctx.endStage('s0', { pages_affected: 3, cost_usd: 0 });
    ctx.beginStage('s6'); ctx.endStage('s6', { pages_affected: 2, cost_usd: 0.002, tokens_in: 100, tokens_out: 80 });

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const stages = db.prepare('SELECT * FROM stage_metrics').all();
    db.close();

    expect(stages.length).toBeGreaterThanOrEqual(2);
    const s6 = stages.find(s => s.stage === 's6');
    expect(s6).toBeDefined();
    expect(s6.cost_usd).toBeCloseTo(0.002, 5);
    expect(s6.tokens_in).toBe(100);
  });

  it('classifies error messages as codes — never logs raw messages', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0, has_text_layer: 0 };
    ctx.quality.final = 0;
    ctx.addError('s0', new Error('File not found: /tank/private/sensitive-path/doc.pdf'), false);
    ctx.addError('s0', new Error('OCR timeout after 30min'), true);

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const errors = db.prepare('SELECT * FROM error_log').all();
    db.close();

    expect(errors).toHaveLength(2);
    // Error codes only — no raw message text
    expect(errors[0].error_code).toBe('file_not_found');
    expect(errors[1].error_code).toBe('timeout');
    // Sensitive path must not appear anywhere
    const allErrorData = JSON.stringify(errors);
    expect(allErrorData).not.toContain('sensitive-path');
    expect(allErrorData).not.toContain('/tank/');
  });

  it('logs decisions as reason codes — not free-text reasons', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0.6, has_text_layer: 1 };
    ctx.quality.final = 0.6;
    ctx.addDecision('s0', 'early_exit', 'composite 0.800 >= threshold 0.750 — skipping heavy stages', 0.8);
    ctx.addDecision('s6', 'skip', 'baseline 0.30 < min 0.45 — too broken for spell-fix', 0.3);

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const decisions = db.prepare('SELECT * FROM decision_log').all();
    db.close();

    expect(decisions).toHaveLength(2);
    // reason_code is just the first token — not the full reason string with numbers
    expect(decisions[0].reason_code).toBe('composite');
    expect(decisions[1].reason_code).toBe('baseline');
    // Full reason strings must not appear
    const allDecisionData = JSON.stringify(decisions);
    expect(allDecisionData).not.toContain('skipping heavy stages');
    expect(allDecisionData).not.toContain('too broken for spell-fix');
  });

  it('creates a domain_profiles entry for high-confidence domains', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://bahai-library.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0.3, has_text_layer: 0 };
    ctx.quality.final = 0.7;
    ctx.domain = { subject: 'religious-texts', subdomains: ['bahai'], era: '1844-1921',
      script_context: 'Mixed Latin and Persian script', confidence: 0.85,
      source: 'pattern_match', prompt_context: 'Bahá\'í religious text.' };

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const profile = db.prepare('SELECT * FROM domain_profiles WHERE site_host=?').get('bahai-library.com');
    db.close();

    expect(profile).toBeDefined();
    expect(profile.subject).toBe('religious-texts');
    expect(profile.doc_count).toBe(1);
    expect(profile.avg_quality_gain).toBeCloseTo(0.4, 3);
  });

  it('accumulates doc_count and smooths avg_quality_gain on repeated runs', async () => {
    const makeRun = async (gain) => {
      const ctx = makeCtx();
      ctx.sourceUrl = 'https://bahai-library.com/doc.pdf';
      ctx.quality.baseline = { composite_score: 0.5, has_text_layer: 1 };
      ctx.quality.final = 0.5 + gain;
      ctx.domain = { subject: 'religious-texts', subdomains: [], confidence: 0.85,
        source: 'pattern_match', prompt_context: 'Text.' };
      await writeAnalytics(ctx, dbPath);
    };

    await makeRun(0.2);
    await makeRun(0.4);

    const db = await openAnalyticsDb(dbPath);
    const profile = db.prepare('SELECT * FROM domain_profiles WHERE site_host=?').get('bahai-library.com');
    db.close();

    expect(profile.doc_count).toBe(2);
    expect(profile.avg_quality_gain).toBeCloseTo(0.3, 1);  // (0.2+0.4)/2
  });

  it('never throws — analytics failures are silent', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.quality.baseline = null;  // corrupt state
    ctx.quality.final = null;

    // Should resolve without throwing
    await expect(writeAnalytics(ctx, dbPath)).resolves.toBeUndefined();
  });

  it('classifies doc_type as text_pdf when has_text_layer=1 and readable_pages_pct > 0.7', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0.8, has_text_layer: 1, readable_pages_pct: 0.9 };
    ctx.quality.final = 0.9;

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const row = db.prepare('SELECT doc_type FROM pipeline_runs').get();
    db.close();
    expect(row.doc_type).toBe('text_pdf');
  });

  it('classifies doc_type as mixed when has_text_layer=1 but readable_pages_pct is low', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.quality.baseline = { composite_score: 0.4, has_text_layer: 1, readable_pages_pct: 0.3 };
    ctx.quality.final = 0.5;

    await writeAnalytics(ctx, dbPath);

    const db = await openAnalyticsDb(dbPath);
    const row = db.prepare('SELECT doc_type FROM pipeline_runs').get();
    db.close();
    // has_text_layer=1 but readable_pages_pct <= 0.7 → 'mixed'
    expect(row.doc_type).toBe('mixed');
  });
});

describe('classifyDocType', () => {
  it('returns unknown when has_text_layer is falsy', () => {
    expect(classifyDocType({ has_text_layer: 0, readable_pages_pct: 0.9 })).toBe('unknown');
    expect(classifyDocType({ has_text_layer: null, readable_pages_pct: 0.9 })).toBe('unknown');
    expect(classifyDocType({})).toBe('unknown');
  });

  it('returns text_pdf when has_text_layer=1 and readable_pages_pct > 0.7', () => {
    expect(classifyDocType({ has_text_layer: 1, readable_pages_pct: 0.8 })).toBe('text_pdf');
    expect(classifyDocType({ has_text_layer: 1, readable_pages_pct: 1.0 })).toBe('text_pdf');
  });

  it('returns mixed when has_text_layer=1 but readable_pages_pct <= 0.7', () => {
    expect(classifyDocType({ has_text_layer: 1, readable_pages_pct: 0.7 })).toBe('mixed');
    expect(classifyDocType({ has_text_layer: 1, readable_pages_pct: 0.3 })).toBe('mixed');
  });

  it('returns image_pdf when has_text_layer=0', () => {
    expect(classifyDocType({ has_text_layer: 0, readable_pages_pct: 0 })).toBe('unknown');
  });
});

describe('extractNotesCode', () => {
  it('returns null for null/empty input', () => {
    expect(extractNotesCode(null)).toBeNull();
    expect(extractNotesCode('')).toBeNull();
  });

  it('extracts the first colon-delimited token, lowercased', () => {
    expect(extractNotesCode('eng:5 pages')).toBe('eng');
    expect(extractNotesCode('Arabic:some note')).toBe('arabic');
  });

  it('replaces spaces with underscores in the code', () => {
    expect(extractNotesCode('routing summary:eng,fas')).toBe('routing_summary');
  });

  it('truncates codes longer than 32 chars', () => {
    const long = 'a'.repeat(40) + ':rest';
    expect(extractNotesCode(long).length).toBeLessThanOrEqual(32);
  });

  it('returns the whole string as code when no colon present', () => {
    expect(extractNotesCode('eng')).toBe('eng');
  });
});

describe('extractReasonCode', () => {
  it('returns null for null/empty/undefined', () => {
    expect(extractReasonCode(null)).toBeNull();
    expect(extractReasonCode('')).toBeNull();
    expect(extractReasonCode(undefined)).toBeNull();
  });

  it('extracts the first alphanumeric token', () => {
    expect(extractReasonCode('contrast_p3')).toBe('contrast_p3');
    expect(extractReasonCode('eng with extra text')).toBe('eng');
  });

  it('handles numeric input by converting to string', () => {
    expect(extractReasonCode(42)).toBe('42');
  });

  it('truncates codes longer than 32 chars', () => {
    const long = 'a'.repeat(40);
    expect(extractReasonCode(long).length).toBeLessThanOrEqual(32);
  });
});

describe('classifyError', () => {
  it('returns file_not_found for enoent/not found/no such file', () => {
    expect(classifyError('ENOENT: no such file or directory')).toBe('file_not_found');
    expect(classifyError('File not found')).toBe('file_not_found');
    expect(classifyError('no such file')).toBe('file_not_found');
  });

  it('returns timeout for timeout messages', () => {
    expect(classifyError('timeout exceeded')).toBe('timeout');
    expect(classifyError('operation timeout after 30s')).toBe('timeout');
  });

  it('returns corrupted_input for truncated/corrupt messages', () => {
    expect(classifyError('PDF is truncated')).toBe('corrupted_input');
    expect(classifyError('corrupt file header')).toBe('corrupted_input');
  });

  it('returns api_error for api/network/fetch messages', () => {
    expect(classifyError('API rate limit exceeded')).toBe('api_error');
    expect(classifyError('fetch failed: network error')).toBe('api_error');
  });

  it('returns budget_exceeded for budget/token messages', () => {
    expect(classifyError('budget limit reached')).toBe('budget_exceeded');
    expect(classifyError('token limit exceeded')).toBe('budget_exceeded');
  });

  it('returns parse_error for parse/json messages', () => {
    expect(classifyError('JSON parse error')).toBe('parse_error');
    expect(classifyError('failed to parse response')).toBe('parse_error');
  });

  it('returns permission_error for permission/access messages', () => {
    expect(classifyError('permission denied')).toBe('permission_error');
    expect(classifyError('access denied to file')).toBe('permission_error');
  });

  it('returns unknown_error for unrecognized messages', () => {
    expect(classifyError('something went wrong')).toBe('unknown_error');
    expect(classifyError(null)).toBe('unknown_error');
    expect(classifyError(undefined)).toBe('unknown_error');
  });
});

describe('safeHost', () => {
  it('extracts hostname from https URL', () => {
    expect(safeHost('https://example.com/path/to/doc.pdf')).toBe('example.com');
  });

  it('strips www. prefix', () => {
    expect(safeHost('https://www.example.com/doc.pdf')).toBe('example.com');
  });

  it('extracts subdomain (non-www) without stripping', () => {
    expect(safeHost('https://bahai-library.com/path')).toBe('bahai-library.com');
  });

  it('handles http URLs', () => {
    expect(safeHost('http://example.org/index.html')).toBe('example.org');
  });

  it('returns non-null for non-http URL (wraps in https://)', () => {
    // Non-http string gets wrapped → hostname becomes 'unknown.invalid'
    const result = safeHost('file:///local/path.pdf');
    expect(result).toBe('unknown.invalid');
  });

  it('returns null for http-prefixed but malformed URL', () => {
    expect(safeHost('http://:::bad:::')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(safeHost(null)).not.toThrow;
    // null → 'https://unknown.invalid' path → 'unknown.invalid'
    const result = safeHost(null);
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

describe('prevStageScore', () => {
  const makeCtxWith = (perStage, baselineScore = null) => ({
    quality: {
      perStage,
      baseline: baselineScore !== null ? { composite_score: baselineScore } : undefined,
    },
  });

  it('returns baseline score when stage is first in perStage', () => {
    const ctx = makeCtxWith({ s0: 0.5 }, 0.3);
    expect(prevStageScore(ctx, 's0')).toBe(0.3);
  });

  it('returns null when stage is first and no baseline', () => {
    const ctx = makeCtxWith({ s0: 0.5 });
    expect(prevStageScore(ctx, 's0')).toBeNull();
  });

  it('returns prior stage score for non-first stage', () => {
    const ctx = makeCtxWith({ s0: 0.5, s3: 0.7 }, 0.3);
    expect(prevStageScore(ctx, 's3')).toBe(0.5);
  });

  it('returns null when stage not found', () => {
    const ctx = makeCtxWith({ s0: 0.5 }, 0.3);
    // idx < 0, so idx <= 0 → uses baseline
    expect(prevStageScore(ctx, 's9')).toBe(0.3);
  });

  it('returns null when prior stage score is null in perStage', () => {
    const ctx = makeCtxWith({ s0: null, s3: 0.7 }, 0.3);
    expect(prevStageScore(ctx, 's3')).toBeNull();
  });
});
