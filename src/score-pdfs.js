// PDF scoring stage -- scores unscored PDFs, queues low-scorers for upgrade. Time-budgeted per run.
import { existsSync } from 'fs';
import { scorePdf, saveQualityScore, maybeQueue } from './pdf-upgrade/score.js';

const BUDGET_MS = 5 * 60 * 1000; // 5 minutes per run max
const THRESHOLD = 0.7;

/**
 * Score all PDFs that lack a quality entry. Stops when time budget is exhausted.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { scored, queued, skipped }
 */
export const runScorePdfs = async (db, siteConfig) => {
  const threshold = siteConfig.pdf_upgrade?.score_threshold ?? THRESHOLD;
  const stats = { scored: 0, queued: 0, skipped: 0 };
  const started = Date.now();

  const unscored = db.prepare(`
    SELECT p.url, p.local_path, p.content_hash FROM pages p
    LEFT JOIN pdf_quality q ON p.url = q.url
    WHERE p.mime_type = 'application/pdf' AND p.gone = 0
      AND p.local_path IS NOT NULL AND q.url IS NULL
    ORDER BY p.first_seen_at DESC
  `).all();

  if (unscored.length) {
    console.log(`[score-pdfs] ${unscored.length} unscored PDFs to process`);
  }

  for (const row of unscored) {
    if (Date.now() - started > BUDGET_MS) {
      console.log(`[score-pdfs] time budget exhausted, ${unscored.length - stats.scored - stats.skipped} remaining`);
      break;
    }
    if (!existsSync(row.local_path)) { stats.skipped++; continue; }
    try {
      const metrics = await scorePdf(row.local_path);
      saveQualityScore(db, row.url, row.content_hash, metrics);
      const queued = maybeQueue(db, row.url, row.content_hash, metrics.composite_score, threshold);
      if (queued) stats.queued++;
      stats.scored++;
    } catch (err) {
      console.warn(`[score-pdfs] failed ${row.url}: ${err.message}`);
      stats.skipped++;
    }
  }

  if (stats.scored > 0) {
    console.log(`[score-pdfs] scored ${stats.scored}, queued ${stats.queued} for upgrade`);
  }
  return stats;
};
