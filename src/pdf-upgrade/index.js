// PDF upgrade loop: multi-pass (Marker → boss vision → Claude). Exports: (none, daemon). Deps: backfill, lang-detect, summarize, reocr, rebuild, score, marker-client, db
import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
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

const TICK_INTERVAL_MS = 60 * 1000;
const SUMMARIZE_INTERVAL_MS = 15 * 1000;
const MARKER_CONCURRENCY = 16;   // CPU-bound, tower-nas has 80 cores
const OCR_DOC_CONCURRENCY = 8;   // GPU-bound on boss (max_num_seqs=8)
const MARKER_SCORE_THRESHOLD = 0.55; // md quality to mark pass-1 done
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256file = (path) => sha256(readFileSync(path));
const now = () => new Date().toISOString();
const log = (msg) => console.log(`[pdf-upgrade] ${now().slice(0,19)} ${msg}`);

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
        SELECT u.upgraded_pdf_path, u.after_score, u.score_improvement, u.pages_processed, u.method
        FROM pdf_upgrade_queue u JOIN pdf_quality pq ON u.url=pq.url
        WHERE pq.content_hash=? AND u.status='done' AND u.upgraded_pdf_path IS NOT NULL
        LIMIT 1`).get(contentHash);
      if (hit && existsSync(hit.upgraded_pdf_path)) return hit;
    } catch {} finally { try { db?.close(); } catch {} }
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

    if (mdScore >= MARKER_SCORE_THRESHOLD) {
      db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, after_score=?, score_improvement=?, method=? WHERE url=?`)
        .run(now(), mdScore, mdScore - (row.before_score||0), 'marker', row.url);
      log(`Done (marker): ${row.url} md-score=${mdScore.toFixed(2)}`);
    } else {
      log(`Marker quality ${mdScore.toFixed(2)} < ${MARKER_SCORE_THRESHOLD} for ${row.url} → pass 2`);
      db.prepare("UPDATE pdf_upgrade_queue SET status='pending', pass=2 WHERE url=?").run(row.url);
    }
  } catch (err) {
    log(`Failed pass 1: ${row.url}: ${err.message}`);
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
        SELECT pq.pages, pq.pdf_title, pq.ai_summary, pq.ai_author, h.hosted_title, h.host_url as source_url
        FROM pdf_quality pq LEFT JOIN hosts h ON pq.url=h.hosted_url WHERE pq.url=?`).get(row.url);
      const numPages = quality?.pages || 1;
      const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
      const meta = {
        title:    quality?.hosted_title || quality?.pdf_title || (slug.length > 3 ? slug : undefined),
        author:   quality?.ai_author && quality.ai_author !== 'Unknown' ? quality.ai_author : undefined,
        subject:  quality?.ai_summary || undefined,
        keywords: ['site2rag', domain, ...(quality?.source_url ? [quality.source_url] : []), row.url]
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
      db.prepare(`UPDATE pdf_quality SET composite_score=?, has_text_layer=?, readable_pages_pct=?, avg_chars_per_page=?, word_quality_estimate=?, excerpt=? WHERE url=?`)
        .run(afterMetrics.composite_score, afterMetrics.has_text_layer, afterMetrics.readable_pages_pct, afterMetrics.avg_chars_per_page, afterMetrics.word_quality_estimate, afterMetrics.excerpt, row.url);
      log(`Done (${method}): ${row.url} ${(row.before_score||0).toFixed(2)} → ${afterMetrics.composite_score.toFixed(2)}`);

      if (siteConfig) {
        try {
          const { exportTextPdf } = await import('../export-doc.js');
          await exportTextPdf(db, siteConfig, { ...page, local_path: outputPath, content_hash: sha256file(outputPath) });
        } catch (e) { log(`MD export failed: ${e.message}`); }
      }
    } catch (err) {
      log(`Failed pass ${row.pass||2}: ${row.url}: ${err.message}`);
      // Permanent failures: encrypted PDFs, missing files — never retry
      const permanent = err.message?.includes('EncryptedPdf') || err.message?.includes('local_path missing') || err.message?.includes('Data format error');
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

const tick = async () => {
  let sites;
  try {
    ({ sites } = loadConfig());
  } catch (err) {
    log(`Config load failed: ${err.message}`);
    return;
  }
  if (!sites.length) return;

  // Filter out sites with invalid URLs before opening any DBs
  const validSites = sites.filter(site => safeHostname(site.url));

  const openDbs = [];
  try {
    for (const site of validSites) {
      const domain = safeHostname(site.url);
      try {
        openDbs.push({ db: openDb(domain), domain });
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

    // Pass 1 (Marker) and Pass 2+ (boss/Claude) run concurrently — CPU and GPU are independent
    const [markerOk, ocrBackend] = await Promise.all([markerAvailable(), ocrAvailableBackend()]);

    const runPass1 = async () => {
      if (!pass1.length) return;
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
      // Count already-running fire-and-forget OCR jobs across all sites
      let activeOcr = 0;
      for (const { db } of openDbs) {
        try { activeOcr += db.prepare("SELECT COUNT(*) as n FROM pdf_upgrade_queue WHERE status='processing' AND pass>=2").get().n; } catch {}
      }
      const available = Math.max(0, OCR_DOC_CONCURRENCY - activeOcr);
      if (available <= 0) { log(`Pass 2+ skipped — ${activeOcr} OCR jobs already active`); return; }
      pass2plus.sort((a,b) => (b.row.priority||0) - (a.row.priority||0));
      const batch = pass2plus.slice(0, available);
      log(`Pass 2+ (${ocrBackend}): ${batch.length} docs (fire-and-forget, ${activeOcr} already active)`);
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
        const n = db.prepare("UPDATE pdf_upgrade_queue SET status='pending', started_at=NULL WHERE status='processing'").run().changes;
        if (n) log(`Reset ${n} stuck docs to pending`);
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
