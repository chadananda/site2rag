// site2rag API + report server. Routes: /api/sites, /api/docs, /api/thumbnail, /api/docs/skip, /api/docs/summarize; static public/.
import { createServer } from 'http';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { Worker } from 'worker_threads';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { cpus } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, getMirrorRoot } from '../src/config.js';
import { openDb } from '../src/db.js';

// Language key → display name
const LANG_DISPLAY = { english: 'English', russian: 'Russian', arabic: 'Arabic', persian: 'Persian', hebrew: 'Hebrew', japanese: 'Japanese', chinese: 'Chinese', unknown: null };
// Cost multiplier per language (English = 1.0 baseline) — matches score.js LANG_COST
const LANG_COST = { english: 1.0, russian: 1.15, unknown: 1.2, arabic: 1.35, persian: 1.35, hebrew: 1.35, japanese: 1.5, chinese: 1.5 };

/** Detect primary language from Unicode composition of a text sample. Returns lowercase key. */
const detectLanguage = (text) => {
  if (!text || text.length < 15) return 'unknown';
  const len = text.length;
  if ((text.match(/[\u0600-\u06FF]/g) || []).length / len > 0.07)
    return (text.match(/[\u067E\u0686\u0698\u06AF]/g) || []).length > 0 ? 'persian' : 'arabic';
  if ((text.match(/[\u0590-\u05FF]/g) || []).length / len > 0.07) return 'hebrew';
  if ((text.match(/[\u3040-\u30FF]/g) || []).length / len > 0.05) return 'japanese';
  if ((text.match(/[\u4E00-\u9FFF]/g) || []).length / len > 0.07) return 'chinese';
  if ((text.match(/[\u0400-\u04FF]/g) || []).length / len > 0.07) return 'russian';
  if ((text.match(/[a-zA-Z]/g) || []).length / len > 0.3) return 'english';
  return 'unknown';
};

/** Strip HTML tags and decode common entities from a chunk of HTML. */
const stripHtml = (html) => html
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Extract the paragraph/context surrounding a PDF link in a host page's HTML. */
const getLinkContext = (html, pdfUrl) => {
  const candidates = [pdfUrl.split('/').pop(), decodeURIComponent(pdfUrl.split('/').pop())];
  for (const needle of candidates) {
    const idx = html.indexOf(needle);
    if (idx < 0) continue;
    // Try to bound by nearest paragraph tags
    const pStart = html.lastIndexOf('<p', idx);
    const pEnd = html.indexOf('</p>', idx);
    const start = (pStart > 0 && pStart > idx - 1000) ? pStart : Math.max(0, idx - 400);
    const end   = (pEnd > 0  && pEnd  < idx + 1000)  ? pEnd + 4 : Math.min(html.length, idx + 400);
    const ctx = stripHtml(html.slice(start, end)).slice(0, 600).trim();
    if (ctx.length > 30) return ctx;
  }
  return null;
};

/** Free (no-API) summary composed from available metadata. */
const buildFreeSummary = (row) => {
  const title = row.title || null; // already COALESCE'd from hosts + pdf_quality
  const domain = row.source_url ? row.source_url.replace(/^https?:\/\//, '').split('/')[0] : null;
  const excerpt = row.excerpt ? row.excerpt.replace(/\s+/g, ' ').trim() : null;
  if (title && excerpt && excerpt.length > 40) {
    const short = excerpt.length > 160 ? excerpt.slice(0, 160).replace(/\s\S*$/, '…') : excerpt;
    return domain ? `${title} — ${short} [${domain}]` : `${title} — ${short}`;
  }
  if (excerpt && excerpt.length > 40) {
    return excerpt.length > 200 ? excerpt.slice(0, 200).replace(/\s\S*$/, '…') : excerpt;
  }
  if (title && domain) return `${title} (from ${domain})`;
  return title || null;
};
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const PDFJS_DIR = resolve(__dirname, '..', 'node_modules', 'pdfjs-dist');
const serveStatic = (res, reqPath) => {
  const filePath = join(PUBLIC_DIR, reqPath === '/' ? 'index.html' : reqPath);
  if (!existsSync(filePath)) {
    const index = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(index)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(readFileSync(index));
  }
  const mime = STATIC_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
  res.end(readFileSync(filePath));
};

const PORT = parseInt(process.env.REPORT_PORT || '7840', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://site2rag.lnker.com';
const PER_PAGE = 50;

const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const noCacheHeaders = { ...corsHeaders, 'Cache-Control': 'no-cache, no-store' };
const cacheHeaders = (maxAge = 86400) => ({ ...corsHeaders, 'Cache-Control': `public, max-age=${maxAge}` });

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...noCacheHeaders });
  res.end(JSON.stringify(data));
};
const err = (res, status, msg) => json(res, { error: msg }, status);

const safeOpenDb = (domain) => {
  const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
  if (!existsSync(dbPath)) return null;
  try { return openDb(domain); } catch { return null; }
};

const mapDoc = (d, domain) => {
  // Inject free summary if no stored AI summary
  const ai_summary = d.ai_summary || buildFreeSummary(d) || null;
  const summary_tier = d.summary_tier || (ai_summary && !d.ai_summary ? 'free' : null);
  // Language: stored key from scoring, or detect from text, normalize to display name
  const langKey = d.ai_language || detectLanguage([d.excerpt, d.title].filter(Boolean).join(' ')) || 'unknown';
  const ai_language = LANG_DISPLAY[langKey] ?? null;
  const lang_cost_mult = LANG_COST[langKey] ?? LANG_COST.unknown;
  // Estimated OCR cost in minutes, adjusted for language
  const pages = d.pages || 0;
  const readablePct = d.readable_pages_pct ?? 0;
  const pagesNeeded = Math.round(pages * (1 - readablePct));
  const effort_mins = pagesNeeded > 0 ? Math.max(1, Math.round(pagesNeeded * 0.5 * lang_cost_mult)) : 0;
  return {
    ...d,
    ai_summary,
    summary_tier,
    ai_language,
    lang_key: langKey,
    effort_mins,
    archive_url: d.status === 'done' && d.upgraded_pdf_path
      ? `https://${domain}.lnker.com/_upgraded/${d.path_slug || d.url.replace(/[^a-z0-9]/gi,'_').slice(-60)}.pdf`
      : null,
  };
};

/** Persistent worker pool for thumbnail generation (pdfjs+canvas in isolated threads). */
const THUMB_WORKERS = Math.max(4, Math.floor(cpus().length / 4));
const WORKER_SCRIPT = resolve(import.meta.dirname, 'thumb-worker.js');
let _jobId = 0;
const _pending = new Map(); // jobId -> { resolve, reject }
const _queue = [];          // { jobId, pdfPath, outPath, targetW, pageNo }
const _workers = [];        // { worker, busy }

const _dispatch = (slot) => {
  if (!_queue.length) { slot.busy = false; return; }
  const job = _queue.shift();
  slot.busy = true;
  slot.worker.postMessage(job);
};

const _makeWorker = () => {
  const slot = { worker: new Worker(WORKER_SCRIPT), busy: false };
  slot.worker.on('message', ({ jobId, success, error }) => {
    const p = _pending.get(jobId);
    _pending.delete(jobId);
    if (p) (success ? p.resolve : p.reject)(success ? undefined : new Error(error));
    _dispatch(slot);
  });
  slot.worker.on('error', (e) => {
    // Worker crashed — drain its pending job then respawn
    console.error('[thumb-worker] crashed:', e.message);
    slot.worker.terminate();
    Object.assign(slot, { worker: new Worker(WORKER_SCRIPT), busy: false });
    slot.worker.on('message', ({ jobId, success, error }) => {
      const p = _pending.get(jobId); _pending.delete(jobId);
      if (p) (success ? p.resolve : p.reject)(success ? undefined : new Error(error));
      _dispatch(slot);
    });
    slot.worker.on('error', () => _dispatch(slot));
    _dispatch(slot);
  });
  return slot;
};
for (let i = 0; i < THUMB_WORKERS; i++) _workers.push(_makeWorker());

/** Queue a thumbnail generation job; resolves when the file is written. */
const generateThumb = (pdfPath, outPath, targetW = 300, pageNo = 1) =>
  new Promise((resolve, reject) => {
    const jobId = ++_jobId;
    _pending.set(jobId, { resolve, reject });
    const free = _workers.find(w => !w.busy);
    if (free) { free.busy = true; free.worker.postMessage({ jobId, pdfPath, outPath, targetW, pageNo }); }
    else _queue.push({ jobId, pdfPath, outPath, targetW, pageNo });
  });

/** Summary stats for one site. */
const siteSummary = (domain, siteUrl) => {
  const db = safeOpenDb(domain);
  if (!db) return { domain, url: siteUrl, available: false };
  try {
    const totals = db.prepare(`
      SELECT COUNT(*) as total_pages,
        SUM(CASE WHEN mime_type='application/pdf' AND gone=0 THEN 1 ELSE 0 END) as total_pdfs,
        SUM(CASE WHEN mime_type LIKE 'text/html%' AND gone=0 THEN 1 ELSE 0 END) as total_html
      FROM pages`).get();
    const classify = db.prepare(`
      SELECT SUM(CASE WHEN page_role='content' THEN 1 ELSE 0 END) as content,
        SUM(CASE WHEN page_role='index' THEN 1 ELSE 0 END) as index_pages,
        SUM(CASE WHEN page_role='host_page' THEN 1 ELSE 0 END) as host_pages,
        SUM(CASE WHEN page_role IS NOT NULL THEN 1 ELSE 0 END) as classified
      FROM pages WHERE gone=0 AND mime_type LIKE 'text/html%'`).get();
    const pdf = db.prepare(`
      SELECT COUNT(*) as scored,
        SUM(CASE WHEN u.status='done' THEN 1 ELSE 0 END) as upgraded,
        SUM(CASE WHEN u.status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN u.status='processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN u.status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN q.skip=1 THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN u.url IS NULL AND q.skip=0 AND q.composite_score >= 0.7 THEN 1 ELSE 0 END) as already_ok,
        SUM(CASE WHEN q.summary_tier='haiku' THEN 1 ELSE 0 END) as summarized_haiku,
        SUM(CASE WHEN q.ai_summary IS NOT NULL THEN 1 ELSE 0 END) as summarized_any
      FROM pdf_quality q
      LEFT JOIN pdf_upgrade_queue u ON q.url=u.url
      JOIN pages p ON q.url=p.url AND p.gone=0`).get();
    const exp = db.prepare(`
      SELECT SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM exports`).get();
    const lastRun = db.prepare(`SELECT started_at, finished_at, status, message FROM runs ORDER BY id DESC LIMIT 1`).get();
    const recentFails = db.prepare(`SELECT COUNT(*) as cnt FROM runs WHERE status='failed' AND started_at > datetime('now','-1 day')`).get()?.cnt || 0;
    const doneDocs = db.prepare(`SELECT started_at, finished_at FROM pdf_upgrade_queue WHERE status='done' AND finished_at IS NOT NULL`).all();
    const avgSec = doneDocs.length
      ? doneDocs.reduce((a, d) => a + (new Date(d.finished_at) - new Date(d.started_at)) / 1000, 0) / doneDocs.length
      : 300;
    return {
      domain, url: siteUrl, available: true,
      total_pages: totals.total_pages || 0, total_html: totals.total_html || 0, total_pdfs: totals.total_pdfs || 0,
      pages_classified: classify.classified || 0, pages_content: classify.content || 0,
      pages_index: classify.index_pages || 0, pages_host: classify.host_pages || 0,
      scored: pdf.scored || 0, upgraded: pdf.upgraded || 0,
      pending: pdf.pending || 0, processing: pdf.processing || 0,
      failed: pdf.failed || 0, skipped: pdf.skipped || 0, already_ok: pdf.already_ok || 0,
      summarized_haiku: pdf.summarized_haiku || 0, summarized_any: pdf.summarized_any || 0,
      eta_seconds: (pdf.pending || 0) * avgSec,
      md_exported: exp.ok || 0, md_failed: exp.failed || 0,
      last_run: lastRun || null,
      recent_fails: recentFails
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
const siteDocs = (domain, params) => {
  const db = safeOpenDb(domain);
  if (!db) return null;
  try {
    const page = Math.max(1, parseInt(params.get('page') || '1', 10));
    const q = (params.get('q') || '').trim();
    const status = params.get('status') || '';
    const scoreMax = parseFloat(params.get('score_max') || '1');
    const sort = params.get('sort') || 'score_asc';
    const tab = params.get('tab') || 'queue'; // 'queue' = image PDFs needing upgrade, 'upgraded' = done
    const offset = (page - 1) * PER_PAGE;

    const wheres = ["p.gone=0", "p.mime_type='application/pdf'",
      "LOWER(p.url) LIKE '%.pdf'"];
    const vals = [];

    // Tab filtering
    if (tab === 'upgraded') {
      wheres.push("u.status='done'");
    } else if (tab === 'adequate') {
      // Adequate: PDFs already readable enough, not in upgrade queue; exclude 1-page book covers
      wheres.push("(u.url IS NULL OR u.status IS NULL)");
      wheres.push("q.composite_score >= 0.7");
      wheres.push("(q.skip IS NULL OR q.skip=0)");
      wheres.push("COALESCE(q.pages, 2) > 1");
    } else {
      // Failed tab (default): image PDFs needing upgrade, not yet done
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
        : (orderMap[sort] || orderMap.score_asc);
    const where = wheres.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as n FROM pages p
      LEFT JOIN pdf_quality q ON p.url=q.url LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
      LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON p.url=h.hosted_url
      WHERE ${where}`).get(...vals).n;

    const rows = db.prepare(`${DOC_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ${PER_PAGE} OFFSET ${offset}`).all(...vals);
    return { docs: rows.map(d => mapDoc(d, domain)), total, page, pages: Math.ceil(total / PER_PAGE), per_page: PER_PAGE };
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

// Prevent unhandled rejections from crashing the server
process.on('uncaughtException', e => console.error('[server] uncaught:', e.message));
process.on('unhandledRejection', e => console.error('[server] unhandled rejection:', e?.message ?? e));

// Router
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  let cfg;
  try { cfg = loadConfig(); } catch (e) { return err(res, 500, `Config error: ${e.message}`); }
  const sites = cfg.sites.map(s => ({ domain: new URL(s.url).hostname, url: s.url }));

  if (path === '/api/sites') {
    return json(res, { sites: sites.map(s => siteSummary(s.domain, s.url)) });
  }

  if (path === '/api/docs') {
    const domain = url.searchParams.get('site');
    if (!domain) return err(res, 400, 'site param required');
    try {
      const result = siteDocs(domain, url.searchParams);
      if (!result) return err(res, 404, `No data for ${domain}`);
      return json(res, result);
    } catch (e) { return err(res, 500, e.message); }
  }

  if (path === '/api/thumbnail') {
    const docUrl = url.searchParams.get('url');
    if (!docUrl) return err(res, 400, 'url param required');
    const domain = sites.find(s => docUrl.startsWith(`https://${s.domain}`) || docUrl.startsWith(`http://${s.domain}`))?.domain;
    if (!domain) return err(res, 404, 'unknown domain');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try { row = db.prepare('SELECT local_path, path_slug FROM pages WHERE url=?').get(docUrl); }
    finally { db.close(); }
    if (!row?.local_path || !existsSync(row.local_path)) return err(res, 404, 'pdf not found');

    const w = Math.min(1200, Math.max(50, parseInt(url.searchParams.get('w') || '300', 10)));
    const pageNo = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const hash = createHash('sha256').update(docUrl).digest('hex').slice(0, 16);
    const thumbDir = join(getMirrorRoot(), domain, '.thumbs');
    const thumbPath = join(thumbDir, `x${hash}_p${pageNo}_${w}w.jpg`);

    if (existsSync(thumbPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', ...cacheHeaders(604800) });
      return res.end(readFileSync(thumbPath));
    }

    try {
      mkdirSync(thumbDir, { recursive: true });
      await generateThumb(row.local_path, thumbPath, w, pageNo);
      if (w === 144 && pageNo === 1) {
        const db2 = safeOpenDb(domain);
        if (db2) { try { db2.prepare('UPDATE pdf_quality SET thumbnail_path=? WHERE url=?').run(thumbPath, docUrl); } finally { db2.close(); } }
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', ...cacheHeaders(604800) });
      return res.end(readFileSync(thumbPath));
    } catch (e) {
      console.error(`[thumbnail] failed for ${docUrl}: ${e.message}`);
    }
    return err(res, 404, 'thumbnail unavailable');
  }

  if (path === '/api/docs/download') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try { row = db.prepare("SELECT upgraded_pdf_path FROM pdf_upgrade_queue WHERE url=? AND status='done'").get(docUrl); }
    finally { db.close(); }
    if (!row?.upgraded_pdf_path || !existsSync(row.upgraded_pdf_path)) return err(res, 404, 'upgraded pdf not found');
    const filename = decodeURIComponent(docUrl.split('/').pop()) || 'document.pdf';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, ...cacheHeaders(3600) });
    return res.end(readFileSync(row.upgraded_pdf_path));
  }

  if (path === '/api/docs/skip' && req.method === 'POST') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    const skip = url.searchParams.get('skip') !== '0';
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    try {
      db.prepare('UPDATE pdf_quality SET skip=? WHERE url=?').run(skip ? 1 : 0, docUrl);
      return json(res, { ok: true, skip });
    } finally { db.close(); }
  }

  if (path === '/api/runs') {
    return json(res, recentRuns(sites));
  }

  if (path === '/api/docs/summarize-batch' && req.method === 'POST') {
    const domain = url.searchParams.get('site');
    const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10));
    const concurrency = Math.min(40, parseInt(url.searchParams.get('concurrency') || '20', 10));
    if (!domain) return err(res, 400, 'site param required');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return err(res, 503, 'ANTHROPIC_API_KEY not set');

    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let rows;
    try {
      rows = db.prepare(`
        SELECT q.url, q.pdf_title, q.excerpt, h.hosted_title, h.host_url as source_url
        FROM pdf_quality q
        LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON q.url=h.hosted_url
        WHERE q.ai_summarized_at IS NULL
          AND (q.has_text_layer=0 OR q.has_text_layer IS NULL OR q.readable_pages_pct < 0.4)
        ORDER BY COALESCE(q.composite_score, 1) ASC
        LIMIT ?`).all(limit);
    } finally { db.close(); }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders });

    const client = new Anthropic({ apiKey });
    let done = 0;
    const total = rows.length;

    const processOne = async (row) => {
      try {
        const prompt = buildSummaryPrompt(row);
        if (!prompt) return;
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 120,
          messages: [{ role: 'user', content: prompt }]
        });
        const text = msg.content[0]?.text || '';
        const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const summary = lines[0] || null;
        const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
        const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
        const lang = detectLanguage([row.excerpt, row.pdf_title, row.hosted_title].filter(Boolean).join(' '));
        const db2 = safeOpenDb(domain);
        if (db2) {
          try { db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?').run(summary, author, lang, 'haiku', new Date().toISOString(), row.url); }
          finally { db2.close(); }
        }
      } catch (e) {
        console.error(`[batch-summarize] ${row.url}: ${e.message}`);
      }
      done++;
      res.write(`data:${JSON.stringify({ done, total })}\n\n`);
    };

    // Run with concurrency limit
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(rows.slice(i, i + concurrency).map(processOne));
    }
    return res.end();
  }

  // Serve pdfjs-dist files for the viewer
  if (path.startsWith('/pdfjs/')) {
    const subPath = path.slice(7); // strip '/pdfjs/'
    const filePath = join(PDFJS_DIR, 'build', subPath);
    if (!existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
    const mime = STATIC_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    return res.end(readFileSync(filePath));
  }

  // Proxy a mirrored PDF file for the viewer (serves local mirror file)
  if (path === '/api/pdf') {
    const docUrl = url.searchParams.get('url');
    if (!docUrl) return err(res, 400, 'url param required');
    const domain = sites.find(s => docUrl.startsWith(`https://${s.domain}`) || docUrl.startsWith(`http://${s.domain}`))?.domain;
    if (!domain) return err(res, 404, 'unknown domain');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try { row = db.prepare('SELECT local_path FROM pages WHERE url=?').get(docUrl); }
    finally { db.close(); }
    if (!row?.local_path || !existsSync(row.local_path)) return err(res, 404, 'pdf not found');
    const stat = (await import('fs')).statSync(row.local_path);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(readFileSync(row.local_path));
  }

  if (path === '/api/docs/summarize' && req.method === 'POST') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');

    let row, hostPage, ocrText;
    try {
      row = db.prepare(`
        SELECT q.url, q.pdf_title, q.excerpt, q.ai_summary, q.ai_author, q.ai_summarized_at,
               q.summary_tier, q.ai_language, q.pages,
               COALESCE(h.hosted_title, q.pdf_title) as title,
               h.host_url as source_url, hp.local_path as host_local_path
        FROM pdf_quality q
        LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON q.url=h.hosted_url
        LEFT JOIN pages hp ON h.host_url=hp.url
        WHERE q.url=?`).get(docUrl);

      // Get first available OCR page text
      ocrText = db.prepare(`
        SELECT text_md FROM ocr_pages WHERE doc_url=? AND page_no=1
        ORDER BY COALESCE(confidence,0) DESC LIMIT 1`).get(docUrl)?.text_md || null;
    } finally { db.close(); }

    if (!row) return err(res, 404, 'doc not found in pdf_quality');
    // Already has Haiku-tier summary — return cached
    if (row.summary_tier === 'haiku' && row.ai_summarized_at) {
      return json(res, { summary: row.ai_summary, author: row.ai_author, language: row.ai_language, tier: 'haiku' });
    }
    // Cross-site dedup: if another site already has a Haiku summary for the same content hash, reuse it
    if (row.content_hash) {
      const cfg2 = loadConfig();
      for (const site of cfg2.sites) {
        const d2 = new URL(site.url).hostname;
        if (d2 === domain) continue;
        const db2 = safeOpenDb(d2);
        if (!db2) continue;
        let hit;
        try { hit = db2.prepare("SELECT ai_summary, ai_author, ai_language FROM pdf_quality WHERE content_hash=? AND summary_tier='haiku' AND ai_summarized_at IS NOT NULL LIMIT 1").get(row.content_hash); }
        finally { db2.close(); }
        if (hit?.ai_summary) {
          const db3 = safeOpenDb(domain);
          if (db3) { try { db3.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?').run(hit.ai_summary, hit.ai_author, hit.ai_language, 'haiku', new Date().toISOString(), docUrl); } finally { db3.close(); } }
          return json(res, { summary: hit.ai_summary, author: hit.ai_author, language: hit.ai_language, tier: 'haiku' });
        }
      }
    }

    // Read host page for link context + page text
    let linkContext = null, hostPageText = null;
    if (row.host_local_path && existsSync(row.host_local_path)) {
      try {
        const html = readFileSync(row.host_local_path, { encoding: 'utf8', flag: 'r' }).slice(0, 100_000);
        linkContext = getLinkContext(html, docUrl);
        hostPageText = stripHtml(html).slice(0, 800);
      } catch {}
    }

    // Detect language from best available text
    const sampleText = [ocrText, row.excerpt, row.title].filter(Boolean).join(' ');
    const language = detectLanguage(sampleText) || 'English';

    // Build rich prompt
    const slug = docUrl.split('/').pop().replace(/\.pdf$/i,'').replace(/[_-]/g,' ').trim();
    const title = row.title || (slug.length > 3 ? slug : null);
    const parts = [];
    if (title) parts.push(`Title: ${title}`);
    parts.push(`URL: ${docUrl}`);
    if (row.source_url) parts.push(`Found on: ${row.source_url}`);
    if (linkContext) parts.push(`\nContext on host page (paragraph around the link):\n${linkContext}`);
    else if (hostPageText) parts.push(`\nHost page text excerpt:\n${hostPageText.slice(0, 400)}`);
    if (ocrText && ocrText.length > 40) parts.push(`\nDocument text (first page):\n${ocrText.slice(0, 600)}`);
    else if (row.excerpt && row.excerpt.length > 40) parts.push(`\nDocument excerpt:\n${row.excerpt.slice(0, 400)}`);
    if (!title && !linkContext && !ocrText && !row.excerpt) {
      return json(res, { summary: null, author: null, language, tier: 'free' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return err(res, 503, 'ANTHROPIC_API_KEY not set');

    try {
      const prompt = `Context clues for a PDF document (language: ${language}):\n${parts.join('\n')}\n\nRespond with exactly three plain-text lines. Do NOT echo or repeat the title, URL, or raw metadata verbatim.\nLine 1: One original sentence describing what this document is about and who would benefit from reading it.\nLine 2: Author: [full name only, or Unknown]\nLine 3: Language: [${language}]`;

      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 160,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = msg.content[0]?.text || '';
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const summary = lines[0] || null;
      const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
      const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
      const langLine = lines.find(l => l.toLowerCase().startsWith('language:'));
      const detectedLang = langLine ? langLine.replace(/^language:\s*/i, '').trim() : language;

      const db2 = safeOpenDb(domain);
      if (db2) {
        try {
          db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?')
            .run(summary, author, detectedLang, 'haiku', new Date().toISOString(), docUrl);
        } finally { db2.close(); }
      }
      return json(res, { summary, author, language: detectedLang, tier: 'haiku' });
    } catch (e) {
      console.error(`[summarize] ${docUrl}: ${e.message}`);
      return err(res, 500, e.message);
    }
  }

  return serveStatic(res, path);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[report-server] API listening on http://127.0.0.1:${PORT}`);
});
