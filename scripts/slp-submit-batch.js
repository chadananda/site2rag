// Controlled one-shot SLP submitter. Submits the N smallest low-score, unprocessed PDFs for a site
// and records their job_ids; the report-server poller finishes them. Submits N and EXITS — no loop,
// so it cannot become a runaway. Usage: node scripts/slp-submit-batch.js [domain] [count] [scoreMax]
import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { PipelineClient } from '../src/slp-client.js';

const DOMAIN   = process.argv[2] || 'bahai-library.com';
const N        = parseInt(process.argv[3] || '5', 10);
const SCORE_MAX = parseFloat(process.argv[4] || '30');
if (!process.env.SLP_API_URL) { console.error('SLP_API_URL not set'); process.exit(1); }

const dbp = `${process.env.SITE2RAG_ROOT}/websites_mirror/${DOMAIN}/_meta/site.sqlite`;
const db = new Database(dbp);
// Low-score PDFs on disk that are not already done or in-flight.
const rows = db.prepare(`
  SELECT q.url, p.local_path, q.composite_score
  FROM pdf_quality q JOIN pages p ON p.url = q.url
  LEFT JOIN pdf_upgrade_queue u ON u.url = q.url
  WHERE q.composite_score < ? AND p.local_path IS NOT NULL AND p.gone = 0
    AND (u.status IS NULL OR u.status NOT IN ('done','submitted'))
`).all(SCORE_MAX);

const sized = [];
for (const r of rows) { try { sized.push({ ...r, sz: statSync(r.local_path).size }); } catch {} }
sized.sort((a, b) => a.sz - b.sz);                       // smallest first
const batch = sized.slice(0, N);

const c = new PipelineClient({ baseUrl: process.env.SLP_API_URL, apiKey: process.env.SLP_API_KEY });
console.log(`[slp-batch] ${DOMAIN}: ${sized.length} candidates, submitting ${batch.length}`);
for (const d of batch) {
  const now = new Date().toISOString();
  const ex = db.prepare('SELECT url FROM pdf_upgrade_queue WHERE url=?').get(d.url);
  if (ex) db.prepare("UPDATE pdf_upgrade_queue SET status='pending',priority=999,started_at=NULL,finished_at=NULL,error=NULL,requested_method='ocr',importance=999,queued_at=?,pipeline_job_id=NULL WHERE url=?").run(now, d.url);
  else    db.prepare("INSERT INTO pdf_upgrade_queue (url,priority,status,requested_method,importance,queued_at) VALUES (?,999,'pending','ocr',999,?)").run(d.url, now);
  try {
    const jobId = await c.submitJob({ pdfPath: d.local_path, filename: d.url.split('/').pop(), meta: { source_url: d.url } });
    db.prepare("UPDATE pdf_upgrade_queue SET status='submitted',started_at=?,pipeline_job_id=?,before_score=COALESCE(before_score,?) WHERE url=?").run(new Date().toISOString(), jobId, d.composite_score, d.url);
    console.log(`  submitted ${(d.sz/1024).toFixed(0).padStart(4)}KB  ${d.url.split('/').pop().slice(0,55).padEnd(55)} -> ${jobId}`);
  } catch (e) {
    db.prepare("DELETE FROM pdf_upgrade_queue WHERE url=? AND status NOT IN ('done')").run(d.url);
    console.log(`  FAILED ${d.url.split('/').pop()}: ${e.message}`);
  }
}
db.close();
