// HTTP API + static file server for the PDF report dashboard.
// Routes: /api/sites /api/docs /api/docs/upgrade /api/docs/reset /api/thumbnail /api/runs /api/pdf /api/focus /api/activity
// Serves public/ as static files. Admin auth via REPORT_ADMIN_PASSWORD env var.
// Polls SLP pipeline (PIPELINE_URL) every 3s for job progress; saves receipts to pdf_upgrade_queue.
import { createServer } from 'http';
import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';                                        // direct SQLite for admin ops (upgrade, reset)
import { loadConfig, getMirrorRoot } from '../src/config.js';                 // site list + root path
import { openDb } from '../src/db.js';                                        // per-site DB with migrations
import { detectLanguage } from '../src/language.js';                          // language detection for inline summarization
import { siteSummary, siteDocs, siteTabCounts, recentRuns } from './report-queries.js'; // SQL → API shapes
import { stripHtml, getLinkContext, buildSummaryPrompt } from './report-utils.js';      // response transforms
import { generateThumb } from './thumb-worker-pool.js';                       // PDF → JPEG thumbnail worker pool
import { runScorePdfs } from '../src/score-pdfs.js';                          // re-score PDFs on demand
import { maybeQueue } from '../src/score.js';                                 // check score → insert upgrade queue
import { PipelineClient } from '../src/slp-client.js';                       // SLP HTTP client for job submission
import { buildJobContext } from '../src/slp-context.js';                      // hosting-page → DeepSeek → SLP `context` block

// Prevent crashes from unhandled DB errors — log and keep serving
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err?.message ?? err));
process.on('uncaughtException',  (err) => console.error('[server] uncaught exception:',  err?.message ?? err));

const PORT = parseInt(process.env.REPORT_PORT || '7840', 10);
const FOCUS_FILE = join(getMirrorRoot(), '.focused_domain');

// Transient SLP/network errors that mean "retry later", not a real failure.
// Docs hitting these are dropped back to unqueued so the batch resubmits them.
const isTransientErr = (msg) =>
  /no workers available|fetch failed|socket hang up|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed out|job expired|HTTP 408|HTTP 429|HTTP 5\d\d/i.test(msg || '');

const getFocusDomain = () => {
  try { const d = readFileSync(FOCUS_FILE, 'utf8').trim(); return d || null; } catch { return null; }
};
const setFocusDomain = (domain) => {
  mkdirSync(getMirrorRoot(), { recursive: true });
  writeFileSync(FOCUS_FILE, domain, 'utf8');
};
const clearFocusDomain = () => {
  try { unlinkSync(FOCUS_FILE); } catch {}
};
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://site2rag.lnker.com';
// SLP service — public API base URL + Bearer key, both from SITE2RAG_ROOT/.env via ecosystem.
// No localhost fallback: empty SLP_API_URL disables upgrade/polling rather than hitting a local orchestrator.
const SLP_API_URL = process.env.SLP_API_URL || process.env.PIPELINE_URL || '';
const SLP_API_KEY = process.env.SLP_API_KEY || process.env.PIPELINE_API_KEY || null;

let _sitesCache = null;
let _sitesCacheAt = 0;
let _sitesRefreshing = false;
const SITES_CACHE_MS = 30_000;
const _refreshSitesCache = (sites) => {
  if (_sitesRefreshing) return;
  _sitesRefreshing = true;
  setImmediate(() => {
    try {
      _sitesCache = { sites: sites.map(s => siteSummary(s.domain, s.url, s.description)) };
      _sitesCacheAt = Date.now();
    } catch (e) { console.error('[sites-cache] refresh failed:', e.message); }
    finally { _sitesRefreshing = false; }
  });
};
const getSitesData = (sites) => {
  if (_sitesCache && Date.now() - _sitesCacheAt < SITES_CACHE_MS) return _sitesCache;
  _refreshSitesCache(sites);
  return _sitesCache || { sites: [] };
};
const invalidateSitesCache = () => { _sitesCacheAt = 0; };
const ADMIN_PASSWORD = process.env.SITE_ADMIN_PASS || process.env.REPORT_ADMIN_PASSWORD || null;
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const deepseekChat = async (prompt, maxTokens = 160) => {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content || '';
};

/** Strip "Line N:" or "1." style prefixes the model sometimes echoes back. */
const stripLinePrefix = (s) => s?.replace(/^(line\s*\d+[:.]?\s*|\d+[.:]\s*)/i, '').trim() || s;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSIONS_FILE = join(getMirrorRoot(), '.admin-sessions.json');

/** Active session tokens: token -> expiry timestamp (persisted across restarts) */
const sessions = new Map();
try {
  const raw = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw)) { if (Date.now() < v) sessions.set(k, v); }
} catch {}

const persistSessions = () => {
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch {}
};

/** Issue a new random session token (persisted to disk so restarts don't log users out). */
const issueToken = () => {
  const token = createHash('sha256')
    .update(`${Math.random()}${Date.now()}${ADMIN_PASSWORD}`)
    .digest('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  persistSessions();
  return token;
};

/** Returns true if the request carries a valid admin session token (or no password configured). */
const isAdmin = (req) => {
  if (!ADMIN_PASSWORD) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PDFJS_DIR = resolve(__dirname, '..', 'node_modules', 'pdfjs-dist');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const corsHeaders = { 'Access-Control-Allow-Origin': CORS_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const noCacheHeaders = { ...corsHeaders, 'Cache-Control': 'no-cache, no-store' };
const cacheHeaders = () => ({ ...corsHeaders, 'Cache-Control': 'no-cache, no-store' });
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', ...noCacheHeaders }); res.end(JSON.stringify(data)); };
const err = (res, status, msg) => json(res, { error: msg }, status);
// RFC 5987 encoded filename for Content-Disposition — handles non-ASCII/special chars safely
const contentDisposition = (filename, inline = false) => {
  const safe = filename.replace(/[^\w.\-]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
};

const safeOpenDb = (domain) => {
  const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
  if (!existsSync(dbPath)) return null;
  try { return openDb(domain); } catch { return null; }
};

const serveStatic = (res, reqPath) => {
  const filePath = join(PUBLIC_DIR, reqPath === '/' ? 'index.html' : reqPath);
  if (!existsSync(filePath)) {
    const index = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(index)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    return res.end(readFileSync(index));
  }
  const mime = STATIC_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const isHtml = mime.startsWith('text/html');
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': isHtml ? 'private, no-cache, no-store, must-revalidate' : 'no-cache, no-store', ...(isHtml ? { 'Pragma': 'no-cache' } : {}) });
  res.end(readFileSync(filePath));
};

process.on('uncaughtException', e => console.error('[server] uncaught:', e.message));
process.on('unhandledRejection', e => console.error('[server] unhandled rejection:', e?.message ?? e));

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  let cfg;
  try { cfg = loadConfig(); } catch (e) { return err(res, 500, `Config error: ${e.message}`); }
  const sites = cfg.sites.map(s => ({ domain: new URL(s.url).hostname, url: s.url, description: s.description || null }));

  if (path === '/api/auth' && req.method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const pw = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const valid = !ADMIN_PASSWORD || pw === ADMIN_PASSWORD;
    if (!valid) return json(res, { ok: false }, 401);
    const token = issueToken();
    return json(res, { ok: true, token });
  }

  if (path === '/api/health') {
    const checks = sites.map(s => {
      const db = safeOpenDb(s.domain);
      if (!db) return { domain: s.domain, ok: false, error: 'db unavailable' };
      try {
        const pageCount = db.prepare('SELECT COUNT(*) as n FROM pages').get().n;
        const recentErr = db.prepare("SELECT message FROM runs WHERE status='failed' ORDER BY id DESC LIMIT 1").get();
        return { domain: s.domain, ok: true, pages: pageCount, last_error: recentErr?.message || null };
      } catch (e) { return { domain: s.domain, ok: false, error: e.message }; }
      finally { db.close(); }
    });
    const serverUptime = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    return json(res, { ok: checks.every(c => c.ok), uptime_seconds: serverUptime, mem_mb: Math.round(mem.rss / 1024 / 1024), sites: checks });
  }

  if (path === '/api/sites') {
    return json(res, getSitesData(sites));
  }

  if (path === '/api/docs/tabs') {
    const domain = url.searchParams.get('site');
    if (!domain) return err(res, 400, 'site param required');
    const counts = siteTabCounts(domain);
    return json(res, counts || { original: 0, upgraded: 0 });
  }

  if (path === '/api/sites/prioritize' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    if (!domain) return err(res, 400, 'site param required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, `No DB for ${domain}`);
    try {
      // Boost all pending jobs above any other site's max priority (~5000)
      const n = db.prepare(`UPDATE pdf_upgrade_queue SET priority = 1000000 + COALESCE(priority, 0) WHERE status='pending'`).run().changes;
      invalidateSitesCache();
      return json(res, { ok: true, boosted: n, domain });
    } finally { db.close(); }
  }

  if (path === '/api/sites/activity') {
    const domain = url.searchParams.get('site');
    if (!domain) return err(res, 400, 'site param required');
    const pipelineUrl = SLP_API_URL;
    if (!pipelineUrl) return json(res, []);
    try {
      const db = safeOpenDb(domain);
      if (!db) return json(res, []);
      // Find all jobs currently submitted to SLP (have a pipeline_job_id)
      const jobs = db.prepare(
        `SELECT url, pipeline_job_id FROM pdf_upgrade_queue WHERE pipeline_job_id IS NOT NULL AND status NOT IN ('done','failed')`
      ).all();
      db.close();
      if (!jobs.length) return json(res, []);
      // Query SLP API for each active job's progress
      const pClient = new PipelineClient({ baseUrl: pipelineUrl, apiKey: SLP_API_KEY });
      const activity = (await Promise.all(jobs.map(async ({ url: docUrl, pipeline_job_id: jobId }) => {
        try {
          const job = await pClient.getJob(jobId);
          const isActive = !PipelineClient.isDone(job.status) && !PipelineClient.isFailed(job.status);
          const pagesDone = job.pages_processed ?? 0;
          const pagesTotal = job.page_count ?? 0;
          const startedAt = job.created_at ? (typeof job.created_at === 'number' ? job.created_at : new Date(job.created_at).getTime()) : null;
          const elapsedMs = startedAt ? Date.now() - startedAt : null;
          const pagesRate = (pagesDone > 0 && elapsedMs > 0) ? pagesDone / elapsedMs : null;
          const pagesRemaining = pagesTotal - pagesDone;
          const estimatedRemainingMs = (pagesRate && pagesRemaining > 0) ? Math.round(pagesRemaining / pagesRate) : null;
          return {
            url: docUrl,
            status: job.status,
            stage: isActive ? (job.current_stage || job.status || 'processing') : 'queued',
            elapsed_ms: elapsedMs,
            pages_done: pagesDone,
            total_pages: pagesTotal,
            estimated_remaining_ms: estimatedRemainingMs,
            completed: job.completed || [],
          };
        } catch { return null; }
      }))).filter(Boolean);
      return json(res, activity);
    } catch { return json(res, []); }
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
    // Resolve the site that actually holds the file: prefer the doc URL's own domain
    // (where its mirror lives), then the caller-supplied site. This is robust to the
    // dashboard sending a stale `site` during a site switch.
    const urlHost = (() => { try { return new URL(docUrl).hostname; } catch { return null; } })();
    const candidates = [...new Set([
      sites.find(s => s.domain === urlHost)?.domain,
      url.searchParams.get('site'),
    ].filter(Boolean))];
    if (!candidates.length) return err(res, 404, 'unknown domain');
    let domain = null, row = null;
    for (const c of candidates) {
      const cdb = safeOpenDb(c);
      if (!cdb) continue;
      try {
        const r = cdb.prepare('SELECT local_path, path_slug FROM pages WHERE url=?').get(docUrl);
        if (r?.local_path && existsSync(r.local_path)) { domain = c; row = r; break; }
      } finally { cdb.close(); }
    }
    if (!row) return err(res, 404, 'pdf not found');

    const w = Math.min(1200, Math.max(50, parseInt(url.searchParams.get('w') || '300', 10)));
    const h = url.searchParams.get('h') ? Math.min(2400, Math.max(50, parseInt(url.searchParams.get('h'), 10))) : null;
    const pageNo = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const hash = createHash('sha256').update(docUrl).digest('hex').slice(0, 16);
    const thumbDir = join(getMirrorRoot(), domain, '.thumbs');
    const sizeKey = h ? `${w}x${h}` : `${w}w`;
    const thumbPath = join(thumbDir, `x${hash}_p${pageNo}_${sizeKey}.jpg`);

    if (existsSync(thumbPath)) {
      const stat = statSync(thumbPath);
      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, cacheHeaders(604800)); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'ETag': etag, ...cacheHeaders(604800) });
      return res.end(readFileSync(thumbPath));
    }
    try {
      mkdirSync(thumbDir, { recursive: true });
      await generateThumb(row.local_path, thumbPath, w, pageNo, h);
      if (w === 144 && h === 192 && pageNo === 1) {
        const db2 = safeOpenDb(domain);
        if (db2) { try { db2.prepare('UPDATE pdf_quality SET thumbnail_path=? WHERE url=?').run(thumbPath, docUrl); } finally { db2.close(); } }
      }
      const stat = statSync(thumbPath);
      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'ETag': etag, ...cacheHeaders(604800) });
      return res.end(readFileSync(thumbPath));
    } catch (e) { console.error(`[thumbnail] failed for ${docUrl}: ${e.message}`); }
    return err(res, 404, 'thumbnail unavailable');
  }

  if (path === '/api/docs/receipt') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try { row = db.prepare("SELECT receipt_json, before_score, after_score FROM pdf_upgrade_queue WHERE url=?").get(docUrl); }
    finally { db.close(); }
    if (!row?.receipt_json) return err(res, 404, 'receipt not available');
    let receipt;
    try { receipt = JSON.parse(row.receipt_json); } catch { return err(res, 500, 'receipt parse error'); }
    // Inject source_url — pipeline only knows the local file path, not the original URL
    if (!receipt.source_url && !(receipt.source?.url)) receipt.source_url = docUrl;
    // Inject DB scores into old format that lacks composite_score in the document block
    if (!receipt.quality && row.before_score != null) {
      if (!receipt.document) receipt.document = {};
      receipt.document.composite_score = row.before_score;
      receipt.processing = receipt.processing ?? {};
      receipt.processing.final_score = row.after_score ?? null;
    }
    return json(res, receipt);
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
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition(filename, true), ...cacheHeaders(3600) });
    return res.end(readFileSync(row.upgraded_pdf_path));
  }

  if (path === '/api/docs/download-md') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let upgradeRow, exportRow;
    try {
      upgradeRow = db.prepare('SELECT marker_md_path FROM pdf_upgrade_queue WHERE url=?').get(docUrl);
      exportRow  = db.prepare('SELECT md_path FROM exports WHERE url=?').get(docUrl);
    } finally { db.close(); }
    // Prefer upgraded OCR markdown; fall back to pre-upgrade export
    const mdPath = (upgradeRow?.marker_md_path && existsSync(upgradeRow.marker_md_path))
      ? upgradeRow.marker_md_path
      : (exportRow?.md_path && existsSync(exportRow.md_path)) ? exportRow.md_path : null;
    if (!mdPath) return err(res, 404, 'markdown not found');
    const filename = mdPath.split('/').pop() || 'document.md';
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': contentDisposition(filename), ...cacheHeaders(3600) });
    return res.end(readFileSync(mdPath));
  }

  if (path === '/api/docs/download-md-original') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row, meta, page;
    try {
      row  = db.prepare('SELECT md_path FROM exports WHERE url=?').get(docUrl);
      meta = db.prepare(`SELECT before_score FROM pdf_upgrade_queue WHERE url=?`).get(docUrl);
      page = db.prepare('SELECT local_path FROM pages WHERE url=?').get(docUrl);
    } finally { db.close(); }

    // Load export MD; if it has no real text content, fall back to pdftotext on the PDF
    let body = (row?.md_path && existsSync(row.md_path)) ? readFileSync(row.md_path, 'utf8') : '';
    // Strip HTML tags/links/frontmatter to check for real text
    const textOnly = body.replace(/^---[\s\S]*?---\n?/, '').replace(/<[^>]+>/g, '').replace(/\[.*?\]\(.*?\)/g, '').trim();
    if (textOnly.replace(/\s/g, '').length < 100 && page?.local_path && existsSync(page.local_path)) {
      // No real text — extract raw pdftotext output to show the actual (possibly garbage) content
      body = await new Promise(resolve => {
        execFile('pdftotext', [page.local_path, '-'], { timeout: 15000 }, (err, stdout) => resolve(err ? '' : stdout));
      });
      if (!body.trim()) body = '(pdftotext extracted no content — image-only PDF with no text layer)';
    }

    const fm = ['---', `source_url: ${docUrl}`, `domain: ${domain}`,
      meta?.title ? `title: ${meta.title}` : null,
      meta?.before_score != null ? `quality_score: ${Math.round(meta.before_score * 100)}%` : null,
      `version: original`, '---', ''].filter(x => x !== null).join('\n');
    const content = body.startsWith('---') ? body : fm + body;
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(content);
  }

  if (path === '/api/docs/download-md-upgraded') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try {
      row = db.prepare(`SELECT marker_md_path, after_score, before_score, finished_at, method FROM pdf_upgrade_queue WHERE url=?`).get(docUrl);
    } finally { db.close(); }
    if (!row?.marker_md_path || !existsSync(row.marker_md_path)) return err(res, 404, 'no upgraded markdown');
    let content = readFileSync(row.marker_md_path, 'utf8');
    if (!content.startsWith('---')) {
      const gain = (row.after_score != null && row.before_score != null)
        ? `+${Math.round((row.after_score - row.before_score) * 100)}%` : null;
      const fm = ['---', `source_url: ${docUrl}`, `domain: ${domain}`,
        row.after_score != null ? `quality_score: ${Math.round(row.after_score * 100)}%` : null,
        gain ? `quality_gain: ${gain}` : null,
        row.finished_at ? `upgraded_at: ${row.finished_at}` : null,
        row.method ? `method: ${row.method}` : null,
        `version: upgraded`, '---', ''].filter(x => x !== null).join('\n');
      content = fm + content;
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', ...cacheHeaders(3600) });
    return res.end(content);
  }

  if (path === '/api/docs/download-pdf-upgraded') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try { row = db.prepare('SELECT upgraded_pdf_path FROM pdf_upgrade_queue WHERE url=?').get(docUrl); }
    finally { db.close(); }
    if (!row?.upgraded_pdf_path || !existsSync(row.upgraded_pdf_path)) return err(res, 404, 'no upgraded PDF');
    const filename = row.upgraded_pdf_path.split('/').pop() || 'upgraded.pdf';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition(filename) });
    return res.end(readFileSync(row.upgraded_pdf_path));
  }

  if (path === '/api/docs/upgrade' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    try {
      const quality = db.prepare('SELECT composite_score, content_hash FROM pdf_quality WHERE url=?').get(docUrl);
      // Allow upgrade even if unscored — quality may be null for extension-less PDFs
      const page = db.prepare('SELECT local_path FROM pages WHERE url=?').get(docUrl);
      if (!page) return err(res, 404, 'doc not found in mirror');
      if (!page.local_path || !existsSync(page.local_path)) return err(res, 400, `PDF file not on disk: ${page.local_path || '(no path)'}`);
      try {
        const pdfHeader = readFileSync(page.local_path).slice(0, 5).toString('ascii');
        if (pdfHeader !== '%PDF-') return err(res, 400, `Not a valid PDF: ${page.local_path.split('/').pop()}`);
      } catch (e) { return err(res, 400, `Cannot read PDF: ${e.message}`); }

      const upgradeMethod = url.searchParams.get('method') || 'ocr'; // 'spell-fix' | 'ocr'
      const existing = db.prepare('SELECT status, before_score FROM pdf_upgrade_queue WHERE url=?').get(docUrl);
      const now = new Date().toISOString();
      const imp = 999; // user-triggered reprocess always jumps the queue

      if (existing) {
        // Keep upgraded_pdf_path/after_score/receipt so the card stays visible in the upgraded tab while reprocessing.
        db.prepare(`UPDATE pdf_upgrade_queue SET status='pending', priority=999, pass=1,
          started_at=NULL, finished_at=NULL, error=NULL, requested_method=?, importance=?, queued_at=?, pipeline_job_id=NULL
          WHERE url=?`).run(upgradeMethod, imp, now, docUrl);
      } else {
        db.prepare(`INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, requested_method, importance, queued_at) VALUES (?,?,999,'pending',?,?,?)`)
          .run(docUrl, quality?.content_hash || null, upgradeMethod, imp, now);
      }

      // Immediately submit to pipeline
      const pipelineUrl = SLP_API_URL;
      if (pipelineUrl) {
        const pClient = new PipelineClient({ baseUrl: pipelineUrl, apiKey: SLP_API_KEY });
        const firstSubmitScore = quality?.composite_score ?? null;
        const localPath = page.local_path;
        (async () => {
          // Build the SLP context block from the hosting page(s) so OCR + metadata extraction get provenance.
          let context = null;
          try {
            const dbc = safeOpenDb(domain);
            if (dbc) { try { context = (await buildJobContext({ db: dbc, url: docUrl, apiKey: process.env.DEEPSEEK_API_KEY }))?.context || null; } finally { dbc.close(); } }
          } catch (e) { console.warn(`[upgrade] context build failed for ${docUrl.split('/').pop()}: ${e.message}`); }
          try {
            const jobId = await pClient.submitJob({ pdfPath: localPath, filename: docUrl.split('/').pop(), context, meta: { source_url: docUrl } });
            const db3 = safeOpenDb(domain);
            if (db3) { try { db3.prepare("UPDATE pdf_upgrade_queue SET status='submitted', started_at=?, pipeline_job_id=?, before_score=COALESCE(before_score,?) WHERE url=?").run(new Date().toISOString(), jobId, firstSubmitScore, docUrl); } finally { db3.close(); } }
            console.log(`[upgrade] submitted ${docUrl.split('/').pop()} → ${jobId} (ctx ${context ? context.length + 'c' : 'none'})`);
          } catch (e) {
            const msg = e.message || 'submit failed';
            console.error(`[upgrade] pipeline submit failed for ${docUrl.split('/').pop()}: ${msg}`);
            // Transient SLP/network errors aren't real failures — drop the queue row so the
            // doc returns to unqueued and the batch retries it, instead of marking it failed.
            const db4 = safeOpenDb(domain);
            if (db4) {
              try {
                if (isTransientErr(msg)) db4.prepare("DELETE FROM pdf_upgrade_queue WHERE url=? AND status NOT IN ('done','submitted')").run(docUrl);
                else db4.prepare("UPDATE pdf_upgrade_queue SET status='failed', error=? WHERE url=?").run(msg.slice(0, 300), docUrl);
              } finally { db4.close(); }
            }
          }
        })();
      }

      return json(res, { ok: true, status: 'pending', queued: !existing, method: upgradeMethod, importance: imp, message: existing ? 'Restarted from scratch' : 'Added to front of queue' });
    } catch (e) {
      console.error('[server] /api/docs/upgrade error:', e?.message);
      return err(res, 500, e?.message ?? 'internal error');
    } finally { db.close(); }
  }

  // Reset a doc to original state — clears all upgrade queue data for testing
  if (path === '/api/docs/reset' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    try {
      db.prepare('DELETE FROM pdf_upgrade_queue WHERE url=?').run(docUrl);
      return json(res, { ok: true });
    } catch (e) { return err(res, 500, e?.message); } finally { db.close(); }
  }

  // Focus mode — tells the upgrade daemon to concentrate on one site until done
  if (path === '/api/focus') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    if (req.method === 'GET') {
      return json(res, { domain: getFocusDomain() });
    }
    if (req.method === 'POST') {
      const domain = url.searchParams.get('site');
      if (!domain) return err(res, 400, 'site param required');
      setFocusDomain(domain);
      return json(res, { ok: true, domain });
    }
    if (req.method === 'DELETE') {
      clearFocusDomain();
      return json(res, { ok: true, domain: null });
    }
  }

  // Wipe and re-score all PDFs for a site, then requeue ALL of them (threshold=1.0 so easy text-layer PDFs are included)
  if (path === '/api/docs/requeue-all' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    if (!domain) return err(res, 400, 'site param required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    try {
      // Clear queue and quality scores so everything gets fresh-scored
      db.prepare("DELETE FROM pdf_upgrade_queue").run();
      db.prepare("DELETE FROM pdf_quality").run();
    } finally { db.close(); }

    // Re-score and requeue in background — threshold=1.0 so ALL PDFs are queued,
    // including easy text-layer PDFs (they process in seconds via pipeline, skipping OCR)
    const baseSiteConfig = sites.find(s => {
      try { return new URL(s.url).hostname === domain; } catch { return false; }
    }) ?? {};
    const siteConfig = { ...baseSiteConfig, pdf_upgrade: { ...(baseSiteConfig.pdf_upgrade ?? {}), score_threshold: 1.0 } };
    const db2 = safeOpenDb(domain);
    if (db2) {
      runScorePdfs(db2, siteConfig).then(stats => {
        console.log(`[requeue-all] ${domain}: scored=${stats.scored} queued=${stats.queued} skipped=${stats.skipped}`);
        db2.close();
      }).catch(e => {
        console.error(`[requeue-all] ${domain}: ${e.message}`);
        try { db2.close(); } catch {}
      });
    }
    return json(res, { ok: true, message: 'Queue cleared — rescoring in background. Processing will start when scores are ready.' });
  }

  if (path === '/api/docs/skip' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    const skip = url.searchParams.get('skip') !== '0';
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    try { db.prepare('UPDATE pdf_quality SET skip=? WHERE url=?').run(skip ? 1 : 0, docUrl); return json(res, { ok: true, skip }); }
    finally { db.close(); }
  }

  if (path === '/api/runs') {
    return json(res, recentRuns(sites));
  }

  if (path === '/api/docs/summarize-batch' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10));
    const concurrency = Math.min(40, parseInt(url.searchParams.get('concurrency') || '20', 10));
    if (!domain) return err(res, 400, 'site param required');
    if (!process.env.DEEPSEEK_API_KEY) return err(res, 503, 'DEEPSEEK_API_KEY not set');
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
    } catch (e) { db.close(); return err(res, 500, e.message); } finally { db.close(); }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders });
    let done = 0;
    const total = rows.length;

    const processRow = async (row) => {
      try {
        const prompt = buildSummaryPrompt(row);
        if (!prompt) return;
        const text = await deepseekChat(prompt, 120);
        const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const summary = stripLinePrefix(lines[0]) || null;
        const authorLine = lines.find(l => /^(line\s*2[:.]?\s*)?author:/i.test(l));
        const author = authorLine ? authorLine.replace(/^(line\s*2[:.]?\s*)?author:\s*/i, '').trim() : null;
        const lang = detectLanguage([row.excerpt, row.pdf_title, row.hosted_title].filter(Boolean).join(' '));
        const db2 = safeOpenDb(domain);
        if (db2) {
          try {
            db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?').run(summary, author, lang, 'deepseek', new Date().toISOString(), row.url);
          } finally { db2.close(); }
        }
      } catch (e) { console.error(`[batch-summarize] ${row.url}: ${e.message}`); }
      done++;
      res.write(`data:${JSON.stringify({ done, total })}\n\n`);
    };
    for (let i = 0; i < rows.length; i += concurrency) await Promise.all(rows.slice(i, i + concurrency).map(processRow));
    return res.end();
  }

  if (path.startsWith('/pdfjs/')) {
    const filePath = join(PDFJS_DIR, 'build', path.slice(7));
    if (!existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
    const mime = STATIC_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    return res.end(readFileSync(filePath));
  }

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
    const stat = statSync(row.local_path);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    return res.end(readFileSync(row.local_path));
  }

  if (path === '/api/docs/summarize' && req.method === 'POST') {
    if (!isAdmin(req)) return err(res, 401, 'Admin password required');
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');

    let row;
    try {
      row = db.prepare(`
        SELECT q.url, q.pdf_title, q.excerpt, q.ai_summary, q.ai_author, q.ai_summarized_at,
               q.summary_tier, q.ai_language, q.pages, q.content_hash,
               COALESCE(h.hosted_title, q.pdf_title) as title,
               h.host_url as source_url, hp.local_path as host_local_path
        FROM pdf_quality q
        LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON q.url=h.hosted_url
        LEFT JOIN pages hp ON h.host_url=hp.url
        WHERE q.url=?`).get(docUrl);
    } catch (e) { db.close(); return err(res, 500, e.message); } finally { db.close(); }

    if (!row) return err(res, 404, 'doc not found in pdf_quality');
    if (row.ai_summarized_at) {
      return json(res, { summary: row.ai_summary, author: row.ai_author, language: row.ai_language, tier: 'haiku' });
    }

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

    let linkContext = null, hostPageText = null;
    if (row.host_local_path && existsSync(row.host_local_path)) {
      try {
        const html = readFileSync(row.host_local_path, 'utf8').slice(0, 100_000);
        linkContext = getLinkContext(html, docUrl);
        hostPageText = stripHtml(html).slice(0, 800);
      } catch {}
    }

    const sampleText = [row.excerpt, row.title].filter(Boolean).join(' ');
    const language = detectLanguage(sampleText) || 'English';
    const slug = docUrl.split('/').pop().replace(/\.pdf$/i,'').replace(/[_-]/g,' ').trim();
    const title = row.title || (slug.length > 3 ? slug : null);
    const parts = [];
    if (title) parts.push(`Title: ${title}`);
    parts.push(`URL: ${docUrl}`);
    if (row.source_url) parts.push(`Found on: ${row.source_url}`);
    if (linkContext) parts.push(`\nContext on host page:\n${linkContext}`);
    else if (hostPageText) parts.push(`\nHost page text:\n${hostPageText.slice(0, 400)}`);
    if (row.excerpt && row.excerpt.length > 40) parts.push(`\nDocument excerpt:\n${row.excerpt.slice(0, 400)}`);
    if (!title && !linkContext && !row.excerpt) {
      return json(res, { summary: null, author: null, language, tier: 'free' });
    }

    if (!process.env.DEEPSEEK_API_KEY) return err(res, 503, 'DEEPSEEK_API_KEY not set');

    try {
      const prompt = `Context clues for a PDF document (language: ${language}):\n${parts.join('\n')}\n\nRespond with exactly three plain-text lines. Do NOT echo or repeat the title, URL, or raw metadata verbatim.\nLine 1: One original sentence describing what this document is about and who would benefit from reading it.\nLine 2: Author: [full name only, or Unknown]\nLine 3: Language: [${language}]`;
      const text = await deepseekChat(prompt, 160);
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const summary = stripLinePrefix(lines[0]) || null;
      const authorLine = lines.find(l => /^(line\s*2[:.]?\s*)?author:/i.test(l));
      const author = authorLine ? authorLine.replace(/^(line\s*2[:.]?\s*)?author:\s*/i, '').trim() : null;
      const langLine = lines.find(l => /^(line\s*3[:.]?\s*)?language:/i.test(l));
      const detectedLang = langLine ? langLine.replace(/^(line\s*3[:.]?\s*)?language:\s*/i, '').trim() : language;
      const db2 = safeOpenDb(domain);
      if (db2) {
        try {
          db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?').run(summary, author, detectedLang, 'deepseek', new Date().toISOString(), docUrl);
        } finally { db2.close(); }
      }
      return json(res, { summary, author, language: detectedLang, tier: 'deepseek' });
    } catch (e) {
      console.error(`[summarize] ${docUrl}: ${e.message}`);
      return err(res, 500, e.message);
    }
  }

  return serveStatic(res, path);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[report-server] API listening on http://127.0.0.1:${PORT}`);
});

// Poll pipeline jobs submitted via the reprocess button (upgrade worker is stopped)
if (SLP_API_URL) {
  const pipelinePoller = new PipelineClient({ baseUrl: SLP_API_URL, apiKey: SLP_API_KEY });
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  // SLP page anchors: <!-- pdf:N -->, <!-- pdf:N, pg:LABEL -->, or legacy <!-- page:N -->. Strip for body/title/length checks (kept intact in the saved file).
  const stripAnchors = (s) => (s || '').replace(/<!--\s*(?:pdf|page):[^>]*-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  // SLP frontmatter reports language as an ISO code; normalize to the word form used by detectLanguage + existing data.
  const ISO2LANG = { en:'english', fr:'french', fa:'persian', ar:'arabic', he:'hebrew', es:'spanish', de:'german', it:'italian', pt:'portuguese', nl:'dutch', ru:'russian', tr:'turkish', ja:'japanese', zh:'chinese', ko:'korean' };
  const normLang = (l) => l ? (ISO2LANG[String(l).toLowerCase()] || l) : l;
  const pollPipelineJobs = async () => {
    let sites;
    try { ({ sites } = loadConfig()); } catch { return; }
    for (const site of sites) {
      let domain;
      try { domain = new URL(site.url).hostname; } catch { continue; }
      const db = safeOpenDb(domain);
      if (!db) continue;
      try {
        const jobs = db.prepare("SELECT url, pipeline_job_id, before_score, status FROM pdf_upgrade_queue WHERE pipeline_job_id IS NOT NULL AND status != 'done'").all();
        for (const { url, pipeline_job_id: jobId, before_score } of jobs) {
          try {
            const job = await pipelinePoller.getJob(jobId);
            if (PipelineClient.isDone(job.status)) {
              // Public SLP contract: GET /result returns the upgraded PDF (Accept: application/pdf) or the
              // structured RAG markdown (Accept: text/markdown). No inline metadata — title/author/lang are
              // derived from the markdown body here. Scores are null at the economy tier (not a failure).
              let mdText = null, pdfBuf = null;
              try { mdText = await pipelinePoller.getMarkdown(jobId); } catch (e) { console.warn(`[poll] markdown fetch failed ${jobId}: ${e.message}`); }
              try { pdfBuf = await pipelinePoller.getPdf(jobId); }      catch (e) { console.warn(`[poll] pdf fetch failed ${jobId}: ${e.message}`); }
              const mdBody = stripAnchors(mdText);
              // Completeness: markdown is the deliverable. Require real body text.
              if (!mdText || mdBody.length < 50) {
                const errMsg = `incomplete: ${mdText ? 'empty_markdown' : 'no_markdown'}`;
                console.warn(`[poll] ${errMsg}: ${url.split('/').pop()}`);
                db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=?, pipeline_job_id=NULL WHERE url=?")
                  .run(new Date().toISOString(), errMsg, url);
                continue;
              }
              const beforeScore = job.score_before ?? before_score ?? null;
              const afterScore  = job.score_after ?? null;
              const gain        = (afterScore != null && beforeScore != null) ? afterScore - beforeScore : null;
              const upgradedDir = join(getMirrorRoot(), '..', 'websites_mirror', domain, '.upgraded');
              mkdirSync(upgradedDir, { recursive: true });
              const hash = sha256(url).slice(0, 16);
              // Save markdown (anchors kept intact for RAG citation) + the upgraded PDF.
              const mdPath = join(upgradedDir, `x${hash}.md`);
              writeFileSync(mdPath, mdText);
              let savedPdf = null;
              if (pdfBuf && pdfBuf.length) { const p = join(upgradedDir, `x${hash}.pdf`); writeFileSync(p, pdfBuf); savedPdf = p; }
              // Metadata: SLP may emit YAML frontmatter (---). Parse it and use those fields when present.
              // Do NOT guess title/author from the OCR body — the first line is usually a running header —
              // and never clobber existing metadata. Language detection is reliable, so always refresh it.
              const fm = {};
              const fmMatch = mdText.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
              if (fmMatch) for (const ln of fmMatch[1].split(/\r?\n/)) { const mm = ln.match(/^([A-Za-z_]+):\s*(.+?)\s*$/); if (mm) fm[mm[1].toLowerCase()] = mm[2].replace(/^["']|["']$/g, ''); }
              const aiLang = normLang(fm.language || fm.lang || (detectLanguage(mdBody.slice(0, 4000)) || null));
              const receiptJson = JSON.stringify({ job, mdBytes: mdText.length, pdfBytes: pdfBuf?.length ?? 0, frontmatter: Object.keys(fm) });
              db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, upgraded_pdf_path=COALESCE(?,upgraded_pdf_path), marker_md_path=?, before_score=COALESCE(before_score,?), after_score=?, score_improvement=?, pages_processed=?, method=?, receipt_json=?, pipeline_job_id=NULL WHERE url=?`)
                .run(new Date().toISOString(), savedPdf, mdPath, beforeScore, afterScore, gain, job.pages_processed ?? null, 'slp-v1', receiptJson, url);
              // Never overwrite pdf_quality.composite_score (original pre-upgrade score).
              const cols = [], vals = [];
              if (fm.title)     { cols.push('ai_title=?');  vals.push(String(fm.title).slice(0, 500)); }
              if (fm.title_en)  { cols.push('title_en=?');  vals.push(String(fm.title_en).slice(0, 500)); }
              if (fm.author)    { cols.push('ai_author=?'); vals.push(String(fm.author).slice(0, 300)); }
              const fmDesc = fm.description || fm.summary || fm.subject;
              if (fmDesc)       { cols.push('ai_summary=?'); vals.push(String(fmDesc).slice(0, 2000)); cols.push('desc_en=?'); vals.push(String(fmDesc).slice(0, 2000)); }
              if (aiLang && aiLang !== 'unknown') { cols.push('ai_language=?'); vals.push(aiLang); }
              if (cols.length){ vals.push(url); db.prepare(`UPDATE pdf_quality SET ${cols.join(', ')} WHERE url=?`).run(...vals); }
              console.log(`[poll] done: ${url.split('/').pop()} pages=${job.pages_processed} mdKB=${(mdText.length/1024).toFixed(1)} lang=${aiLang} fm=[${Object.keys(fm).join(',') || 'none'}]`);
            } else if (PipelineClient.isFailed(job.status)) {
              const errCode = job.failure_code || job.status;
              if (isTransientErr(errCode)) db.prepare("DELETE FROM pdf_upgrade_queue WHERE url=? AND status NOT IN ('done','submitted')").run(url);
              else db.prepare("UPDATE pdf_upgrade_queue SET status='failed', finished_at=?, error=?, pipeline_job_id=NULL WHERE url=?").run(new Date().toISOString(), String(errCode).slice(0, 300), url);
            }
            // else: awaiting_upload / processing / queued — still in flight, leave as-is.
          } catch (e) {
            if (e.message?.includes('404')) db.prepare("UPDATE pdf_upgrade_queue SET status='failed', error='job expired', pipeline_job_id=NULL WHERE url=?").run(url);
          }
        }
      } finally { db.close(); }
    }
  };
  const runPoller = () => pollPipelineJobs().catch(e => console.error('[poll] error:', e.message)).finally(() => setTimeout(runPoller, 3000));
  setTimeout(runPoller, 5000);
}
