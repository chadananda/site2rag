// Billing log: records every service call cost (cloud + shadow-priced local) for invoice generation.
// Exports: recordBillingEntry, generateInvoice, getBillingReport, closeBillingDb
// SQLite table: billing_log — one row per service call; aggregate with generateInvoice/getBillingReport.
import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = process.env.BILLING_DB ?? join(process.env.HOME ?? '/tank', 'site2rag', 'billing.sqlite');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS billing_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT    NOT NULL DEFAULT (datetime('now')),
      job_id        TEXT    NOT NULL,
      customer_id   TEXT,
      stage         TEXT,
      service_id    TEXT    NOT NULL,
      tier          INTEGER NOT NULL DEFAULT 0,
      endpoint      TEXT,
      gpu           INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      tokens_in     INTEGER NOT NULL DEFAULT 0,
      tokens_out    INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      shadow_usd    REAL    NOT NULL DEFAULT 0,
      compute_units REAL    NOT NULL DEFAULT 0,
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS billing_log_job    ON billing_log(job_id);
    CREATE INDEX IF NOT EXISTS billing_log_cust   ON billing_log(customer_id);
    CREATE INDEX IF NOT EXISTS billing_log_ts     ON billing_log(ts);
  `);
  return _db;
}

/**
 * Record one billing line item. Call after every service invocation.
 * entry: { jobId, customerId?, stage?, serviceId, tier, endpoint, gpu, duration_ms,
 *           tokensIn?, tokensOut?, costUsd, shadowUsd, computeUnits?, notes? }
 */
export function recordBillingEntry(entry) {
  const db = getDb();
  db.prepare(`
    INSERT INTO billing_log
      (job_id, customer_id, stage, service_id, tier, endpoint, gpu, duration_ms,
       tokens_in, tokens_out, cost_usd, shadow_usd, compute_units, notes)
    VALUES (@jobId, @customerId, @stage, @serviceId, @tier, @endpoint, @gpu, @duration_ms,
            @tokensIn, @tokensOut, @costUsd, @shadowUsd, @computeUnits, @notes)
  `).run({
    jobId:        entry.jobId,
    customerId:   entry.customerId ?? null,
    stage:        entry.stage ?? null,
    serviceId:    entry.serviceId,
    tier:         entry.tier ?? 0,
    endpoint:     entry.endpoint ?? null,
    gpu:          entry.gpu ? 1 : 0,
    duration_ms:  entry.duration_ms ?? 0,
    tokensIn:     entry.tokensIn ?? 0,
    tokensOut:    entry.tokensOut ?? 0,
    costUsd:      entry.costUsd ?? 0,
    shadowUsd:    entry.shadowUsd ?? 0,
    computeUnits: entry.computeUnits ?? 0,
    notes:        entry.notes ?? null,
  });
}

/**
 * Aggregate all billing entries for a job into an invoice object.
 * Returns { jobId, customerId, lineItems[], totals: { cost_usd, shadow_usd, duration_ms } }
 */
export function generateInvoice(jobId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT stage, service_id, tier, gpu, duration_ms, tokens_in, tokens_out,
           cost_usd, shadow_usd, compute_units, ts
    FROM billing_log WHERE job_id = ? ORDER BY id
  `).all(jobId);

  const custRow = db.prepare('SELECT customer_id FROM billing_log WHERE job_id = ? LIMIT 1').get(jobId);

  const totals = rows.reduce((acc, r) => {
    acc.cost_usd      += r.cost_usd;
    acc.shadow_usd    += r.shadow_usd;
    acc.tokens_in     += r.tokens_in;
    acc.tokens_out    += r.tokens_out;
    acc.duration_ms   += r.duration_ms;
    acc.compute_units += r.compute_units;
    return acc;
  }, { cost_usd: 0, shadow_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0, compute_units: 0 });

  return {
    jobId,
    customerId: custRow?.customer_id ?? null,
    lineItems: rows.map(r => ({
      ts:           r.ts,
      stage:        r.stage,
      service:      r.service_id,
      tier:         r.tier,
      gpu:          !!r.gpu,
      duration_ms:  r.duration_ms,
      tokens_in:    r.tokens_in,
      tokens_out:   r.tokens_out,
      cost_usd:     +r.cost_usd.toFixed(6),
      shadow_usd:   +r.shadow_usd.toFixed(6),
    })),
    totals: {
      cost_usd:      +totals.cost_usd.toFixed(6),
      shadow_usd:    +totals.shadow_usd.toFixed(6),
      total_usd:     +(totals.cost_usd + totals.shadow_usd).toFixed(6),
      tokens_in:     totals.tokens_in,
      tokens_out:    totals.tokens_out,
      duration_ms:   totals.duration_ms,
      compute_units: +totals.compute_units.toFixed(4),
    },
  };
}

/**
 * Aggregate billing across all jobs for a customer.
 * dateRange: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (both optional)
 */
export function getBillingReport(customerId, dateRange = {}) {
  const db = getDb();
  const conditions = ['customer_id = ?'];
  const params = [customerId];
  if (dateRange.from) { conditions.push(ts ?); params.push(dateRange.from); }
  if (dateRange.to)   { conditions.push(ts ?); params.push(dateRange.to + ' 23:59:59'); }

  const rows = db.prepare(`
    SELECT job_id, SUM(cost_usd) as cost, SUM(shadow_usd) as shadow,
           SUM(tokens_in + tokens_out) as tokens, SUM(duration_ms) as ms,
           MIN(ts) as first_ts, MAX(ts) as last_ts
    FROM billing_log WHERE ${conditions.join(' AND ')}
    GROUP BY job_id ORDER BY first_ts DESC
  `).all(...params);

  const grandTotal = rows.reduce((a, r) => {
    a.cost += r.cost; a.shadow += r.shadow; a.tokens += r.tokens; return a;
  }, { cost: 0, shadow: 0, tokens: 0 });

  return {
    customerId,
    dateRange,
    jobs: rows.map(r => ({
      jobId: r.job_id,
      cost_usd: +r.cost.toFixed(6),
      shadow_usd: +r.shadow.toFixed(6),
      tokens: r.tokens,
      duration_ms: r.ms,
      period: { from: r.first_ts, to: r.last_ts },
    })),
    totals: {
      jobs: rows.length,
      cost_usd:   +grandTotal.cost.toFixed(4),
      shadow_usd: +grandTotal.shadow.toFixed(4),
      total_usd:  +(grandTotal.cost + grandTotal.shadow).toFixed(4),
      tokens:     grandTotal.tokens,
    },
  };
}

export function closeBillingDb() {
  if (_db) { _db.close(); _db = null; }
}
