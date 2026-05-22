// PDF upgrade loop: multi-pass (Marker → boss vision → Claude). Exports: (none, daemon). Deps: backfill, lang-detect, summarize, reocr, rebuild, score, marker-client, db
// Set PIPELINE_URL env var to route upgrades through the new pipeline service instead of Marker.
import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { loadConfig, getMirrorRoot, mirrorDir, mdDir, metaDir } from '../config.js';
import { openDb } from '../db.js';
import { ocrAvailableBackend, reocrDocument, bossPrewarm } from './reocr.js';
import { rebuildPdf } from './rebuild.js';
import { scorePdf } from './score.js';
import { backfillHostsFromMirror } from './backfill.js';
import { detectLanguageForImagePdfs } from './lang-detect.js';
import { summarizeTopPending } from './summarize.js';
import { markerAvailable, convertPdfWithMarker, scoreMarkdown } from './marker-client.js';
import { spellFixMarkdown, spellFixCost } from './spell-fix.js';
import { PipelineClient } from '../pipeline/client.js';

const TICK_INTERVAL_MS = 60 * 1000;
const SUMMARIZE_INTERVAL_MS = 15 * 1000;

// Pipeline service client — set PIPELINE_URL to route pass-1 upgrades through the new pipeline.
// When set, the service MUST be reachable; unreachable = skip tick with a visible error.
// To move the service to another host: just change PIPELINE_URL.
const pipelineClient = process.env.PIPELINE_URL
  ? new PipelineClient({ baseUrl: process.env.PIPELINE_URL })
  : null;
const MARKER_CONCURRENCY = 16;   // CPU-bound, tower-nas has 80 cores
const OCR_DOC_CONCURRENCY = 8;   // GPU-bound on boss (max_num_seqs=8)
const MARKER_SCORE_THRESHOLD = 0.55;  // md quality to mark pass-1 done
const SPELL_FIX_THRESHOLD   = 0.85;  // above this, spell-fix not worth it
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256file = (path) => sha256(readFileSync(path));
const now = () => new Date().toISOString();
const log = (msg) => console.log(`[pdf-upgrade] ${now().slice(0,19)} ${msg}`);

/** Record one upgrade attempt in history. Attempt number auto-increments per URL. */
const logUpgradeHistory = (db, url, { method, score_before, score_after, pages_processed, error }) => {
  const attempt = (db.prepare('SELECT COUNT(*)+1 as n FROM pdf_upgrade_history WHERE url=?').get(url)?.n) || 1;
  db.prepare(`INSERT INTO pdf_upgrade_history (url, attempt, method, score_before, score_after, pages_processed, finished_at, error) VALUES (?,?,?,?,?,?,?,?)`)
    .run(url, attempt, method ?? null, score_before ?? null, score_after ?? null, pages_processed ?? null, now(), error ?? null);
};

/** Safely parse a URL hostname — returns null on invalid URLs instead of throwing. */
const safeHostname = (url) => { try { return new URL(url).hostname; } catch { return null; } };

/** Check all other site DBs for an already-upgraded PDF with matching content hash. */
const findUpgradedDuplicate = (contentHash, allDomains, skipDomain) => {
  for (const domain of allDomains) {
    if (domain === skipDomain) continue;
    let db;
    try {
      const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
      if (!existsSync(dbPath)) continue;
      db = openDb(domain);
      const hit = db.prepare(`
        SELECT u.upgraded_pdf_path, u.after_score, u.score_improvement, u.pages_processed, u.method, u.receipt_json
        FROM pdf_upgrade_queue u JOIN pdf_quality pq ON u.url=pq.url
        WHERE pq.content_hash=? AND u.status='done' AND u.upgraded_pdf_path IS NOT NULL
        LIMIT 1`).get(contentHash);
      if (hit && existsSync(hit.upgraded_pdf_path)) return hit;
    } catch {} finally { try { db?.close(); } catch {} }
  }
  return null;
};

/** Apply a completed upgrade result to a duplicate URL (same content hash). */
const applyDuplicateResult = async (db, url, donor, beforeScore) => {
  const existing = db.prepare('SELECT pipeline_job_id, status FROM pdf_upgrade_queue WHERE url=?').get(url);
  if (!existing || existing.status === 'done') return;
  if (existing.pipeline_job_id && pipelineClient) {
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
  if (donor.after_score != null) {
    db.prepare('UPDATE pdf_quality SET composite_score=? WHERE url=?').run(donor.after_score, url);
  }
  logUpgradeHistory(db, url, { method: (donor.method || 'pipeline-v2') + '+dedup',
    score_before: beforeScore, score_after: donor.after_score, pages_processed: donor.pages_processed });
  log(`Dedup: ${url.split('/').pop()} ← cached`);
};

/** Find a cached upgrade result for a content hash: checks same DB first, then all open DBs. */
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

/** Save Marker-extracted Markdown to the domain's md output dir. Returns saved path. */
const saveMarkerMd = (db, domain, page, markdown) => {
  const outDir = mdDir(domain);
  mkdirSync(outDir, { recursive: true });
  const slug = page.path_slug || page.url.split('/').pop().replace(/\.pdf$/i, '');
  const outPath = join(outDir, `${slug}.md`);
  writeFileSync(outPath, markdown, 'utf8');
  try {
    db.prepare(`INSERT OR REPLACE INTO exports (url, local_path, status, written_at) VALUES (?,?,?,?)`)
      .run(page.url, outPath, 'ok', now());
  } catch {}
  return outPath;
};

// Ensure pipeline_job_id column exists (added in robustness refactor)
const ensurePipelineJobIdColumn = (db) => {
  try { db.exec('ALTER TABLE pdf_upgrade_queue ADD COLUMN pipeline_job_id TEXT'); } catch {}
};

/** Submit one doc to the pipeline service and mark it processing. No waiting — checkPipelineJobs polls. */
const submitViaPipeline = async (db, domain, row, page, siteConfig, openDbs = []) => {
  // Cache hit: same PDF already upgraded elsewhere — copy result instead of reprocessing
  const cached = findCachedResult(row.content_hash, db, row.url, openDbs)
    || (row.content_hash ? findUpgradedDuplicate(row.content_hash, openDbs.map(o => o.domain), domain) : null);
  if (cached) {
    await applyDuplicateResult(db, row.url, cached, row.before_score);
    return;
  }
  const quality = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get(row.url) ?? {};
  // Difficulty-based ordering: text PDFs (spell-fix only, seconds) → high importance;
  // image PDFs (need OCR, minutes) → lower importance. Min difficulty 0.3 for image PDFs
  // so they never outrank text PDFs regardless of page count.
  const isImagePdf = !quality.has_text_layer;
  const rawDiff = quality.processing_difficulty || null;
  const difficulty = isImagePdf ? Math.max(0.3, rawDiff ?? 0.5) : (rawDiff ?? 0.05);
  const importance = Math.max(1, Math.round((1 - difficulty) * 200));
  try {
    const jobId = await pipelineClient.submitJob({
      pdfPath:    page.local_path,
      sourceUrl:  row.url,
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
    log(`Pipeline submitted: ${row.url.split('/').pop()}`);
  } catch (err) {
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(now(), err.message.slice(0, 300), row.url);
    log(`Pipeline submit failed: ${row.url.split('/').pop()}: ${err.message}`);
  }
};

/** Poll all in-flight pipeline jobs and update site DB when done/failed. */
const checkPipelineJobs = async (db, domain, openDbs = []) => {
  // Include any status with a pipeline_job_id — catches rows where status was
  // accidentally left at 'pending' but the job is actually running in the pipeline.
  const running = db.prepare(
    "SELECT url, pipeline_job_id, before_score, content_hash FROM pdf_upgrade_queue WHERE pipeline_job_id IS NOT NULL AND status NOT IN ('done','failed')"
  ).all();
  for (const { url, pipeline_job_id: jobId, before_score, content_hash } of running) {
    try {
      const job = await pipelineClient.getJob(jobId);
      if (job.status === 'done') {
        const receipt = job.receipt ?? {};
        const afterScore = receipt.quality?.final ?? null;
        db.prepare(`UPDATE pdf_upgrade_queue
          SET status='done', finished_at=?, upgraded_pdf_path=?,
              after_score=?, score_improvement=?, pages_processed=?, method=?, receipt_json=?, pipeline_job_id=NULL
          WHERE url=?`)
          .run(now(), job.pdf_out_path ?? null,
            afterScore, receipt.quality?.gain ?? null,
            receipt.page_count ?? null, 'pipeline-v2', JSON.stringify(receipt), url);
        // Do NOT overwrite composite_score — it holds the original pre-upgrade score for comparison
        logUpgradeHistory(db, url, { method: 'pipeline-v2', score_before: before_score,
          score_after: receipt.quality?.final ?? null, pages_processed: receipt.page_count ?? null });
        log(`Pipeline done: ${url.split('/').pop()}`);
        // Fetch markdown from pipeline and save to domain's md dir
        if (pipelineClient) {
          try {
            const md = await pipelineClient.getMarkdown(jobId);
            const page = db.prepare('SELECT * FROM pages WHERE url=?').get(url);
            if (md && page) saveMarkerMd(db, domain, page, md);
          } catch (mdErr) { log(`Pipeline done (no md): ${url.split('/').pop()}: ${mdErr.message}`); }
        }

        // Propagate cached result to all siblings with same content hash (same + other domains)
        if (content_hash) {
          const donor = { upgraded_pdf_path: job.pdf_out_path ?? null, after_score: afterScore,
            score_improvement: receipt.quality?.gain ?? null, pages_processed: receipt.page_count ?? null,
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
        log(`Pipeline failed: ${url.split('/').pop()}: ${job.error}`);
      } else if (job.status === 'processing') {
        db.prepare("UPDATE pdf_upgrade_queue SET status='processing', started_at=COALESCE(started_at,?) WHERE url=? AND status != 'processing'")
          .run(now(), url);
      } else if (job.status === 'pending') {
        // Still waiting in pipeline queue — ensure our status reflects submitted
        db.prepare("UPDATE pdf_upgrade_queue SET status='submitted' WHERE url=? AND status='pending'")
          .run(url);
      }
    } catch (err) {
      if (err.message?.includes('404') || err.message?.includes('HTTP 404')) {
        db.prepare("UPDATE pdf_upgrade_queue SET status='failed', error=?, pipeline_job_id=NULL WHERE url=?")
          .run('pipeline job record expired', url);
      }
      // other errors (network) → leave as-is, retry next tick
    }
  }
};

/** Run pass-1 (Marker) for one document. */
const upgradeDocumentMarker = async (db, domain, row, allDomains, siteConfig) => {
  const page = db.prepare('SELECT * FROM pages WHERE url=?').get(row.url);
  if (!page?.local_path || !existsSync(page.local_path)) {
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(now(), 'local_path missing', row.url);
    return;
  }
  db.prepare("UPDATE pdf_upgrade_queue SET status='processing', started_at=? WHERE url=?").run(now(), row.url);
  log(`Pass 1 (Marker): ${row.url}`);

  try {
    const contentHash = sha256file(page.local_path);
    const dup = findUpgradedDuplicate(contentHash, allDomains, domain);
    if (dup) {
      const hash = sha256(page.url).slice(0, 16);
      const upgradedDir = join(mirrorDir(domain), '.upgraded');
      mkdirSync(upgradedDir, { recursive: true });
      const outputPath = join(upgradedDir, `x${hash}.pdf`);
      copyFileSync(dup.upgraded_pdf_path, outputPath);
      db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
        .run(now(), outputPath, dup.after_score, (dup.after_score||0) - (row.before_score||0), dup.pages_processed, `${dup.method}+dedup`, row.url);
      db.prepare(`UPDATE pdf_quality SET ai_summarized_at=NULL WHERE url=?`).run(row.url);
      logUpgradeHistory(db, row.url, { method: `${dup.method}+dedup`, score_before: row.before_score, score_after: dup.after_score, pages_processed: dup.pages_processed });
      log(`Dedup hit: ${row.url}`);
      return;
    }

    let markdown;
    try {
      markdown = await convertPdfWithMarker(page.local_path);
    } catch (markerErr) {
      log(`Marker failed ${row.url}: ${markerErr.message} → escalating to pass 2`);
      db.prepare("UPDATE pdf_upgrade_queue SET status='pending', pass=2 WHERE url=?").run(row.url);
      return;
    }

    const mdScore = scoreMarkdown(markdown);
    // Always save MD for immediate searchability, even if quality is low
    const mdPath = saveMarkerMd(db, domain, page, markdown);
    db.prepare('UPDATE pdf_upgrade_queue SET marker_md_path=? WHERE url=?').run(mdPath, row.url);

    const spellFixOnly = row.requested_method === 'spell-fix';

    if (mdScore >= MARKER_SCORE_THRESHOLD || spellFixOnly) {
      let finalMarkdown = markdown;
      let finalScore = mdScore;
      let method = 'marker';

      // Spell-fix: run if explicitly requested, or if score is decent but below excellence threshold
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey && (spellFixOnly || mdScore < SPELL_FIX_THRESHOLD)) {
        try {
          log(`Spell-fix: ${row.url} (marker score ${mdScore.toFixed(2)})`);
          const quality = db.prepare('SELECT pages, pdf_title FROM pdf_quality WHERE url=?').get(row.url);
          const ctx = { title: quality?.pdf_title, totalPages: quality?.pages };
          const result = await spellFixMarkdown(markdown, apiKey, ctx);
          const fixedScore = scoreMarkdown(result.markdown);
          if (fixedScore > mdScore) {
            finalMarkdown = result.markdown;
            finalScore = fixedScore;
            method = 'marker+spell-fix';
            log(`Spell-fix improved: ${mdScore.toFixed(2)} → ${fixedScore.toFixed(2)} cost=$${result.cost_usd.toFixed(4)}`);
            const { logLlmCall, llmCost } = await import('../db.js');
            logLlmCall(db, { stage: 'spell-fix', url: row.url, page_no: null, provider: 'claude', model: 'claude-haiku-4-5-20251001', tokens_in: result.tokens_in, tokens_out: result.tokens_out, cost_usd: result.cost_usd, ok: 1 });
          }
        } catch (sfErr) {
          log(`Spell-fix failed (non-fatal): ${sfErr.message}`);
        }
      }

      db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, after_score=?, score_improvement=?, method=? WHERE url=?`)
        .run(now(), finalScore, finalScore - (row.before_score||0), method, row.url);
      const newExcerpt = finalMarkdown.replace(/^---[\s\S]*?---\n/, '').slice(0, 800).trim();
      db.prepare(`UPDATE pdf_quality SET excerpt=?, ai_summarized_at=NULL WHERE url=?`).run(newExcerpt, row.url);
      // Save spell-fixed MD if it improved
      if (finalMarkdown !== markdown) saveMarkerMd(db, domain, page, finalMarkdown);
      logUpgradeHistory(db, row.url, { method, score_before: row.before_score, score_after: finalScore });
      log(`Done (${method}): ${row.url} md-score=${finalScore.toFixed(2)}`);
    } else if (spellFixOnly) {
      // User only wanted spell-fix; marker quality too low for text extraction — mark failed
      log(`Spell-fix only: marker quality ${mdScore.toFixed(2)} too low, image PDF? — marking failed`);
      logUpgradeHistory(db, row.url, { method: 'marker+spell-fix', score_before: row.before_score, score_after: mdScore, error: 'insufficient text for spell-fix; use full OCR' });
      db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
        .run(now(), 'Text quality too low for spell-fix — try Full OCR upgrade instead', row.url);
    } else {
      log(`Marker quality ${mdScore.toFixed(2)} < ${MARKER_SCORE_THRESHOLD} for ${row.url} → pass 2`);
      logUpgradeHistory(db, row.url, { method: 'marker', score_before: row.before_score, score_after: mdScore, error: `quality ${mdScore.toFixed(2)} below threshold` });
      db.prepare("UPDATE pdf_upgrade_queue SET status='pending', pass=2 WHERE url=?").run(row.url);
    }
  } catch (err) {
    log(`Failed pass 1: ${row.url}: ${err.message}`);
    logUpgradeHistory(db, row.url, { method: 'marker', score_before: row.before_score, error: err.message });
    db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
      .run(now(), err.message, row.url);
  }
};

/** Run pass-2+ (boss/Claude vision OCR) for one document. Opens its own DB so it can run fire-and-forget across ticks. */
const upgradeDocumentOcr = async (domain, row, allDomains, ocrBackend, siteConfig) => {
  const db = openDb(domain);
  try {
    const page = db.prepare('SELECT * FROM pages WHERE url=?').get(row.url);
    if (!page?.local_path || !existsSync(page.local_path)) {
      db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
        .run(now(), 'local_path missing', row.url);
      return;
    }
    db.prepare("UPDATE pdf_upgrade_queue SET status='processing', started_at=? WHERE url=?").run(now(), row.url);
    log(`Pass ${row.pass||2} (${ocrBackend}): ${row.url}`);

    try {
      const contentHash = sha256file(page.local_path);
      const dup = findUpgradedDuplicate(contentHash, allDomains, domain);
      if (dup) {
        const hash = sha256(page.url).slice(0, 16);
        const upgradedDir = join(mirrorDir(domain), '.upgraded');
        mkdirSync(upgradedDir, { recursive: true });
        const outputPath = join(upgradedDir, `x${hash}.pdf`);
        copyFileSync(dup.upgraded_pdf_path, outputPath);
        const improvement = (dup.after_score||0) - (row.before_score||0);
        db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
          .run(now(), outputPath, dup.after_score, improvement, dup.pages_processed, `${dup.method}+dedup`, row.url);
        db.prepare(`UPDATE pdf_quality SET ai_summarized_at=NULL WHERE url=?`).run(row.url);
        logUpgradeHistory(db, row.url, { method: `${dup.method}+dedup`, score_before: row.before_score, score_after: dup.after_score, pages_processed: dup.pages_processed });
        log(`Dedup hit: ${row.url}`);
        if (siteConfig) {
          try {
            const { exportTextPdf } = await import('../export-doc.js');
            await exportTextPdf(db, siteConfig, { ...page, local_path: outputPath, content_hash: sha256file(outputPath) });
          } catch {}
        }
        return;
      }

      db.prepare('UPDATE pdf_quality SET content_hash=? WHERE url=?').run(contentHash, row.url);
      const quality = db.prepare(`
        SELECT pq.pages, pq.pdf_title, pq.ai_summary, pq.ai_author, pq.ai_language,
               h.hosted_title as anchor_text, h.host_url,
               p.classify_rationale as host_page_rationale
        FROM pdf_quality pq
        LEFT JOIN hosts h ON pq.url=h.hosted_url
        LEFT JOIN pages p ON h.host_url=p.url
        WHERE pq.url=?`).get(row.url);
      const numPages = quality?.pages || 1;
      const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();

      // meta feeds ctx.meta in the new pipeline — field names match domain-detect.js signal names
      const meta = {
        // Document identity
        title:       quality?.pdf_title || (slug.length > 3 ? slug : undefined),
        author:      quality?.ai_author && quality.ai_author !== 'Unknown' ? quality.ai_author : undefined,
        language:    quality?.ai_language || undefined,

        // Crawl-derived context signals — fed to domain detection
        anchorText:       quality?.anchor_text || undefined,   // link text from HTML page
        siteDescription:  siteConfig?.description || undefined, // site-level description from config
        contextHints:     quality?.ai_summary || undefined,    // prior AI summary as a hint

        // PDF embed fields (for archival PDF rebuild)
        subject:  quality?.ai_summary || undefined,
        keywords: ['site2rag', domain, ...(quality?.host_url ? [quality.host_url] : []), row.url],
      };

      // Per-document timeout: 30 min max (large PDFs with many pages)
      const ocrResults = await Promise.race([
        reocrDocument(page.local_path, domain, contentHash, numPages,
          (n, total) => { if (n % 5 === 0 || n === total) log(`  page ${n}/${total}`); },
          ocrBackend, db, page.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout after 30min')), 30 * 60 * 1000))
      ]);

      const hash = sha256(page.url).slice(0, 16);
      const upgradedDir = join(mirrorDir(domain), '.upgraded');
      mkdirSync(upgradedDir, { recursive: true });
      const outputPath = join(upgradedDir, `x${hash}.pdf`);
      const { success, method, error } = await rebuildPdf(page.local_path, outputPath, ocrResults, meta);
      if (!success) throw new Error(error);

      const afterMetrics = await scorePdf(outputPath);
      const improvement = afterMetrics.composite_score - (row.before_score||0);
      db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=?, before_score=?, after_score=?, score_improvement=?, pages_processed=?, method=? WHERE url=?`)
        .run(now(), outputPath, row.before_score||0, afterMetrics.composite_score, improvement, numPages, method, row.url);
      db.prepare(`UPDATE pdf_quality SET composite_score=?, has_text_layer=?, readable_pages_pct=?, avg_chars_per_page=?, word_quality_estimate=?, excerpt=?, ai_summarized_at=NULL WHERE url=?`)
        .run(afterMetrics.composite_score, afterMetrics.has_text_layer, afterMetrics.readable_pages_pct, afterMetrics.avg_chars_per_page, afterMetrics.word_quality_estimate, afterMetrics.excerpt, row.url);
      logUpgradeHistory(db, row.url, { method, score_before: row.before_score, score_after: afterMetrics.composite_score, pages_processed: numPages });
      log(`Done (${method}): ${row.url} ${(row.before_score||0).toFixed(2)} → ${afterMetrics.composite_score.toFixed(2)}`);

      if (siteConfig) {
        try {
          const { exportTextPdf } = await import('../export-doc.js');
          await exportTextPdf(db, siteConfig, { ...page, local_path: outputPath, content_hash: sha256file(outputPath) });
        } catch (e) { log(`MD export failed: ${e.message}`); }
      }
    } catch (err) {
      log(`Failed pass ${row.pass||2}: ${row.url}: ${err.message}`);
      const permanent = err.message?.includes('EncryptedPdf') || err.message?.includes('local_path missing') || err.message?.includes('Data format error') || err.message?.includes('image file is truncated') || err.message?.includes('cannot identify image file');
      logUpgradeHistory(db, row.url, { method: ocrBackend, score_before: row.before_score, error: err.message });
      if (permanent) {
        db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=? WHERE url=?")
          .run(now(), err.message, row.url);
      } else {
        // Transient: timeout, network, OOM — reset to pending for next tick
        db.prepare("UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL, error=? WHERE url=?")
          .run(err.message, row.url);
        log(`  → reset to pending for retry`);
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
};

const FOCUS_FILE = join(getMirrorRoot(), '.focused_domain');
const getFocusDomain = () => {
  try { const d = readFileSync(FOCUS_FILE, 'utf8').trim(); return d || null; } catch { return null; }
};

const tick = async () => {
  let sites;
  try {
    ({ sites } = loadConfig());
  } catch (err) {
    log(`Config load failed: ${err.message}`);
    return;
  }
  if (!sites.length) return;

  // Respect focus mode: admin can focus all processing on one site via report UI
  const focusDomain = getFocusDomain();
  if (focusDomain) log(`Focus mode: processing ${focusDomain} only`);

  // Filter out sites with invalid URLs, and apply focus when set
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
      } catch (err) {
        log(`Failed to open DB for ${domain}: ${err.message}`);
      }
    }

    for (const { db, domain } of openDbs) {
      try { await backfillHostsFromMirror(db, domain); } catch {}
      try { await detectLanguageForImagePdfs(db, domain); } catch {}
    }

    const allDomains = openDbs.map(o => o.domain);
    const pass1 = [], pass2plus = [];

    for (const { db, domain } of openDbs) {
      const sc = validSites.find(s => safeHostname(s.url) === domain) || null;
      const p1 = db.prepare(`
        SELECT q.*, pq.composite_score as before_score
        FROM pdf_upgrade_queue q LEFT JOIN pdf_quality pq ON q.url=pq.url
        WHERE q.status='pending' AND (q.pass IS NULL OR q.pass=1)
        ORDER BY q.priority DESC LIMIT ?`).all(MARKER_CONCURRENCY);
      // Fair share: each site gets equal slice of OCR slots; min 1, max OCR_DOC_CONCURRENCY
      const perSite = Math.max(1, Math.ceil(OCR_DOC_CONCURRENCY / openDbs.length));
      const p2 = db.prepare(`
        SELECT q.*, pq.composite_score as before_score
        FROM pdf_upgrade_queue q LEFT JOIN pdf_quality pq ON q.url=pq.url
        WHERE q.status='pending' AND q.pass>=2
        ORDER BY q.priority DESC LIMIT ?`).all(perSite);
      for (const row of p1) pass1.push({ db, domain, row, siteConfig: sc });
      for (const row of p2) pass2plus.push({ db, domain, row, siteConfig: sc });
    }

    // Pre-warm boss if pass-2+ work is queued — non-blocking, fire and forget
    if (pass2plus.length > 0) {
      bossPrewarm().catch(() => {});
      log(`Pre-warming boss for ${pass2plus.length} pending OCR job(s)`);
    }

    // Poll pipeline for completed/failed jobs unconditionally — even when no new submissions are needed.
    // checkPipelineJobs was previously inside runPass1, so it only ran when there were pending items.
    // With all items submitted (status='submitted'), pass1 would be empty and completions were never detected.
    if (pipelineClient) {
      let pipelineReachable = true;
      try {
        await pipelineClient.health();
        await Promise.all(openDbs.map(({ db, domain }) => checkPipelineJobs(db, domain, openDbs)));
      } catch (err) {
        pipelineReachable = false;
        log(`ERROR: Pipeline service unreachable (${err.message}) — skipping pass-1 this tick. Fix PIPELINE_URL or start pipeline-server.`);
      }
    }

    // Pass 1 (Marker) and Pass 2+ (boss/Claude) run concurrently — CPU and GPU are independent
    const [markerOk, ocrBackend] = await Promise.all([markerAvailable(), ocrAvailableBackend()]);

    const runPass1 = async () => {
      if (!pass1.length) return;

      // When PIPELINE_URL is set, all pass-1 work goes through the pipeline service.
      if (pipelineClient) {
        try {
          await pipelineClient.health();
        } catch (err) {
          return; // already logged above
        }
        // Submit only newly-pending docs (not already in pipeline)
        pass1.sort((a,b) => (b.row.priority||0) - (a.row.priority||0));
        const batch = pass1.slice(0, MARKER_CONCURRENCY);
        if (batch.length) {
          log(`Pass 1 (pipeline-v2): submitting ${batch.length} docs`);
          await Promise.all(batch.map(async ({ db, domain, row, siteConfig }) => {
            const page = db.prepare('SELECT * FROM pages WHERE url=?').get(row.url);
            if (!page?.local_path || !existsSync(page.local_path)) {
              db.prepare("UPDATE pdf_upgrade_queue SET status='failed', error=? WHERE url=?")
                .run('local_path missing', row.url);
              return;
            }
            return submitViaPipeline(db, domain, row, page, siteConfig, openDbs);
          }));
        }
        return;
      }

      if (!markerOk) {
        log('Marker unavailable — escalating all pass-1 to pass-2');
        for (const { db, row } of pass1)
          db.prepare("UPDATE pdf_upgrade_queue SET pass=2 WHERE url=? AND (pass IS NULL OR pass<=1)").run(row.url);
        return;
      }
      pass1.sort((a,b) => (b.row.priority||0) - (a.row.priority||0));
      const batch = pass1.slice(0, MARKER_CONCURRENCY);
      log(`Pass 1 (Marker): ${batch.length} docs`);
      await Promise.all(batch.map(({ db, domain, row, siteConfig }) =>
        upgradeDocumentMarker(db, domain, row, allDomains, siteConfig)));
    };

    const runPass2 = () => {
      if (!pass2plus.length) return;
      if (!ocrBackend) { log('No OCR backend available — skipping pass-2+'); return; }
      if (ocrBackend === 'claude') log('Boss unreachable — falling back to Claude Haiku for OCR');
      // Per-site fair cap: each site gets equal share of OCR slots to prevent starvation
      const perSite = Math.max(1, Math.ceil(OCR_DOC_CONCURRENCY / openDbs.length));
      const activeBySite = {};
      for (const { db, domain } of openDbs) {
        try { activeBySite[domain] = db.prepare("SELECT COUNT(*) as n FROM pdf_upgrade_queue WHERE status='processing' AND pass>=2").get().n; }
        catch { activeBySite[domain] = 0; }
      }
      const totalActive = Object.values(activeBySite).reduce((s, n) => s + n, 0);
      if (totalActive >= OCR_DOC_CONCURRENCY) { log(`Pass 2+ skipped — ${totalActive} OCR jobs already active`); return; }
      pass2plus.sort((a,b) => (b.row.priority||0) - (a.row.priority||0));
      // Filter: only include docs for sites that haven't hit their per-site cap
      const batch = pass2plus
        .filter(({ domain }) => (activeBySite[domain] || 0) < perSite)
        .slice(0, OCR_DOC_CONCURRENCY - totalActive);
      if (!batch.length) { log(`Pass 2+ skipped — all sites at per-site cap (${perSite} each)`); return; }
      log(`Pass 2+ (${ocrBackend}): ${batch.length} docs (fire-and-forget, ${totalActive} active)`);
      // Fire-and-forget: OCR jobs own their DB connections and can span multiple ticks
      batch.forEach(({ domain, row, siteConfig }) =>
        upgradeDocumentOcr(domain, row, allDomains, ocrBackend, siteConfig).catch(e => log(`OCR job error: ${e.message}`)));
    };

    await Promise.all([runPass1(), Promise.resolve(runPass2())]);

    if (!pass1.length && !pass2plus.length) log('No pending items');
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
        // Only reset 'processing' (in-flight local jobs) — NOT 'submitted' (queued in pipeline service).
        // Submitted jobs are stable: the pipeline holds them and checkPipelineJobs will update them when done.
        const n = db.prepare("UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL WHERE status='processing'").run().changes;
        if (n) log(`Reset ${n} stuck docs to pending`);
        // Reset failed docs whose failure was a pipeline timeout (not a real processing error).
        // These docs never got a fair chance — they were just waiting in a queue when the old
        // 1-hour client timeout fired. Re-queue them so they're retried at their normal priority.
        const n2 = db.prepare(`UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL, error=NULL
          WHERE status='failed' AND (error LIKE '%timed out%' OR error='pipeline job record expired')`).run().changes;
        if (n2) log(`Reset ${n2} transient-failed docs to pending (will retry at normal priority)`);
      } catch {} finally { try { db?.close(); } catch {} }
    }
  } catch {}
};

resetStuckProcessing();
log('PDF upgrade worker started (multi-pass: Marker → boss → Claude)');

// Global error handlers — log and continue, never crash the daemon
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason?.message ?? reason}`);
});
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});

const run = async () => {
  try { await tick(); } catch (err) { log(`Tick error: ${err.message}`); }
  setTimeout(run, TICK_INTERVAL_MS);
};

const summarizeLoop = async () => {
  try {
    const { sites } = loadConfig();
    for (const site of sites) {
      const domain = safeHostname(site.url);
      if (!domain) continue;
      let db;
      try {
        db = openDb(domain);
        await summarizeTopPending(db, domain);
      } catch {} finally { try { db?.close(); } catch {} }
    }
  } catch {}
  setTimeout(summarizeLoop, SUMMARIZE_INTERVAL_MS);
};

run();
setTimeout(summarizeLoop, 5000);
