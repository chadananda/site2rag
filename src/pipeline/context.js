// Pipeline execution context. Carries document state, per-stage metrics, and decisions through the pipeline.
// Exports: PipelineContext, PIPELINE_VERSION
import { performance } from 'perf_hooks';

export const PIPELINE_VERSION = '1.0.0';

export class PipelineContext {
  constructor({ docId, sourcePath, sourceUrl = null, importance = 1, config = {}, meta = {} } = {}) {
    if (!docId) throw new Error('docId required');
    if (!sourcePath) throw new Error('sourcePath required');

    this.docId = docId;
    this.sourcePath = sourcePath;
    this.sourceUrl = sourceUrl;
    this.importance = Math.max(0, Math.min(5, importance));
    this.config = config;
    this.meta = meta;  // {title, authors, language, ...} from existing metadata extraction

    this.pageCount = 0;
    this.domain = null;  // set by detectDomain in s0: {subject, subdomains, era, script_context, confidence, source, prompt_context}
    // Per-page state: [{pageNo, words:[{text,x1,y1,x2,y2,conf,source}], regions:[], quality:{}}]
    this.pages = [];

    this.quality = {
      baseline: null,   // set by s0
      perStage: {},     // stageName -> composite score after that stage
      final: null,      // set at end of pipeline
    };

    this.metrics = {
      stages: [],       // stage run records
      errors: [],       // recoverable errors (non-fatal)
      decisions: [],    // routing/strategy decisions (the audit trail for self-improvement)
    };

    this.outputs = {
      archivalPdfPath: null,
      mdPath: null,
      receiptPath: null,
    };

    this._stageStart = null;
    this._currentStage = null;
  }

  // --- Stage lifecycle ---

  beginStage(name) {
    this._stageStart = performance.now();
    this._currentStage = name;
  }

  endStage(name, extra = {}) {
    const duration_ms = Math.round(performance.now() - (this._stageStart ?? performance.now()));
    this.metrics.stages.push({
      stage: name,
      version: extra.version ?? null,
      duration_ms,
      pages_affected: extra.pages_affected ?? 0,
      tokens_in: extra.tokens_in ?? 0,
      tokens_out: extra.tokens_out ?? 0,
      cost_usd: extra.cost_usd ?? 0,
      approach: extra.approach ?? null,
      notes: extra.notes ?? null,
    });
  }

  // --- Decisions (the self-improvement audit trail) ---
  // Every routing choice is logged so historical data can answer:
  // "did this decision improve quality?" and "how much did it cost?"

  addDecision(stage, decision, reason, value = null) {
    this.metrics.decisions.push({ stage, decision, reason, value, ts: Date.now() });
  }

  addError(stage, err, recoverable = true) {
    this.metrics.errors.push({ stage, error: err?.message ?? String(err), recoverable });
  }

  // --- Quality tracking ---

  setBaseline(scoreObj) {
    this.quality.baseline = scoreObj;
    // Mirror into perStage so deltas are computable
    this.quality.perStage['s0'] = scoreObj.composite_score ?? null;
  }

  recordStageQuality(stage, compositeScore) {
    this.quality.perStage[stage] = compositeScore;
  }

  qualityDelta(fromStage, toStage) {
    const from = this.quality.perStage[fromStage] ?? null;
    const to = this.quality.perStage[toStage] ?? null;
    if (from === null || to === null) return null;
    return to - from;
  }

  // --- Receipt ---

  toReceipt() {
    const totals = this.metrics.stages.reduce((acc, s) => {
      acc.cost_usd += s.cost_usd ?? 0;
      acc.tokens_in += s.tokens_in ?? 0;
      acc.tokens_out += s.tokens_out ?? 0;
      acc.duration_ms += s.duration_ms ?? 0;
      return acc;
    }, { cost_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 });

    const qualityGain = (this.quality.final ?? 0) - (this.quality.baseline?.composite_score ?? 0);
    const costPerQualityPoint = totals.cost_usd > 0 && qualityGain > 0
      ? totals.cost_usd / qualityGain
      : null;

    return {
      doc_id: this.docId,
      source_url: this.sourceUrl,
      processed_at: new Date().toISOString(),
      pipeline_version: PIPELINE_VERSION,
      importance: this.importance,
      page_count: this.pageCount,
      quality: {
        baseline: this.quality.baseline,
        per_stage: this.quality.perStage,
        final: this.quality.final,
        gain: qualityGain,
        cost_per_quality_point: costPerQualityPoint,
      },
      stages: this.metrics.stages,
      errors: this.metrics.errors,
      decisions: this.metrics.decisions,
      totals,
      outputs: this.outputs,
      assessment: _buildAssessment(this, qualityGain),
      suggestions: _buildSuggestions(this, totals, qualityGain),
    };
  }

  // Serialise/restore — allows resuming a pipeline after a crash
  toJSON() {
    return {
      docId: this.docId, sourcePath: this.sourcePath, sourceUrl: this.sourceUrl,
      importance: this.importance, config: this.config, meta: this.meta,
      pageCount: this.pageCount, pages: this.pages, domain: this.domain,
      quality: this.quality, metrics: this.metrics, outputs: this.outputs,
    };
  }

  static fromJSON(data, config = {}) {
    const ctx = new PipelineContext({ ...data, config: data.config ?? config });
    Object.assign(ctx, { pageCount: data.pageCount, pages: data.pages ?? [],
      domain: data.domain ?? null, quality: data.quality,
      metrics: data.metrics, outputs: data.outputs });
    return ctx;
  }
}

// --- Receipt helpers (not exported — internal to toReceipt) ---

const STAGE_LABELS = { s1: 'normalize', s3: 'OCR', s4: 'escalate', s5: 'vision', s6: 'spell-fix', s7: 'archive', s8: 'export' };

function _buildAssessment(ctx, qualityGain) {
  const baseline = ctx.quality.baseline ?? {};
  const ranStages = ctx.metrics.stages
    .filter(s => !s.notes?.startsWith('skip') && STAGE_LABELS[s.stage])
    .map(s => STAGE_LABELS[s.stage]);

  const docType = baseline.has_text_layer ? 'text_pdf' : 'image_pdf';
  const correctionSummary = ranStages.length
    ? ranStages.join(' → ')
    : 'no processing stages ran';

  return {
    doc_type: docType,
    correction_summary: correctionSummary,
    domain_context: ctx.domain?.subject ?? null,
    quality_gain_pct: qualityGain > 0 ? Math.round(qualityGain * 100) : 0,
    gs_normalized: ctx._gsNormalized ?? false,
  };
}

function _buildSuggestions(ctx, totals, qualityGain) {
  const suggestions = [];
  const baseline = ctx.quality.baseline ?? {};
  const threshold = ctx.config.thresholds?.goodDoc ?? 0.75;
  const baseScore = baseline.composite_score ?? 0;

  if (ctx._gsNormalized) {
    suggestions.push({ category: 'normalization', priority: 'medium',
      suggestion: 'pdf_has_nonconformant_jpeg2000 — gs normalize was required' });
  }

  if (totals.cost_usd > 0.02 && qualityGain < 0.05) {
    suggestions.push({ category: 'cost_efficiency', priority: totals.cost_usd > 0.10 ? 'high' : 'medium',
      suggestion: 'high_cost_low_quality_gain',
      detail: { cost_usd: +totals.cost_usd.toFixed(4), quality_gain: +qualityGain.toFixed(3) } });
  }

  if (Math.abs(baseScore - threshold) < 0.05) {
    suggestions.push({ category: 'threshold', priority: 'low',
      suggestion: 'composite_score_near_goodDoc_threshold — consider adjusting',
      detail: { score: +baseScore.toFixed(3), threshold } });
  }

  for (const s of ctx.metrics.stages) {
    if (!['s1', 's3', 's5', 's6'].includes(s.stage)) continue;
    const scores = ctx.quality.perStage;
    const keys = Object.keys(scores);
    const idx = keys.indexOf(s.stage);
    if (idx < 0 || scores[s.stage] == null) continue;
    const prev = idx === 0 ? baseScore : (scores[keys[idx - 1]] ?? null);
    if (prev === null) continue;
    const delta = scores[s.stage] - prev;
    if (delta <= 0 && (s.cost_usd ?? 0) > 0.001) {
      suggestions.push({ category: 'stage_value', priority: 'low',
        suggestion: `${s.stage} ran with no quality improvement`,
        detail: { stage: s.stage, quality_delta: +delta.toFixed(3), cost_usd: +(s.cost_usd ?? 0).toFixed(4) } });
    }
  }

  if ((ctx.domain?.source ?? '') === 'haiku_thin_signals') {
    suggestions.push({ category: 'model_config', priority: 'low',
      suggestion: 'domain detected via Haiku on thin signals — provide richer caller context' });
  }

  return suggestions;
}
