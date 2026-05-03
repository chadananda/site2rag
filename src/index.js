// site2rag -- PM2 entry point. 15-min tick scheduler; runs pipeline per due site.
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { loadConfig, getSiteRoot, getMirrorRoot, getMdRoot, getLogsRoot, mirrorDir, mdDir, metaDir } from './config.js';
import { openDb, startRun, finishRun } from './db.js';
import { runSitemap } from './sitemap.js';
import { runMirror } from './mirror.js';
import { runAssets } from './assets.js';
import { runClassify } from './classify.js';
import { runExportHtml } from './export-html.js';
import { runExportDoc } from './export-doc.js';
import { runArchive } from './archive.js';
import { runRetain } from './retain.js';
import { runScorePdfs } from './score-pdfs.js';
import { runSummarizePdfs } from './summarize-pdfs.js';
import { getMeta, setMeta } from './db.js';
const TICK_MS = 15 * 60 * 1000; // 15 minutes
/** Ensure all top-level directories exist. */
const ensureDirs = () => {
  [getMirrorRoot(), getMdRoot(), getLogsRoot()].forEach(d => mkdirSync(d, { recursive: true }));
};
/** Check if a site is due for a check based on check_every_days. */
const isDue = (db) => {
  const last = getMeta(db, 'last_check_at');
  if (!last) return true;
  const checkEveryMs = (db._siteCheckDays || 3) * 86400000;
  return (Date.now() - new Date(last).getTime()) >= checkEveryMs;
};
/** Write status.yaml for a site after each run. */
const writeStatusYaml = (siteConfig, db, runStats, runId) => {
  const domain = siteConfig.domain;
  const retentionCfg = siteConfig.retention || {};
  const frozen_since = getMeta(db, 'frozen_since') || null;
  const freeze_reason = getMeta(db, 'freeze_reason') || null;
  const totalPages = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE gone=0').get()?.cnt || 0;
  const windowDays = retentionCfg.freeze_on_degradation?.window_days ?? 30;
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const goneInWindow = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE gone=1 AND gone_since >= ?').get(since)?.cnt || 0;
  const newInWindow = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE first_seen_at >= ? AND gone=0').get(since)?.cnt || 0;
  const netLoss = goneInWindow - newInWindow;
  const threshold = Math.max((retentionCfg.freeze_on_degradation?.net_loss_threshold_pct ?? 10) / 100 * totalPages, retentionCfg.freeze_on_degradation?.net_loss_min_pages ?? 50);
  const tombstones = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE archive_only=1').get()?.cnt || 0;
  const nextGrace = db.prepare('SELECT MIN(gone_since) FROM pages WHERE gone=1 AND archive_only=0').get()?.['MIN(gone_since)'] || null;
  const classStats = db.prepare('SELECT page_role, COUNT(*) as cnt FROM pages WHERE gone=0 GROUP BY page_role').all();
  const classMap = Object.fromEntries(classStats.map(r => [r.page_role, r.cnt]));
  const exportRow = db.prepare("SELECT COUNT(*) as written, SUM(CASE WHEN status='ok' THEN 0 ELSE 1 END) as failed FROM exports").get();
  const ocrStats = db.prepare('SELECT SUM(pages) as total, SUM(ocr_used) as ocr_used FROM exports WHERE ocr_used=1').get();
  const archiveRow = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE backup_url IS NOT NULL').get();
  const tokenRows = db.prepare('SELECT provider, SUM(tokens_in) as tin, SUM(tokens_out) as tout FROM llm_calls GROUP BY provider').all();
  const tokens = Object.fromEntries(tokenRows.map(r => [r.provider, { input: r.tin, output: r.tout, cost_usd: 0 }]));
  const status = {
    site: { domain, url: siteConfig.url },
    last_check_at: new Date().toISOString(),
    last_success_at: runStats.status === 'success' ? new Date().toISOString() : getMeta(db, 'last_success_at'),
    last_status: runStats.status || 'unknown',
    sitemap: { total_urls: runStats.sitemap?.total || 0, added_today: runStats.sitemap?.added?.length || 0, changed_today: runStats.sitemap?.changed?.length || 0, removed_today: runStats.sitemap?.removed?.length || 0 },
    mirror: { pages_checked: runStats.mirror?.checked || 0, pages_new: runStats.mirror?.new_pages || 0, pages_changed: runStats.mirror?.changed || 0, pages_gone: runStats.mirror?.gone || 0, gc_deleted: runStats.retain?.gc_deleted || 0 },
    retention: { grace_days: retentionCfg.gone_grace_days ?? 90, frozen: !!frozen_since, frozen_since, freeze_reason, net_loss_in_window: netLoss, net_loss_threshold: Math.round(threshold), preserve_always: retentionCfg.preserve_always ?? false, tombstones_active: tombstones, next_grace_clear_at: nextGrace ? new Date(new Date(nextGrace).getTime() + (retentionCfg.gone_grace_days ?? 90) * 86400000).toISOString() : null },
    assets: { total: db.prepare('SELECT COUNT(*) as cnt FROM assets').get()?.cnt || 0, new: runStats.assets?.new_assets || 0, bytes: runStats.assets?.bytes || 0 },
    archive: { enabled: siteConfig.archive?.enabled ?? false, uploaded_today: runStats.archive?.uploaded || 0, skipped_unchanged: runStats.archive?.skipped || 0, archive_only_pages: db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE archive_only=1').get()?.cnt || 0, bucket_objects: archiveRow?.cnt || 0, bucket_bytes: 0, rewrite_html_assets: siteConfig.archive?.rewrite_html_assets ?? false },
    classify: { content: classMap['content'] || 0, index: classMap['index'] || 0, host_pages: classMap['host_page'] || 0, redirects: classMap['redirect'] || 0, rule_overrides_applied: runStats.classify?.rule_overrides || 0 },
    export: { enabled: siteConfig.export_md ?? false, written: exportRow?.written || 0, skipped_unchanged: runStats.exportHtml?.skipped || 0, failed: exportRow?.failed || 0 },
    ocr: { docs_processed: ocrStats?.ocr_used || 0, pages_total: ocrStats?.total || 0, pages_short_circuited: 0, reconciler_calls: db.prepare("SELECT COUNT(*) as cnt FROM llm_calls WHERE stage='ocr_reconcile'").get()?.cnt || 0, pages_flagged: 0, avg_agreement: db.prepare('SELECT AVG(agreement_avg) as avg FROM exports WHERE agreement_avg IS NOT NULL').get()?.avg || null },
    tokens: { ocr: tokens, total_cost_usd: 0 },
    rules: { rules_present: !!(siteConfig.rules && Object.keys(siteConfig.rules).length), rules_version: null },
    last_error: runStats.error || null
  };
  const statusPath = join(metaDir(domain), 'status.yaml');
  writeFileSync(statusPath, yaml.dump(status, { lineWidth: 120 }));
};
/** Run full pipeline for one site — hard-killed after 4h to prevent infinite hangs. */
const runSite = async (siteConfig) => {
  const domain = siteConfig.domain;
  const HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours absolute max
  const hardKill = setTimeout(() => {
    console.error(`[site2rag] ${domain} exceeded 4h hard timeout, forcing exit`);
    process.exit(1); // PM2 will restart
  }, HARD_TIMEOUT_MS);
  hardKill.unref(); // don't keep process alive just for this timer
  console.log(`[site2rag] starting site: ${domain}`);
  mkdirSync(metaDir(domain), { recursive: true });
  const db = openDb(domain);
  db._siteCheckDays = siteConfig.check_every_days ?? 3;
  const runId = startRun(db);
  const runStats = { status: 'running', sitemap: null, mirror: null, assets: null, classify: null, exportHtml: null, exportDoc: null, archive: null, retain: null, error: null };
  // Record check time at start so restarts don't immediately re-trigger this site
  setMeta(db, 'last_check_at', new Date().toISOString());
  try {
    // Sitemap
    const sitemapStats = await runSitemap(db, siteConfig);
    runStats.sitemap = sitemapStats;
    const priorityQueue = [...(sitemapStats.added || []), ...(sitemapStats.changed || [])];
    // Backfill: classify+export any pages left unclassified from prior runs
    if (siteConfig.classify?.enabled !== false) {
      runStats.classify = await runClassify(db, siteConfig);
    }
    if (siteConfig.export_md) {
      runStats.exportHtml = runExportHtml(db, siteConfig);
    }
    // Skip mirror entirely if sitemap reported no changes and we have a prior complete crawl
    const lastComplete = getMeta(db, 'last_complete_crawl_at');
    const sitemapUnchanged = sitemapStats.unchanged && lastComplete;
    if (sitemapUnchanged) {
      console.log(`[site2rag] ${domain} sitemap unchanged, skipping mirror`);
      runStats.mirror = { checked: 0, new_pages: 0, changed: 0, gone: 0, skipped: true };
    }
    // Mirror — classifies and exports each page inline as it's fetched
    const mirrorStats = sitemapUnchanged ? runStats.mirror : await runMirror(db, siteConfig, priorityQueue);
    runStats.mirror = mirrorStats;
    // Assets
    if (siteConfig.assets?.enabled !== false) {
      runStats.assets = await runAssets(db, siteConfig);
    }
    // Score PDFs (time-budgeted, 5 min max per run)
    runStats.scorePdfs = await runScorePdfs(db, siteConfig);
    // Summarize image PDFs with Haiku (time-budgeted, 10 min max per run)
    runStats.summarize = await runSummarizePdfs(db, siteConfig);
    // Export
    if (siteConfig.export_md) {
      runStats.exportHtml = runExportHtml(db, siteConfig);
      runStats.exportDoc = await Promise.race([
        runExportDoc(db, siteConfig),
        new Promise((_, rej) => setTimeout(() => rej(new Error('exportDoc timeout after 30min')), 30 * 60 * 1000))
      ]);
    }
    // Archive
    if (siteConfig.archive?.enabled) {
      runStats.archive = await runArchive(db, siteConfig);
    }
    // Retain
    runStats.retain = await runRetain(db, siteConfig, domain);
    runStats.status = 'success';
    setMeta(db, 'last_check_at', new Date().toISOString());
    setMeta(db, 'last_success_at', new Date().toISOString());
    finishRun(db, runId, 'success', { pages_new: mirrorStats.new_pages, pages_changed: mirrorStats.changed, pages_gone: mirrorStats.gone, pages_gc_deleted: runStats.retain?.gc_deleted || 0 });
  } catch (err) {
    runStats.status = 'failed';
    runStats.error = err.message;
    console.error(`[site2rag] site ${domain} failed: ${err.message}\n${err.stack || '(no stack)'}`);
    finishRun(db, runId, 'failed', { message: err.message });
  }
  clearTimeout(hardKill);
  writeStatusYaml(siteConfig, db, runStats, runId);
  db.close();
  console.log(`[site2rag] finished site: ${domain} (${runStats.status})`);
};
const runningDomains = new Set();
/** Main tick -- starts all due sites up to max_concurrent_sites. Each runs in parallel. */
const tick = async () => {
  let config;
  try { config = loadConfig(); } catch (err) { console.error(`[site2rag] config load failed: ${err.message}`); return; }
  const enabledSites = config.sites.filter(s => s.enabled !== false);
  const maxConcurrent = config.defaults?.max_concurrent_sites ?? 4;
  for (const site of enabledSites) {
    if (runningDomains.size >= maxConcurrent) { console.log(`[site2rag] max concurrent sites (${maxConcurrent}) reached, deferring remaining`); break; }
    if (runningDomains.has(site.domain)) { console.log(`[site2rag] ${site.domain} already running, skipping tick`); continue; }
    let db;
    try {
      mkdirSync(metaDir(site.domain), { recursive: true });
      db = openDb(site.domain);
      const due = isDue(db);
      db.close();
      if (!due) { console.log(`[site2rag] ${site.domain} not due, skipping`); continue; }
    } catch { continue; }
    runningDomains.add(site.domain);
    console.log(`[site2rag] starting ${site.domain} (${runningDomains.size}/${maxConcurrent} running)`);
    runSite(site).catch(err => console.error(`[site2rag] unhandled error for ${site.domain}: ${err.message}`)).finally(() => runningDomains.delete(site.domain));
  }
};
// Startup
ensureDirs();
process.on('unhandledRejection', (reason) => {
  console.error(`[site2rag] unhandledRejection: ${reason?.message ?? reason}\n${reason?.stack || ''}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[site2rag] uncaughtException: ${err.message}\n${err.stack || ''}`);
});
console.log(`[site2rag] starting, SITE2RAG_ROOT=${getSiteRoot()}`);
tick();
setInterval(tick, TICK_MS);
