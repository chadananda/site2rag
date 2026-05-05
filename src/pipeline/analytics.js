// Privacy-safe internal analytics. Logs metrics only — never document content.
// Exports: writeAnalytics, openAnalyticsDb, ANALYTICS_SCHEMA. Deps: better-sqlite3, improve.js
//
// Privacy contract:
//   LOGGED:   numeric metrics, stage names, error codes, domain signals, site host
//   NEVER:    document text, file paths, URLs, titles, error message strings, doc_id
//   run_id:   one-way hash of (docId + timestamp) — opaque, unrecoverable

import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { analyzeRun } from './improve.js';

export const ANALYTICS_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id          TEXT PRIMARY KEY,
  pipeline_version TEXT NOT NULL,
  ts              TEXT NOT NULL,
  importance      INTEGER,
  page_count      INTEGER,
  doc_type        TEXT,     -- 'text_pdf'|'image_pdf'|'mixed'|'unknown'
  script          TEXT,     -- 'latin'|'arabic'|'persian'|'mixed'|'unknown'
  domain_subject  TEXT,
  domain_subdomains TEXT,   -- JSON array (no PII)
  domain_confidence REAL,
  domain_source   TEXT,     -- 'site_profile'|'pattern_match'|'haiku_inferred'
  site_host       TEXT,     -- public hostname only (not full URL)
  baseline_score  REAL,
  final_score     REAL,
  quality_gain    REAL,
  total_cost_usd  REAL,
  total_tokens_in  INTEGER,
  total_tokens_out INTEGER,
  cost_per_quality_point REAL,
  stages_run      TEXT,     -- JSON array
  stages_skipped  TEXT,     -- JSON array
  error_count     INTEGER,
  fatal_error_count INTEGER,
  preprocessing_winner TEXT,
  duration_ms     INTEGER
);

CREATE TABLE IF NOT EXISTS stage_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage           TEXT NOT NULL,
  approach        TEXT,
  version         TEXT,
  pages_affected  INTEGER,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,
  duration_ms     INTEGER,
  quality_before  REAL,
  quality_after   REAL,
  quality_delta   REAL,
  notes_code      TEXT      -- structured code only ('stub'|'early_exit'|'budget_stop'|etc)
);

CREATE TABLE IF NOT EXISTS page_confidence_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  page_no         INTEGER NOT NULL,
  conf_mean_before REAL,
  conf_mean_after  REAL,
  conf_p25        REAL,
  conf_p75        REAL,
  words_total     INTEGER,
  words_clean     INTEGER,
  words_fuzzy     INTEGER,
  words_dirty     INTEGER,
  words_fixed     INTEGER,
  words_escalated INTEGER,
  preprocessing_params TEXT  -- JSON: winning params, not content
);

CREATE TABLE IF NOT EXISTS decision_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage           TEXT NOT NULL,
  decision        TEXT NOT NULL,  -- routing decision code
  reason_code     TEXT,           -- first word of reason (structured part only)
  value           REAL,
  ts              INTEGER
);

CREATE TABLE IF NOT EXISTS error_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage           TEXT NOT NULL,
  error_code      TEXT NOT NULL,  -- classified code, never raw message
  recoverable     INTEGER,
  page_no         INTEGER         -- null for doc-level errors
);

CREATE TABLE IF NOT EXISTS domain_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_host       TEXT NOT NULL UNIQUE,
  doc_pattern     TEXT,
  subject         TEXT,
  subdomains      TEXT,     -- JSON array
  era             TEXT,
  script_context  TEXT,
  prompt_context  TEXT,
  confidence      REAL DEFAULT 0,
  doc_count       INTEGER DEFAULT 0,
  avg_quality_gain REAL DEFAULT 0,
  avg_cost_usd    REAL DEFAULT 0,
  source          TEXT,     -- 'manual'|'haiku_inferred'|'learned'
  last_updated    TEXT
);

CREATE INDEX IF NOT EXISTS idx_stage_metrics_run ON stage_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_decisions_run ON decision_log(run_id);
CREATE INDEX IF NOT EXISTS idx_errors_run ON error_log(run_id);
CREATE INDEX IF NOT EXISTS idx_page_conf_run ON page_confidence_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_ts ON pipeline_runs(ts);
CREATE INDEX IF NOT EXISTS idx_runs_host ON pipeline_runs(site_host);
CREATE INDEX IF NOT EXISTS idx_runs_domain ON pipeline_runs(domain_subject);

CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT REFERENCES pipeline_runs(run_id),
  ts              TEXT NOT NULL,
  category        TEXT NOT NULL,   -- 'normalization'|'cost_efficiency'|'threshold'|'stage_value'|'model_config'|'preprocessing'
  signal          TEXT NOT NULL,   -- metric that triggered this
  suggestion      TEXT NOT NULL,   -- structured suggestion code
  evidence        TEXT,            -- JSON: numeric evidence only (no content/paths)
  priority        TEXT DEFAULT 'low',  -- 'low'|'medium'|'high'
  reviewed        INTEGER DEFAULT 0,
  site_host       TEXT,
  domain_subject  TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestions_ts ON improvement_suggestions(ts);
CREATE INDEX IF NOT EXISTS idx_suggestions_reviewed ON improvement_suggestions(reviewed);
CREATE INDEX IF NOT EXISTS idx_suggestions_category ON improvement_suggestions(category);
`;

/** Open (or create) the analytics SQLite database. Returns a better-sqlite3 instance. */
export async function openAnalyticsDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(ANALYTICS_SCHEMA);
  return db;
}

/**
 * Write a completed pipeline context to the analytics DB.
 * Privacy-safe: strips all content, paths, and raw error messages.
 */
export async function writeAnalytics(ctx, dbPath) {
  if (!dbPath) return;

  let db;
  try {
    db = await openAnalyticsDb(dbPath);
    const run_id = makeRunId(ctx);
    const receipt = ctx.toReceipt();
    const totals = receipt.totals;

    const host = safeHost(ctx.sourceUrl);
    const domain = ctx.domain ?? {};
    const stagesRun = ctx.metrics.stages.map(s => s.stage);
    const stagesSkipped = (ctx.config.skip ?? []);
    const fatalErrors = ctx.metrics.errors.filter(e => !e.recoverable);

    // Classify doc type from baseline signals
    const baseline = ctx.quality.baseline ?? {};
    const docType = classifyDocType(baseline);

    db.prepare(`INSERT OR REPLACE INTO pipeline_runs
      (run_id, pipeline_version, ts, importance, page_count, doc_type, script,
       domain_subject, domain_subdomains, domain_confidence, domain_source, site_host,
       baseline_score, final_score, quality_gain, total_cost_usd, total_tokens_in,
       total_tokens_out, cost_per_quality_point, stages_run, stages_skipped,
       error_count, fatal_error_count, preprocessing_winner, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run_id,
      receipt.pipeline_version,
      new Date().toISOString(),
      ctx.importance,
      ctx.pageCount,
      docType,
      domain.script_context?.split(' ')[0]?.toLowerCase() ?? 'unknown',
      domain.subject ?? null,
      domain.subdomains ? JSON.stringify(domain.subdomains) : null,
      domain.confidence ?? null,
      domain.source ?? null,
      host,
      baseline.composite_score ?? null,
      ctx.quality.final ?? null,
      receipt.quality.gain ?? null,
      totals.cost_usd,
      totals.tokens_in,
      totals.tokens_out,
      receipt.quality.cost_per_quality_point ?? null,
      JSON.stringify(stagesRun),
      JSON.stringify(stagesSkipped),
      ctx.metrics.errors.length,
      fatalErrors.length,
      domain.preprocessing_winner ?? null,
      totals.duration_ms,
    );

    // Per-stage metrics
    const stageInsert = db.prepare(`INSERT INTO stage_metrics
      (run_id,stage,approach,version,pages_affected,tokens_in,tokens_out,cost_usd,
       duration_ms,quality_before,quality_after,quality_delta,notes_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (const s of ctx.metrics.stages) {
      const prev = prevStageScore(ctx, s.stage);
      const after = ctx.quality.perStage[s.stage] ?? null;
      stageInsert.run(
        run_id, s.stage, s.approach, s.version, s.pages_affected,
        s.tokens_in, s.tokens_out, s.cost_usd, s.duration_ms,
        prev, after, after !== null && prev !== null ? after - prev : null,
        extractNotesCode(s.notes),
      );
    }

    // Decision log — extract reason_code (first token, drop free text)
    const decInsert = db.prepare(`INSERT INTO decision_log (run_id,stage,decision,reason_code,value,ts) VALUES (?,?,?,?,?,?)`);
    for (const d of ctx.metrics.decisions) {
      decInsert.run(run_id, d.stage, d.decision, extractReasonCode(d.reason), d.value, d.ts);
    }

    // Error log — classify errors by code, discard raw message
    const errInsert = db.prepare(`INSERT INTO error_log (run_id,stage,error_code,recoverable,page_no) VALUES (?,?,?,?,?)`);
    for (const e of ctx.metrics.errors) {
      errInsert.run(run_id, e.stage, classifyError(e.error), e.recoverable ? 1 : 0, e.page_no ?? null);
    }

    // Update domain_profiles with running averages
    if (host && domain.subject && domain.confidence > 0.6) {
      updateDomainProfile(db, host, domain, receipt.quality.gain ?? 0, totals.cost_usd);
    }

    // Heuristic improvement analysis — write any triggered suggestions to DB
    analyzeRun(ctx, db);

  } catch (err) {
    // Analytics failure must never crash the pipeline
    console.warn(`[analytics] write failed: ${err.message}`);
  } finally {
    db?.close();
  }
}

// --- Private helpers ---

function makeRunId(ctx) {
  return createHash('sha256')
    .update(ctx.docId + String(Date.now()))
    .digest('hex')
    .slice(0, 16);
}

function safeHost(url) {
  try {
    return new URL(url?.startsWith('http') ? url : 'https://unknown.invalid').hostname.replace(/^www\./, '');
  } catch { return null; }
}

function classifyDocType(baseline) {
  if (!baseline.has_text_layer) return 'unknown';
  if (baseline.has_text_layer === 1 && baseline.readable_pages_pct > 0.7) return 'text_pdf';
  if (baseline.has_text_layer === 0) return 'image_pdf';
  return 'mixed';
}

/** Get quality score from the stage immediately before the given stage. */
function prevStageScore(ctx, stageName) {
  const stages = Object.keys(ctx.quality.perStage);
  const idx = stages.indexOf(stageName);
  if (idx <= 0) return ctx.quality.baseline?.composite_score ?? null;
  return ctx.quality.perStage[stages[idx - 1]] ?? null;
}

/** Extract structured code from notes string. Returns first colon-delimited token or null. */
function extractNotesCode(notes) {
  if (!notes) return null;
  const code = notes.split(':')[0].trim().toLowerCase().replace(/\s+/g, '_');
  return code.length <= 32 ? code : code.slice(0, 32);
}

/** Extract reason code (first alphanumeric token). Discards free text. */
function extractReasonCode(reason) {
  if (!reason) return null;
  const match = String(reason).match(/^[\w.-]+/);
  return match?.[0]?.slice(0, 32) ?? null;
}

/** Map raw error messages to structured codes without logging content. */
function classifyError(message) {
  const m = String(message ?? '').toLowerCase();
  if (m.includes('not found') || m.includes('enoent') || m.includes('no such file')) return 'file_not_found';
  if (m.includes('timeout')) return 'timeout';
  if (m.includes('truncated') || m.includes('corrupt')) return 'corrupted_input';
  if (m.includes('api') || m.includes('network') || m.includes('fetch')) return 'api_error';
  if (m.includes('budget') || m.includes('token')) return 'budget_exceeded';
  if (m.includes('parse') || m.includes('json')) return 'parse_error';
  if (m.includes('permission') || m.includes('access')) return 'permission_error';
  return 'unknown_error';
}

function updateDomainProfile(db, host, domain, qualityGain, costUsd) {
  const existing = db.prepare('SELECT * FROM domain_profiles WHERE site_host=?').get(host);
  if (!existing) {
    db.prepare(`INSERT INTO domain_profiles
      (site_host,subject,subdomains,era,script_context,prompt_context,confidence,
       doc_count,avg_quality_gain,avg_cost_usd,source,last_updated)
      VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`).run(
      host, domain.subject, JSON.stringify(domain.subdomains ?? []),
      domain.era, domain.script_context, domain.prompt_context,
      domain.confidence, qualityGain, costUsd,
      domain.source, new Date().toISOString()
    );
  } else {
    const n = existing.doc_count + 1;
    const avgGain = (existing.avg_quality_gain * existing.doc_count + qualityGain) / n;
    const avgCost = (existing.avg_cost_usd * existing.doc_count + costUsd) / n;
    const newConf = Math.min(0.95, existing.confidence * 0.7 + domain.confidence * 0.3);
    db.prepare(`UPDATE domain_profiles SET
      doc_count=?, avg_quality_gain=?, avg_cost_usd=?,
      confidence=?, last_updated=?, source=?
      WHERE site_host=?`).run(
      n, avgGain, avgCost, newConf, new Date().toISOString(),
      n > 5 ? 'learned' : existing.source, host
    );
  }
}
