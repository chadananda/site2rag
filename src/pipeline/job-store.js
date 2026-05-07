// Persistent job queue for the pipeline HTTP service. One DB, separate from site DBs and analytics.
// Exports: openJobStore, JobStore. Deps: better-sqlite3

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

const SCHEMA = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  submitted_at  TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  pdf_path      TEXT NOT NULL,
  source_url    TEXT,
  meta          TEXT,   -- JSON
  config        TEXT,   -- JSON
  importance    INTEGER DEFAULT 1,
  progress      TEXT,   -- JSON: { stage, page, total_pages }
  error         TEXT,
  md_path       TEXT,
  pdf_out_path  TEXT,
  receipt       TEXT    -- JSON receipt from ctx.toReceipt()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_submitted   ON jobs(submitted_at);
`;

export class JobStore {
  constructor(db) { this.db = db; this._closed = false; }

  /** Create a new pending job. Returns the generated job id. */
  create({ pdfPath, sourceUrl, meta, config, importance = 1 }) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO jobs
      (id, submitted_at, pdf_path, source_url, meta, config, importance)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, iso(), pdfPath, sourceUrl ?? null,
        meta   ? JSON.stringify(meta)   : null,
        config ? JSON.stringify(config) : null,
        importance);
    return id;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? parseJobRow(row) : null;
  }

  /** Next pending job: highest importance first, then oldest submitted. */
  nextPending() {
    const row = this.db.prepare(
      "SELECT * FROM jobs WHERE status='pending' ORDER BY importance DESC, submitted_at ASC LIMIT 1"
    ).get();
    return row ? parseJobRow(row) : null;
  }

  setProcessing(id) {
    this.db.prepare("UPDATE jobs SET status='processing', started_at=? WHERE id=?")
      .run(iso(), id);
  }

  setProgress(id, progress) {
    this.db.prepare('UPDATE jobs SET progress=? WHERE id=?')
      .run(JSON.stringify(progress), id);
  }

  getProgress(id) {
    const row = this.db.prepare('SELECT progress FROM jobs WHERE id=?').get(id);
    return row?.progress ? JSON.parse(row.progress) : null;
  }

  setDone(id, { mdPath, pdfOutPath, receipt }) {
    this.db.prepare(
      "UPDATE jobs SET status='done', finished_at=?, md_path=?, pdf_out_path=?, receipt=? WHERE id=?"
    ).run(iso(), mdPath ?? null, pdfOutPath ?? null,
      receipt ? JSON.stringify(receipt) : null, id);
  }

  setFailed(id, error) {
    this.db.prepare("UPDATE jobs SET status='failed', finished_at=?, error=? WHERE id=?")
      .run(iso(), String(error).slice(0, 500), id);
  }

  delete(id) {
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
  }

  /** Reset jobs stuck in 'processing' that started before a given ISO timestamp. Returns count.
   *  Pass the server start time so only orphaned jobs from previous instances are reset. */
  resetStuck(beforeIso) {
    const sql = beforeIso
      ? "UPDATE jobs SET status='pending', started_at=NULL, progress=NULL WHERE status='processing' AND (started_at IS NULL OR started_at < ?)"
      : "UPDATE jobs SET status='pending', started_at=NULL, progress=NULL WHERE status='processing'";
    return (beforeIso ? this.db.prepare(sql).run(beforeIso) : this.db.prepare(sql).run()).changes;
  }

  /** Number of pending + processing jobs. */
  queueDepth() {
    return this.db.prepare(
      "SELECT COUNT(*) as n FROM jobs WHERE status IN ('pending','processing')"
    ).get()?.n ?? 0;
  }

  close() { this._closed = true; this.db.close(); }
  /** Guard: returns true if DB is closed. Use to skip writes after server teardown. */
  isClosed() { return this._closed; }
}

export async function openJobStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return new JobStore(db);
}

const iso = () => new Date().toISOString();

export function parseJobRow(row) {
  return {
    ...row,
    meta:     row.meta     ? JSON.parse(row.meta)     : {},
    config:   row.config   ? JSON.parse(row.config)   : {},
    progress: row.progress ? JSON.parse(row.progress) : null,
    receipt:  row.receipt  ? JSON.parse(row.receipt)  : null,
  };
}
