// Post-run improvement analysis. Heuristic rules over pipeline metrics → suggestion records.
// Exports: analyzeRun, reviewSuggestions. Deps: analytics.js (db handle)
//
// Runs after every completed pipeline doc. No LLM per doc — pure numeric signal analysis.
// Periodic human review digest: reviewSuggestions() queries accumulated suggestions.
//
// Suggestion categories:
//   normalization   — PDF required gs repair (track frequency per host)
//   cost_efficiency — high cost relative to quality gain
//   threshold       — composite score threshold appears mis-tuned for this doc population
//   stage_value     — a stage ran but contributed zero quality delta
//   model_config    — evidence that a different model/approach might perform better
//   preprocessing   — a specific preprocessing winner dominates; could become default

/** Analyze a completed run and write suggestions to the open analytics db. */
export function analyzeRun(ctx, db) {
  const receipt = ctx.toReceipt();
  const domain  = ctx.domain ?? {};
  const baseline = ctx.quality.baseline ?? {};
  const totals  = receipt.totals;
  const stages  = ctx.metrics.stages;
  const runId   = db.prepare('SELECT run_id FROM pipeline_runs ORDER BY rowid DESC LIMIT 1').get()?.run_id;
  if (!runId) return;

  const insert = db.prepare(`INSERT INTO improvement_suggestions
    (run_id, ts, category, signal, suggestion, evidence, priority, site_host, domain_subject)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const host    = safeHost(ctx.sourceUrl);
  const subject = domain.subject ?? 'unknown';

  // --- NORMALIZATION: gs repair needed ---
  if (ctx._gsNormalized) {
    insert.run(runId, now(), 'normalization', 'gs_normalized',
      'pdf_has_nonconformant_jpeg2000',
      JSON.stringify({ page_count: ctx.pageCount ?? null }),
      'medium', host, subject);
  }

  // --- COST EFFICIENCY: high spend, low gain ---
  const qualityGain = receipt.quality?.gain ?? 0;
  if (totals.cost_usd > 0.02 && qualityGain < 0.05) {
    insert.run(runId, now(), 'cost_efficiency', 'cost_usd',
      'high_cost_low_quality_gain',
      JSON.stringify({ cost_usd: totals.cost_usd, quality_gain: qualityGain }),
      totals.cost_usd > 0.10 ? 'high' : 'medium', host, subject);
  }

  // --- THRESHOLD: doc was near the goodDoc threshold, consider tuning ---
  const baseScore = baseline.composite_score ?? 0;
  const threshold = ctx.config.thresholds?.goodDoc ?? 0.75;
  if (Math.abs(baseScore - threshold) < 0.05) {
    insert.run(runId, now(), 'threshold', 'composite_score_near_threshold',
      'consider_adjusting_goodDoc_threshold',
      JSON.stringify({ composite: baseScore, threshold, gap: baseScore - threshold }),
      'low', host, subject);
  }

  // --- STAGE VALUE: stage ran but added no measurable quality delta ---
  for (const s of stages) {
    if (!['s1','s3','s5','s6'].includes(s.stage)) continue;  // only value-add stages
    const delta = perStageDelta(ctx, s.stage);
    if (delta !== null && delta <= 0 && s.cost_usd > 0.001) {
      insert.run(runId, now(), 'stage_value', `${s.stage}_zero_delta`,
        'stage_ran_with_no_quality_improvement',
        JSON.stringify({ stage: s.stage, quality_delta: delta, cost_usd: s.cost_usd }),
        'low', host, subject);
    }
  }

  // --- MODEL CONFIG: domain-detect fell back to Haiku on thin signals (expensive) ---
  const domainSource = domain.source ?? '';
  if (domainSource === 'haiku_thin_signals') {
    insert.run(runId, now(), 'model_config', 'haiku_thin_signals',
      'provide_richer_caller_context_to_reduce_haiku_calls',
      JSON.stringify({ domain_confidence: domain.confidence, source: domainSource }),
      'low', host, subject);
  }
}

/**
 * Query accumulated suggestions for human review.
 * Returns a summary object suitable for printing or Haiku digest.
 *
 * @param {object} db - open analytics db (better-sqlite3 instance)
 * @param {object} [opts]
 * @param {number} [opts.sinceDays=30]   - look-back window
 * @param {boolean} [opts.unreviewed=true] - only unreviewed suggestions
 */
export function reviewSuggestions(db, { sinceDays = 30, unreviewed = true } = {}) {
  const sinceTs = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const where   = unreviewed ? 'AND reviewed=0' : '';

  const suggestions = db.prepare(`
    SELECT category, suggestion, signal, priority, site_host, domain_subject,
           COUNT(*) as count, MIN(ts) as first_seen, MAX(ts) as last_seen
    FROM improvement_suggestions
    WHERE ts >= ? ${where}
    GROUP BY category, suggestion, site_host
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, count DESC
  `).all(sinceTs);

  const runStats = db.prepare(`
    SELECT COUNT(*) as total_runs,
           ROUND(AVG(quality_gain),3) as avg_quality_gain,
           ROUND(AVG(total_cost_usd),4) as avg_cost,
           ROUND(AVG(baseline_score),3) as avg_baseline
    FROM pipeline_runs WHERE ts >= ?
  `).get(sinceTs);

  const stageStats = db.prepare(`
    SELECT stage, ROUND(AVG(quality_delta),3) as avg_delta,
           ROUND(AVG(cost_usd),4) as avg_cost, COUNT(*) as runs
    FROM stage_metrics
    WHERE run_id IN (SELECT run_id FROM pipeline_runs WHERE ts >= ?)
    GROUP BY stage ORDER BY stage
  `).all(sinceTs);

  const normFreq = db.prepare(`
    SELECT site_host, COUNT(*) as count
    FROM improvement_suggestions
    WHERE category='normalization' AND ts >= ? ${where}
    GROUP BY site_host ORDER BY count DESC LIMIT 10
  `).all(sinceTs);

  return { suggestions, runStats, stageStats, normFreq, since: sinceTs };
}

/** Mark suggestions as reviewed. */
export function markReviewed(db, ids) {
  db.prepare(`UPDATE improvement_suggestions SET reviewed=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

// --- helpers ---

function now() { return new Date().toISOString(); }

function safeHost(url) {
  try { return new URL(url?.startsWith('http') ? url : 'https://x').hostname.replace(/^www\./, ''); }
  catch { return null; }
}

export function perStageDelta(ctx, stageName) {
  const scores = ctx.quality.perStage;
  const keys = Object.keys(scores);
  const idx = keys.indexOf(stageName);
  if (idx < 0 || scores[stageName] == null) return null;
  const prev = idx === 0 ? (ctx.quality.baseline?.composite_score ?? null) : scores[keys[idx - 1]];
  if (prev == null) return null;
  return scores[stageName] - prev;
}
