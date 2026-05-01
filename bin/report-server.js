// site2rag API server -- live data from SQLite, served to the Cloudflare Pages frontend.
// Routes: GET /api/sites, GET /api/docs, GET /api/runs
import { createServer } from 'http';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, getMirrorRoot } from '../src/config.js';
import { openDb } from '../src/db.js';

const PORT = parseInt(process.env.REPORT_PORT || '7840', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://site2rag.lnker.com';
const PER_PAGE = 50;

const json = (res, data, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
};

const err = (res, status, msg) => json(res, { error: msg }, status);

/** Open a site DB safely; return null if missing. */
const safeOpenDb = (domain) => {
  const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
  if (!existsSync(dbPath)) return null;
  try { return openDb(domain); } catch { return null; }
};

/** Summary stats for one site. */
const siteSummary = (domain, siteUrl) => {
  const db = safeOpenDb(domain);
  if (!db) return { domain, url: siteUrl, available: false };
  try {
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_pages,
        SUM(CASE WHEN mime_type='application/pdf' AND gone=0 THEN 1 ELSE 0 END) as total_pdfs
      FROM pages
    `).get();
    const pdf = db.prepare(`
      SELECT
        COUNT(*) as scored,
        SUM(CASE WHEN u.status='done' THEN 1 ELSE 0 END) as upgraded,
        SUM(CASE WHEN u.status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN u.status='processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN u.status='failed' THEN 1 ELSE 0 END) as failed
      FROM pdf_quality q
      LEFT JOIN pdf_upgrade_queue u ON q.url = u.url
    `).get();
    const lastRun = db.prepare(`SELECT started_at, status FROM runs ORDER BY id DESC LIMIT 1`).get();
    const doneDocs = db.prepare(`SELECT started_at, finished_at FROM pdf_upgrade_queue WHERE status='done' AND finished_at IS NOT NULL`).all();
    const avgSec = doneDocs.length
      ? doneDocs.reduce((a, d) => a + (new Date(d.finished_at) - new Date(d.started_at)) / 1000, 0) / doneDocs.length
      : 300;
    return {
      domain, url: siteUrl, available: true,
      total_pages: totals.total_pages || 0,
      total_pdfs: totals.total_pdfs || 0,
      scored: pdf.scored || 0,
      upgraded: pdf.upgraded || 0,
      pending: pdf.pending || 0,
      processing: pdf.processing || 0,
      failed: pdf.failed || 0,
      eta_seconds: (pdf.pending || 0) * avgSec,
      last_run: lastRun || null
    };
  } finally { db.close(); }
};

/** Paginated, filtered doc list for one site. */
const siteDocs = (domain, params) => {
  const db = safeOpenDb(domain);
  if (!db) return null;
  try {
    const page = Math.max(1, parseInt(params.get('page') || '1', 10));
    const q = (params.get('q') || '').trim();
    const status = params.get('status') || '';
    const scoreMax = parseFloat(params.get('score_max') || '1');
    const sort = params.get('sort') || 'score_asc';
    const offset = (page - 1) * PER_PAGE;

    const wheres = ["p.gone=0", "p.mime_type='application/pdf'"];
    const vals = [];

    if (q) { wheres.push("(p.url LIKE ? OR h.hosted_title LIKE ?)"); vals.push(`%${q}%`, `%${q}%`); }
    if (status === 'unscored') wheres.push("q.composite_score IS NULL");
    else if (status) { wheres.push("u.status=?"); vals.push(status); }
    if (scoreMax < 1) { wheres.push("(q.composite_score IS NULL OR q.composite_score <= ?)"); vals.push(scoreMax); }

    const orderMap = {
      score_asc: 'COALESCE(q.composite_score, 1) ASC',
      score_desc: 'COALESCE(q.composite_score, 0) DESC',
      pages_desc: 'COALESCE(q.pages, 0) DESC',
      title_asc: 'COALESCE(h.hosted_title, p.url) ASC',
      improved_desc: 'COALESCE(u.score_improvement, 0) DESC'
    };
    const orderBy = orderMap[sort] || orderMap.score_asc;
    const where = wheres.join(' AND ');

    const total = db.prepare(`
      SELECT COUNT(*) as n FROM pages p
      LEFT JOIN pdf_quality q ON p.url=q.url
      LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
      LEFT JOIN hosts h ON p.url=h.hosted_url
      WHERE ${where}
    `).get(...vals).n;

    const rows = db.prepare(`
      SELECT p.url, p.path_slug, p.last_seen_at,
             q.composite_score, q.pages, q.word_quality_estimate, q.readable_pages_pct,
             u.status, u.before_score, u.after_score, u.score_improvement,
             u.upgraded_pdf_path, u.started_at, u.finished_at, u.error,
             h.hosted_title as title
      FROM pages p
      LEFT JOIN pdf_quality q ON p.url=q.url
      LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
      LEFT JOIN hosts h ON p.url=h.hosted_url
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${PER_PAGE} OFFSET ${offset}
    `).all(...vals);

    const docs = rows.map(d => ({
      ...d,
      archive_url: d.status === 'done' && d.upgraded_pdf_path
        ? `https://${domain}.lnker.com/_upgraded/${d.path_slug || d.url.replace(/[^a-z0-9]/gi,'_').slice(-60)}.pdf`
        : null
    }));

    return { docs, total, page, pages: Math.ceil(total / PER_PAGE), per_page: PER_PAGE };
  } finally { db.close(); }
};

/** Recent runs across all sites. */
const recentRuns = (sites) => {
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

// Router
createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  let cfg;
  try { cfg = loadConfig(); } catch (e) { return err(res, 500, `Config error: ${e.message}`); }
  const sites = cfg.sites.map(s => ({ domain: new URL(s.url).hostname, url: s.url }));

  if (path === '/api/sites') {
    return json(res, sites.map(s => siteSummary(s.domain, s.url)));
  }

  if (path === '/api/docs') {
    const domain = url.searchParams.get('site');
    if (!domain) return err(res, 400, 'site param required');
    const result = siteDocs(domain, url.searchParams);
    if (!result) return err(res, 404, `No data for ${domain}`);
    return json(res, result);
  }

  if (path === '/api/runs') {
    return json(res, recentRuns(sites));
  }

  err(res, 404, 'Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[report-server] API listening on http://127.0.0.1:${PORT}`);
});
