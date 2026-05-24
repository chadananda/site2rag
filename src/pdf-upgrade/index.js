// PDF upgrade daemon: submit pending PDFs to SLP pipeline-server, poll for results.
// All processing is handled by the pipeline — no OCR, no Anthropic, no local engines.
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { loadConfig, getMirrorRoot, mirrorDir, mdDir } from '../config.js';
import { openDb, logLlmCall } from '../db.js';
import { PipelineClient } from '../pipeline/client.js';

const TICK_INTERVAL_MS = 60 * 1000;
const SUBMIT_CONCURRENCY = 16;

if (!process.env.PIPELINE_URL) {
  console.error('[pdf-upgrade] PIPELINE_URL is not set — exiting. Set it to the pipeline-server URL.');
  process.exit(1);
}

const pipelineClient = new PipelineClient({ baseUrl: process.env.PIPELINE_URL });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();
const log = (msg) => console.log(`[pdf-upgrade] ${now().slice(0, 19)} ${msg}`);
const safeHostname = (url) => { try { return new URL(url).hostname; } catch { return null; } };

const FOCUS_FILE = join(getMirrorRoot(), '.focused_domain');
const getFocusDomain = () => {
  try { const d = require('fs').readFileSync(FOCUS_FILE, 'utf8').trim(); return d || null; } catch { return null; }
};

const logUpgradeHistory = (db, url, { method, score_before, score_after, pages_processed, error }) => {
  const attempt = (db.prepare('SELECT COUNT(*)+1 as n FROM pdf_upgrade_history WHERE url=?').get(url)?.n) || 1;
  db.prepare(`INSERT INTO pdf_upgrade_history (url, attempt, method, score_before, score_after, pages_processed, finished_at, error) VALUES (?,?,?,?,?,?,?,?)`)
    .run(url, attempt, method ?? null, score_before ?? null, score_after ?? null, pages_processed ?? null, now(), error ?? null);
};

const ensurePipelineJobIdColumn = (db) => {
  try { db.exec('ALTER TABLE pdf_upgrade_queue ADD COLUMN pipeline_job_id TEXT'); } catch {}
};

/** Check all open DBs for a cached upgrade result with same content hash. */
const findCachedResult = (contentHash, currentDb, currentUrl, openDbs) => {
  if (!contentHash) return null;
  const localHit = currentDb.prepare(`
    SELECT upgraded_pdf_path, after_score, score_improvement, pages_processed, method, receipt_json
    FROM pdf_upgrade_queue
    WHERE content_hash=? AND url!=? AND status='done' AND upgraded_pdf_path IS NOT NULL
    LIMIT 1`).get(contentHash, currentUrl);
  if (localHit && existsSync(localHit.upgraded_pdf_path)) return localHit;
  for (const { db } of (openDbs || [])) {
    if (db === currentDb) continue;
    try {
      const hit = db.prepare(`
        SELECT upgraded_pdf_path, after_score, score_improvement, pages_processed, method, receipt_json
        FROM pdf_upgrade_queue
        WHERE content_hash=? AND status='done' AND upgraded_pdf_path IS NOT NULL
        LIMIT 1`).get(contentHash);
      if (hit && existsSync(hit.upgraded_pdf_path)) return hit;
    } catch {}
  }
  return null;
};

const applyDuplicateResult = async (db, url, donor, beforeScore) => {
  const existing = db.prepare('SELECT pipeline_job_id, status FROM pdf_upgrade_queue WHERE url=?').get(url);
  if (!existing || existing.status === 'done') return;
  if (existing.pipeline_job_id) {
    try { await pipelineClient.deleteJob(existing.pipeline_job_id); } catch {}
  }
  db.prepare(`UPDATE pdf_upgrade_queue
    SET status='done', finished_at=?, upgraded_pdf_path=?,
        after_score=?, score_improvement=?, pages_processed=?,
        method=?, receipt_json=?, pipeline_job_id=NULL
    WHERE url=?`)
    .run(now(), donor.upgraded_pdf_path,
      donor.after_score, donor.score_improvement,
      donor.pages_processed, (donor.method || 'pipeline-v2') + '+dedup',
      donor.receipt_json ?? null, url);
  if (donor.after_score != null)
    db.prepare('UPDATE pdf_quality SET composite_score=? WHERE url=?').run(donor.after_score, url);
  logUpgradeHistory(db, url, { method: (donor.method || 'pipeline-v2') + '+dedup',
    score_before: beforeScore, score_after: donor.after_score, pages_processed: donor.pages_processed });
  log(`Dedup: ${url.split('/').pop()} ← cached`);
};

/** Submit one pending doc to the pipeline-server. */
const submitViaPipeline = async (db, domain, row, page, siteConfig, openDbs = []) => {
  const cached = findCachedResult(row.content_hash, db, row.url, openDbs);
  if (cached) {
    await applyDuplicateResult(db, row.url, cached, row.before_score);
    return;
  }
  const quality = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get(row.url) ?? {};
  const isImagePdf = !quality.has_text_layer;
  const rawDiff = quality.processing_difficulty || null;
  const difficulty = isImagePdf ? Math.max(0.3, rawDiff ?? 0.5) : (rawDiff ?? 0.05);
  const importance = Math.max(1, Math.round((1 - difficulty) * 200));
  try {
    const jobId = await pipelineClient.submitJob({
      pdfPath:   page.local_path,
      sourceUrl: row.url,
      importance,
      meta: {
        title:           quality.pdf_title       || undefined,
        language:        quality.ai_language     || undefined,
        anchorText:      quality.anchor_text     || undefined,
        siteDescription: siteConfig?.description || undefined,
        contextHints:    quality.ai_summary      || undefined,
        keywords:        ['site2rag', domain],
      },
    });
    db.prepare("UPDATE pdf_upgrade_queue SET status='submitted', started_at=?, pipeline_job_id=?, before_score=? WHERE url=?")
      .run(now(), jobId, quality.composite_score ?? null, row.url);
    log(`Submitted: ${row.url.split('/').pop()}`);
  } catch (err) {
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(now(), err.message.slice(0, 300), row.url);
    log(`Submit failed: ${row.url.split('/').pop()}: ${err.message}`);
  }
};

/** Poll in-flight pipeline jobs and update site DB when done/failed. */
const checkPipelineJobs = async (db, domain, openDbs = []) => {
  const running = db.prepare(
    "SELECT url, pipeline_job_id, before_score, content_hash FROM pdf_upgrade_queue WHERE pipeline_job_id IS NOT NULL AND status NOT IN ('done','failed')"
  ).all();
  for (const { url, pipeline_job_id: jobId, before_score, content_hash } of running) {
    try {
      const job = await pipelineClient.getJob(jobId);
      if (job.status === 'done') {
        let receipt = job.receipt ?? {};
        try {
          const fullReceipt = await pipelineClient._get(`/jobs/${jobId}/receipt`);
          if (fullReceipt?.quality) receipt = fullReceipt;
        } catch {}
        const afterScore = receipt.quality?.final ?? null;

        const upgradedDir = join(mirrorDir(domain), '.upgraded');
        mkdirSync(upgradedDir, { recursive: true });
        const hash = sha256(url).slice(0, 16);
        const localPdfPath = join(upgradedDir, `x${hash}.pdf`);
        const localMdPath  = join(upgradedDir, `x${hash}.md`);
        let savedPdfPath = null;
        try {
          const pdfBuf = await pipelineClient.getPdf(jobId);
          writeFileSync(localPdfPath, pdfBuf);
          savedPdfPath = localPdfPath;
        } catch (dlErr) {
          log(`PDF download failed for ${jobId}: ${dlErr.message}`);
        }
        try {
          const md = await pipelineClient.getMarkdown(jobId);
          if (md?.trim()) writeFileSync(localMdPath, md);
        } catch {}

        db.prepare(`UPDATE pdf_upgrade_queue
          SET status='done', finished_at=?, upgraded_pdf_path=?,
              after_score=?, score_improvement=?, pages_processed=?, method=?, receipt_json=?, pipeline_job_id=NULL
          WHERE url=?`)
          .run(now(), savedPdfPath,
            afterScore, receipt.quality?.gain ?? null,
            receipt.document?.page_count ?? receipt.page_count ?? null,
            'pipeline-v2', JSON.stringify(receipt), url);
        logUpgradeHistory(db, url, { method: 'pipeline-v2', score_before: before_score,
          score_after: afterScore, pages_processed: receipt.document?.page_count ?? null });
        log(`Done: ${url.split('/').pop()}`);

        // Propagate to siblings with same content hash
        if (content_hash) {
          const donor = { upgraded_pdf_path: savedPdfPath, after_score: afterScore,
            score_improvement: receipt.quality?.gain ?? null,
            pages_processed: receipt.document?.page_count ?? null,
            method: 'pipeline-v2', receipt_json: JSON.stringify(receipt) };
          const sameSibs = db.prepare(`SELECT url, before_score FROM pdf_upgrade_queue WHERE content_hash=? AND url!=? AND status NOT IN ('done','failed') AND content_hash IS NOT NULL`).all(content_hash, url);
          for (const sib of sameSibs) await applyDuplicateResult(db, sib.url, donor, sib.before_score);
          for (const { db: otherDb } of openDbs) {
            if (otherDb === db) continue;
            try {
              const crossSibs = otherDb.prepare(`SELECT url, before_score FROM pdf_upgrade_queue WHERE content_hash=? AND status NOT IN ('done','failed') AND content_hash IS NOT NULL`).all(content_hash);
              for (const sib of crossSibs) await applyDuplicateResult(otherDb, sib.url, donor, sib.before_score);
            } catch {}
          }
        }
      } else if (job.status === 'failed') {
        db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=?, pipeline_job_id=NULL WHERE url=?")
          .run(now(), (job.error || 'pipeline failed').slice(0, 300), url);
        log(`Failed: ${url.split('/').pop()}: ${job.error}`);
      } else if (job.status === 'processing') {
        db.prepare("UPDATE pdf_upgrade_queue SET status='processing', started_at=COALESCE(started_at,?) WHERE url=? AND status != 'processing'")
          .run(now(), url);
      } else if (job.status === 'pending') {
        db.prepare("UPDATE pdf_upgrade_queue SET status='submitted' WHERE url=? AND status='pending'").run(url);
      }
    } catch (err) {
      if (err.message?.includes('404') || err.message?.includes('HTTP 404')) {
        db.prepare("UPDATE pdf_upgrade_queue SET status='failed', error=?, pipeline_job_id=NULL WHERE url=?")
          .run('pipeline job record expired', url);
      }
    }
  }
};

const tick = async () => {
  let sites;
  try { ({ sites } = loadConfig()); } catch (err) { log(`Config load failed: ${err.message}`); return; }
  if (!sites.length) return;

  const focusDomain = getFocusDomain();
  if (focusDomain) log(`Focus mode: processing ${focusDomain} only`);

  const validSites = sites.filter(site => {
    const d = safeHostname(site.url);
    return d && (!focusDomain || d === focusDomain);
  });

  const openDbs = [];
  try {
    for (const site of validSites) {
      const domain = safeHostname(site.url);
      try {
        const db = openDb(domain);
        ensurePipelineJobIdColumn(db);
        openDbs.push({ db, domain });
      } catch (err) { log(`Failed to open DB for ${domain}: ${err.message}`); }
    }

    // Poll in-flight jobs first
    try {
      await pipelineClient.health();
      await Promise.all(openDbs.map(({ db, domain }) => checkPipelineJobs(db, domain, openDbs)));
    } catch (err) {
      log(`Pipeline unreachable (${err.message}) — skipping this tick.`);
      return;
    }

    // Collect pending docs across all sites (pass 1 and 2+ treated identically — all go to pipeline)
    const pending = [];
    for (const { db, domain } of openDbs) {
      const sc = validSites.find(s => safeHostname(s.url) === domain) || null;
      const rows = db.prepare(`
        SELECT q.*, pq.composite_score as before_score
        FROM pdf_upgrade_queue q LEFT JOIN pdf_quality pq ON q.url=pq.url
        WHERE q.status='pending'
        ORDER BY q.priority DESC LIMIT ?`).all(SUBMIT_CONCURRENCY);
      for (const row of rows) pending.push({ db, domain, row, siteConfig: sc });
    }

    if (!pending.length) { log('No pending items'); return; }

    log(`Submitting ${pending.length} docs to pipeline`);
    await Promise.all(pending.map(async ({ db, domain, row, siteConfig }) => {
      const page = db.prepare('SELECT * FROM pages WHERE url=?').get(row.url);
      if (!page?.local_path || !existsSync(page.local_path)) {
        db.prepare("UPDATE pdf_upgrade_queue SET status='failed', error=? WHERE url=?")
          .run('local_path missing', row.url);
        return;
      }
      return submitViaPipeline(db, domain, row, page, siteConfig, openDbs);
    }));
  } finally {
    for (const { db } of openDbs) { try { db.close(); } catch {} }
  }
};

const resetStuckProcessing = () => {
  try {
    const { sites } = loadConfig();
    for (const site of sites) {
      const domain = safeHostname(site.url);
      if (!domain) continue;
      let db;
      try {
        db = openDb(domain);
        const n = db.prepare("UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL WHERE status='processing'").run().changes;
        if (n) log(`Reset ${n} stuck docs to pending`);
        const n2 = db.prepare(`UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL, error=NULL
          WHERE status='failed' AND (error LIKE '%timed out%' OR error='pipeline job record expired')`).run().changes;
        if (n2) log(`Reset ${n2} transient-failed docs to pending`);
      } catch {} finally { try { db?.close(); } catch {} }
    }
  } catch {}
};

process.on('unhandledRejection', (reason) => log(`Unhandled rejection: ${reason?.message ?? reason}`));
process.on('uncaughtException', (err) => log(`Uncaught exception: ${err.message}`));

resetStuckProcessing();
log('PDF upgrade worker started — submitting to pipeline-server only');

const run = async () => {
  try { await tick(); } catch (err) { log(`Tick error: ${err.message}`); }
  setTimeout(run, TICK_INTERVAL_MS);
};

run();
