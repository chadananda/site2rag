// SQLite results store for the pipeline optimizer test harness.
// Exports: ResultsDb
import Database from 'better-sqlite3';
import { join } from 'path';

export class ResultsDb {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        category TEXT,
        language TEXT,
        pages INTEGER,
        baseline_score REAL,
        final_score REAL,
        gain REAL,
        cost_usd REAL,
        duration_ms INTEGER,
        s3_lang TEXT,
        s3_contrast INTEGER,
        s3_pages_affected INTEGER,
        s5_pages_affected INTEGER,
        s6_pages_affected INTEGER,
        per_stage TEXT,
        errors TEXT,
        job_id TEXT,
        ran_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS page_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES runs(id),
        doc_id TEXT,
        page_no INTEGER,
        page_score REAL,
        vision_analysis TEXT,
        suggestions TEXT,
        analyzed_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS strategy_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        language TEXT,
        insight TEXT,
        confidence REAL,
        supporting_runs INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this._insertRun = this.db.prepare(`
      INSERT INTO runs (doc_id, variant_id, category, language, pages, baseline_score,
        final_score, gain, cost_usd, duration_ms, s3_lang, s3_contrast,
        s3_pages_affected, s5_pages_affected, s6_pages_affected, per_stage, errors, job_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this._insertAnalysis = this.db.prepare(`
      INSERT INTO page_analyses (run_id, doc_id, page_no, page_score, vision_analysis, suggestions)
      VALUES (?,?,?,?,?,?)
    `);
    this._insertInsight = this.db.prepare(`
      INSERT INTO strategy_insights (category, language, insight, confidence, supporting_runs)
      VALUES (?,?,?,?,?)
    `);
  }

  saveRun(doc, variant, result) {
    const r = result.receipt ?? {};
    const q = r.quality ?? {};
    const perStage = q.per_stage ?? {};
    const stages = r.stages ?? [];
    const s3 = stages.find(s => s.stage === 's3') ?? {};
    const s5 = stages.find(s => s.stage === 's5') ?? {};
    const s6 = stages.find(s => s.stage === 's6') ?? {};
    const errors = (r.errors ?? []).map(e => e.message ?? JSON.stringify(e)).join('; ');
    const finalScore = q.final ?? 0;
    const baselineScore = q.baseline?.composite_score ?? doc.baselineScore;
    const gain = finalScore - baselineScore;
    // Detect contrast enhancement from decisions
    const decisions = r.decisions ?? [];
    const contrastApplied = decisions.some(d => d.stage === 's3' && d.decision?.startsWith('contrast_'));

    const info = this._insertRun.run(
      doc.id, variant.id, doc.category, doc.language, doc.pages, doc.baselineScore,
      finalScore, gain, r.totals?.cost_usd ?? 0, r.totals?.duration_ms ?? 0,
      s3.notes ?? null, contrastApplied ? 1 : 0,
      s3.pages_affected ?? 0, s5.pages_affected ?? 0, s6.pages_affected ?? 0,
      JSON.stringify(perStage), errors || null, result.jobId ?? null
    );
    return info.lastInsertRowid;
  }

  savePageAnalysis(runId, docId, pageNo, pageScore, visionText, suggestions) {
    this._insertAnalysis.run(runId, docId, pageNo, pageScore, visionText,
      Array.isArray(suggestions) ? suggestions.join('; ') : suggestions);
  }

  saveInsight(category, language, insight, confidence, supportingRuns) {
    this._insertInsight.run(category, language, insight, confidence, supportingRuns);
  }

  /** Returns all runs for a given doc, sorted by final_score descending. */
  bestVariantsForDoc(docId) {
    return this.db.prepare(`
      SELECT * FROM runs WHERE doc_id=? ORDER BY final_score DESC
    `).all(docId);
  }

  /** Summary: best variant per category. */
  summarize() {
    return this.db.prepare(`
      SELECT category, language, variant_id,
        ROUND(AVG(final_score),3) as avg_score,
        ROUND(AVG(gain),3) as avg_gain,
        ROUND(AVG(cost_usd),4) as avg_cost,
        COUNT(*) as n
      FROM runs
      GROUP BY category, language, variant_id
      ORDER BY category, avg_score DESC
    `).all();
  }

  /** Return runs that scored below threshold for vision analysis. */
  poorRuns(threshold = 0.6) {
    return this.db.prepare(`
      SELECT r.*, COUNT(pa.id) as analyses_done
      FROM runs r
      LEFT JOIN page_analyses pa ON pa.run_id = r.id
      WHERE r.final_score < ?
      GROUP BY r.id
      HAVING analyses_done = 0
      ORDER BY r.final_score ASC
    `).all(threshold);
  }

  allInsights() {
    return this.db.prepare('SELECT * FROM strategy_insights ORDER BY confidence DESC').all();
  }
}
