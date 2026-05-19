// Recover completed pipeline jobs into site DB
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const PIPELINE_DB = '/tank/site2rag/pipeline-jobs.db';
const SITE_DB = '/tank/site2rag/websites_mirror/bahai-library.com/_meta/site.sqlite';

const pdb = new Database(PIPELINE_DB, { readonly: true });
const sdb = new Database(SITE_DB);

// Get all done bahai-library.com jobs from pipeline
const doneJobs = pdb.prepare(
  "SELECT id, source_url, pdf_out_path, receipt, finished_at FROM jobs WHERE status='done' AND source_url LIKE '%bahai-library%'"
).all();

console.log(`Found ${doneJobs.length} done pipeline jobs for bahai-library.com`);

const update = sdb.prepare(`
  UPDATE pdf_upgrade_queue 
  SET status='done', finished_at=?, upgraded_pdf_path=?, after_score=?, 
      score_improvement=?, pages_processed=?, method='pipeline-v2', pipeline_job_id=NULL
  WHERE url=? AND status IN ('pending','submitted','processing')
`);

let recovered = 0;
for (const job of doneJobs) {
  const receipt = JSON.parse(job.receipt || '{}');
  const beforeScore = sdb.prepare('SELECT before_score FROM pdf_upgrade_queue WHERE url=?').get(job.source_url)?.before_score;
  const afterScore = receipt.quality?.final ?? null;
  const gain = receipt.quality?.gain ?? null;
  const pages = receipt.page_count ?? null;
  
  const r = update.run(
    job.finished_at ?? new Date().toISOString(),
    job.pdf_out_path ?? null,
    afterScore,
    gain,
    pages,
    job.source_url
  );
  if (r.changes > 0) recovered++;
}

console.log(`Recovered ${recovered} jobs as done`);
pdb.close();
sdb.close();
