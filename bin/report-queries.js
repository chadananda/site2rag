// SQL query functions for API routes: site summaries, doc lists, recent runs. Exports: siteSummary, siteDocs, recentRuns. Deps: db, config, report-utils
import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getMirrorRoot, mdDir } from '../src/config.js';
import { openDb } from '../src/db.js';
import { mapDoc } from './report-utils.js';

const PER_PAGE = 50;

const dirSizeBytes = (path) => {
  if (!existsSync(path)) return 0;
  try { return parseInt(execSync(`du -sb "${path}"`, { timeout: 10000 }).toString().split('\t')[0], 10) || 0; }
  catch { return 0; }
};

const safeOpenDb = (domain) => {
  const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
  if (!existsSync(dbPath)) return null;
  try { return openDb(domain); } catch { return null; }
};

/** Aggregate stats for one site domain. */
export const siteSummary = (domain, siteUrl) => {
  const db = safeOpenDb(domain);
  if (!db) return { domain, url: siteUrl, available: false };
  try {
    const totals = db.prepare(`SELECT COUNT(*) as total_pages, SUM(CASE WHEN mime_type='application/pdf' THEN 1 ELSE 0 END) as total_pdfs, SUM(CASE WHEN mime_type LIKE 'text/html%' THEN 1 ELSE 0 END) as total_html FROM pages WHERE gone=0`).get();
    const classify = db.prepare(`SELECT SUM(CASE WHEN page_role='content' THEN 1 ELSE 0 END) as content, SUM(CASE WHEN page_role='index' THEN 1 ELSE 0 END) as index_pages, SUM(CASE WHEN page_role='host_page' THEN 1 ELSE 0 END) as host_pages, SUM(CASE WHEN page_role IS NOT NULL THEN 1 ELSE 0 END) as classified FROM pages WHERE gone=0 AND mime_type LIKE 'text/html%'`).get();
    const pdf = db.prepare(`
      SELECT COUNT(*) as scored,
        SUM(CASE WHEN u.status='done' THEN 1 ELSE 0 END) as upgraded,
        SUM(CASE WHEN u.status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN u.status='processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN u.status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN q.skip=1 THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN u.url IS NULL AND q.skip=0 AND q.composite_score >= 0.7 THEN 1 ELSE 0 END) as already_ok,
        SUM(CASE WHEN q.summary_tier='haiku' THEN 1 ELSE 0 END) as summarized_haiku,
        SUM(CASE WHEN q.ai_summary IS NOT NULL THEN 1 ELSE 0 END) as summarized_any,
        SUM(CASE WHEN (q.has_text_layer=0 OR q.has_text_layer IS NULL OR q.readable_pages_pct < 0.4) THEN 1 ELSE 0 END) as image_pdfs,
        SUM(CASE WHEN (q.has_text_layer=0 OR q.has_text_layer IS NULL OR q.readable_pages_pct < 0.4) AND q.ai_summary IS NOT NULL THEN 1 ELSE 0 END) as image_pdfs_summarized
      FROM pdf_quality q
      LEFT JOIN pdf_upgrade_queue u ON q.url=u.url
      JOIN pages p ON q.url=p.url AND p.gone=0`).get();
    const exp = db.prepare(`SELECT SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM exports`).get();
    const lastRun = db.prepare(`SELECT started_at, finished_at, status, message FROM runs ORDER BY id DESC LIMIT 1`).get();
    const recentFails = db.prepare(`SELECT COUNT(*) as cnt FROM runs WHERE status='failed' AND started_at > datetime('now','-1 day')`).get()?.cnt || 0;
    const doneDocs = db.prepare(`SELECT started_at, finished_at FROM pdf_upgrade_queue WHERE status='done' AND finished_at IS NOT NULL`).all();
    const avgSec = doneDocs.length
      ? doneDocs.reduce((a, d) => a + (new Date(d.finished_at) - new Date(d.started_at)) / 1000, 0) / doneDocs.length
      : 300;
    const mirrorProgressRaw = db.prepare(`SELECT value FROM site_meta WHERE key='mirror_progress'`).get()?.value;
    const mirror_progress = mirrorProgressRaw ? JSON.parse(mirrorProgressRaw) : null;
    const total_cost_usd = db.prepare('SELECT SUM(cost_usd) as total FROM llm_calls').get()?.total || 0;
    return {
      domain, url: siteUrl, available: true,
      total_pages: totals.total_pages || 0, total_html: totals.total_html || 0, total_pdfs: totals.total_pdfs || 0,
      pages_classified: classify.classified || 0, pages_content: classify.content || 0,
      pages_index: classify.index_pages || 0, pages_host: classify.host_pages || 0,
      scored: pdf.scored || 0, upgraded: pdf.upgraded || 0,
      pending: pdf.pending || 0, processing: pdf.processing || 0,
      failed: pdf.failed || 0, skipped: pdf.skipped || 0, already_ok: pdf.already_ok || 0,
      summarized_haiku: pdf.summarized_haiku || 0, summarized_any: pdf.summarized_any || 0,
      image_pdfs: pdf.image_pdfs || 0, image_pdfs_summarized: pdf.image_pdfs_summarized || 0,
      eta_seconds: (pdf.pending || 0) * avgSec,
      md_exported: exp.ok || 0, md_failed: exp.failed || 0,
      md_dir: mdDir(domain),
      total_cost_usd,
      last_run: lastRun || null,
      recent_fails: recentFails,
      mirror_progress,
      mirror_size_bytes: dirSizeBytes(join(getMirrorRoot(), domain)),
      md_size_bytes: dirSizeBytes(mdDir(domain))
    };
  } finally { db.close(); }
};

const DOC_SELECT = `
  SELECT p.url, p.path_slug, p.last_seen_at,
         q.composite_score, q.pages, q.word_quality_estimate, q.readable_pages_pct,
         q.avg_chars_per_page, q.has_text_layer, q.skip,
         COALESCE(h.hosted_title, q.pdf_title) as title,
         q.excerpt, q.ai_summary, q.ai_author, q.ai_summarized_at,
         q.thumbnail_path, q.summary_tier, q.ai_language,
         h.host_url as source_url,
         u.status, u.before_score, u.after_score, u.score_improvement,
         u.upgraded_pdf_path, u.pages_processed, u.method, u.finished_at, u.error
  FROM pages p
  LEFT JOIN pdf_quality q ON p.url=q.url
  LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
  LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON p.url=h.hosted_url`;

/** Server-side filtered + paginated doc list. */
export const siteDocs = (domain, params) => {
  const db = safeOpenDb(domain);
  if (!db) return null;
  try {
    const page = Math.max(1, parseInt(params.get('page') || '1', 10));
    const q = (params.get('q') || '').trim();
    const status = params.get('status') || '';
    const scoreMax = parseFloat(params.get('score_max') || '1');
    const sort = params.get('sort') || 'score_asc';
    const tab = params.get('tab') || 'queue';
    const offset = (page - 1) * PER_PAGE;

    const wheres = ["p.gone=0", "p.mime_type='application/pdf'", "LOWER(p.url) LIKE '%.pdf'"];
    const vals = [];

    if (tab === 'upgraded') {
      wheres.push("u.status='done'");
    } else if (tab === 'adequate') {
      wheres.push("(u.url IS NULL OR u.status IS NULL)");
      wheres.push("q.composite_score >= 0.7");
      wheres.push("(q.skip IS NULL OR q.skip=0)");
      wheres.push("COALESCE(q.pages, 2) > 1");
    } else {
      wheres.push("(u.status IS NULL OR u.status != 'done')");
      wheres.push("(q.has_text_layer=0 OR q.has_text_layer IS NULL OR q.readable_pages_pct < 0.4)");
      wheres.push("(q.skip IS NULL OR q.skip=0)");
    }

    if (q) { wheres.push("(p.url LIKE ? OR COALESCE(h.hosted_title,q.pdf_title) LIKE ? OR q.excerpt LIKE ?)"); vals.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status === 'unscored') wheres.push("q.composite_score IS NULL");
    else if (status === 'skipped') wheres.push("q.skip=1");
    else if (status) { wheres.push("u.status=?"); vals.push(status); }
    if (scoreMax < 1) { wheres.push("(q.composite_score IS NULL OR q.composite_score <= ?)"); vals.push(scoreMax); }

    const orderMap = {
      score_asc: 'COALESCE(q.composite_score, 1) ASC',
      score_desc: 'COALESCE(q.composite_score, 0) DESC',
      pages_desc: 'COALESCE(q.pages, 0) DESC',
      title_asc: 'COALESCE(h.hosted_title, p.url) ASC',
      improved_desc: 'COALESCE(u.score_improvement, 0) DESC'
    };
    const orderBy = tab === 'upgraded'
      ? (orderMap[sort] || 'COALESCE(u.score_improvement, 0) DESC')
      : tab === 'adequate'
        ? (orderMap[sort] || orderMap.score_desc)
        : (sort && orderMap[sort])
          ? `CASE WHEN u.status='processing' THEN 0 ELSE 1 END ASC, ${orderMap[sort]}`
          : `CASE WHEN u.status='processing' THEN 0 ELSE 1 END ASC, ${orderMap.score_asc}`;
    const where = wheres.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as n FROM pages p
      LEFT JOIN pdf_quality q ON p.url=q.url LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
      LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON p.url=h.hosted_url
      WHERE ${where}`).get(...vals).n;
    const rows = db.prepare(`${DOC_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ${PER_PAGE} OFFSET ${offset}`).all(...vals);
    return { docs: rows.map(d => mapDoc(d, domain)), total, page, pages: Math.ceil(total / PER_PAGE), per_page: PER_PAGE };
  } finally { db.close(); }
};

/** Recent runs across all sites, sorted newest first. */
export const recentRuns = (sites) => {
  const runs = [];
  for (const { domain } of sites) {
    const db = safeOpenDb(domain);
    if (!db) continue;
    try {
      const rows = db.prepare(`SELECT *, '${domain}' as domain FROM runs ORDER BY id DESC LIMIT 5`).all();
      runs.push(...rows);
    } finally { db.close(); }
  }
  return runs.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || '')).slice(0, 20);
};
