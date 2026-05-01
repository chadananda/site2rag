// PDF scoring stage -- scores unscored PDFs in parallel using worker threads.
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { saveQualityScore, maybeQueue } from './pdf-upgrade/score.js';

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'score-worker.js');
const CONCURRENCY = Math.max(1, cpus().length - 2);

const scoreOne = (pdfPath) => new Promise((resolve) => {
  const w = new Worker(WORKER_SCRIPT, { workerData: { pdfPath } });
  w.once('message', resolve);
  w.once('error', (e) => resolve({ ok: false, error: e.message }));
  w.once('exit', (code) => { if (code !== 0) resolve({ ok: false, error: `exit ${code}` }); });
});

/**
 * Score all unscored PDFs using a parallel worker pool.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { scored, queued, skipped }
 */
export const runScorePdfs = async (db, siteConfig) => {
  const threshold = siteConfig.pdf_upgrade?.score_threshold ?? 0.7;
  const stats = { scored: 0, queued: 0, skipped: 0 };

  const unscored = db.prepare(`
    SELECT p.url, p.local_path, p.content_hash FROM pages p
    LEFT JOIN pdf_quality q ON p.url = q.url
    WHERE p.mime_type = 'application/pdf' AND p.gone = 0
      AND p.local_path IS NOT NULL AND q.url IS NULL
    ORDER BY p.first_seen_at DESC
  `).all().filter(r => existsSync(r.local_path));

  if (!unscored.length) return stats;
  console.log(`[score-pdfs] ${unscored.length} unscored PDFs, concurrency=${CONCURRENCY}`);

  // Pool: keep CONCURRENCY workers running at all times
  const queue = [...unscored];
  let active = 0;
  const results = [];

  await new Promise((done) => {
    const next = () => {
      if (!queue.length && active === 0) return done();
      while (active < CONCURRENCY && queue.length) {
        const row = queue.shift();
        active++;
        scoreOne(row.local_path).then(result => {
          results.push({ row, result });
          active--;
          next();
        });
      }
    };
    next();
  });

  // Write results to DB sequentially (better-sqlite3 is sync)
  for (const { row, result } of results) {
    if (!result.ok) { stats.skipped++; continue; }
    saveQualityScore(db, row.url, row.content_hash, result.metrics);
    if (maybeQueue(db, row.url, row.content_hash, result.metrics.composite_score, threshold)) stats.queued++;
    stats.scored++;
  }

  console.log(`[score-pdfs] done: scored=${stats.scored} queued=${stats.queued} skipped=${stats.skipped}`);
  return stats;
};
