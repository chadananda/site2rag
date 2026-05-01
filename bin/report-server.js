// site2rag API + report server. Routes: /api/sites, /api/docs, /api/thumbnail, /api/docs/skip, /api/docs/summarize; static public/.
import { createServer } from 'http';
import { existsSync, readFileSync, mkdirSync, renameSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, getMirrorRoot } from '../src/config.js';
import { openDb } from '../src/db.js';

const execFileAsync = promisify(execFile);

/** Build a Haiku summarization prompt from available doc metadata. Returns null if no context. */
const buildSummaryPrompt = (row) => {
  const title = row.hosted_title || row.pdf_title || null;
  const slug = (row.url || '').split('/').pop().replace(/\.pdf$/i,'').replace(/[_-]/g,' ').trim();
  const displayTitle = title || (slug.length > 3 ? slug : null);
  if (!displayTitle && !row.excerpt && !row.source_url) return null;
  const parts = [];
  if (displayTitle) parts.push(`Title: ${displayTitle}`);
  parts.push(`URL: ${row.url}`);
  if (row.source_url) parts.push(`Source page: ${row.source_url}`);
  if (row.excerpt) parts.push(`Excerpt: ${row.excerpt.slice(0, 500)}`);
  return `Metadata for a PDF document:\n${parts.join('\n')}\n\nRespond with exactly two plain-text lines (no markdown, no numbering):\nLine 1: one sentence describing this document.\nLine 2: Author: [full name, or Unknown]`;
};
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
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
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-cache'
};

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify(data));
};
const err = (res, status, msg) => json(res, { error: msg }, status);

const safeOpenDb = (domain) => {
  const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
  if (!existsSync(dbPath)) return null;
  try { return openDb(domain); } catch { return null; }
};

const mapDoc = (d, domain) => ({
  ...d,
  archive_url: d.status === 'done' && d.upgraded_pdf_path
    ? `https://${domain}.lnker.com/_upgraded/${d.path_slug || d.url.replace(/[^a-z0-9]/gi,'_').slice(-60)}.pdf`
    : null,
});

/** Generate a JPEG thumbnail of PDF page 1 using pdftoppm. Returns true on success. */
const generateThumb = async (pdfPath, outPath) => {
  const prefix = outPath.replace(/\.jpg$/, '');
  // 36dpi → ~300px wide for letter-size PDF: good for both card thumbnail and modal preview
  await execFileAsync('pdftoppm', ['-f', '1', '-l', '1', '-r', '36', '-jpeg', '-jpegopt', 'quality=80', pdfPath, prefix]);
  // pdftoppm writes prefix-1.jpg or prefix-01.jpg depending on page count
  for (const candidate of [`${prefix}-1.jpg`, `${prefix}-01.jpg`, `${prefix}-001.jpg`]) {
    if (existsSync(candidate)) { renameSync(candidate, outPath); return true; }
  }
  return false;
};

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
        SUM(CASE WHEN u.url IS NULL AND q.skip=0 AND q.composite_score >= 0.7 THEN 1 ELSE 0 END) as already_ok
      FROM pdf_quality q LEFT JOIN pdf_upgrade_queue u ON q.url=u.url`).get();
    const exp = db.prepare(`
      SELECT SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM exports`).get();
    const lastRun = db.prepare(`SELECT started_at, finished_at, status FROM runs ORDER BY id DESC LIMIT 1`).get();
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
      eta_seconds: (pdf.pending || 0) * avgSec,
      md_exported: exp.ok || 0, md_failed: exp.failed || 0,
      last_run: lastRun || null
    };
  } finally { db.close(); }
};

const DOC_SELECT = `
  SELECT p.url, p.path_slug, p.last_seen_at,
         q.composite_score, q.pages, q.word_quality_estimate, q.readable_pages_pct,
         q.avg_chars_per_page, q.has_text_layer, q.skip,
         COALESCE(h.hosted_title, q.pdf_title) as title,
         q.excerpt, q.ai_summary, q.ai_author, q.ai_summarized_at,
         q.thumbnail_path,
         h.host_url as source_url,
         u.status, u.before_score, u.after_score, u.score_improvement,
         u.upgraded_pdf_path, u.error
  FROM pages p
  LEFT JOIN pdf_quality q ON p.url=q.url
  LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
  LEFT JOIN hosts h ON p.url=h.hosted_url`;

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

    const wheres = ["p.gone=0", "p.mime_type='application/pdf'"];
    const vals = [];

    // Tab filtering
    if (tab === 'upgraded') {
      wheres.push("u.status='done'");
    } else {
      // Queue tab: only image PDFs (no/poor text layer) not yet done
      wheres.push("u.status IS NULL OR u.status != 'done'");
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
      : (orderMap[sort] || orderMap.score_asc);
    const where = wheres.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as n FROM pages p
      LEFT JOIN pdf_quality q ON p.url=q.url LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
      LEFT JOIN hosts h ON p.url=h.hosted_url WHERE ${where}`).get(...vals).n;

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
    const result = siteDocs(domain, url.searchParams);
    if (!result) return err(res, 404, `No data for ${domain}`);
    return json(res, result);
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

    const slug = row.path_slug || docUrl.replace(/[^a-z0-9]/gi, '_').slice(-80);
    const thumbDir = join(getMirrorRoot(), domain, '_meta', 'thumbnails');
    const thumbPath = join(thumbDir, `${slug}.jpg`);

    if (existsSync(thumbPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', ...corsHeaders });
      return res.end(readFileSync(thumbPath));
    }

    try {
      mkdirSync(thumbDir, { recursive: true });
      const ok = await generateThumb(row.local_path, thumbPath);
      if (ok && existsSync(thumbPath)) {
        // Cache path in DB so API responses include it without re-checking filesystem
        const db2 = safeOpenDb(domain);
        if (db2) { try { db2.prepare('UPDATE pdf_quality SET thumbnail_path=? WHERE url=?').run(thumbPath, docUrl); } finally { db2.close(); } }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', ...corsHeaders });
        return res.end(readFileSync(thumbPath));
      }
    } catch (e) {
      console.error(`[thumbnail] pdftoppm failed for ${docUrl}: ${e.message}`);
    }
    return err(res, 404, 'thumbnail unavailable');
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
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10));
    if (!domain) return err(res, 400, 'site param required');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return err(res, 503, 'ANTHROPIC_API_KEY not set');

    // Fetch unsummarized image PDFs sorted by worst score
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let rows;
    try {
      rows = db.prepare(`
        SELECT q.url, q.pdf_title, q.excerpt, h.hosted_title, h.host_url as source_url
        FROM pdf_quality q
        LEFT JOIN hosts h ON q.url=h.hosted_url
        WHERE q.ai_summarized_at IS NULL
          AND (q.has_text_layer=0 OR q.has_text_layer IS NULL OR q.readable_pages_pct < 0.4)
        ORDER BY COALESCE(q.composite_score, 1) ASC
        LIMIT ?`).all(limit);
    } finally { db.close(); }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders });

    const client = new Anthropic({ apiKey });
    let done = 0;
    for (const row of rows) {
      try {
        const prompt = buildSummaryPrompt(row);
        if (!prompt) { done++; res.write(`data:${JSON.stringify({ done, total: rows.length })}\n\n`); continue; }
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 120,
          messages: [{ role: 'user', content: prompt }]
        });
        const text = msg.content[0]?.text || '';
        const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const summary = lines[0] || null;
        const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
        const author = authorLine ? authorLine.replace(/^author:\s*/i,'').trim() : null;
        const db2 = safeOpenDb(domain);
        if (db2) {
          try { db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_summarized_at=? WHERE url=?').run(summary, author, new Date().toISOString(), row.url); }
          finally { db2.close(); }
        }
      } catch (e) {
        console.error(`[batch-summarize] ${row.url}: ${e.message}`);
      }
      done++;
      res.write(`data:${JSON.stringify({ done, total: rows.length })}\n\n`);
    }
    return res.end();
  }

  if (path === '/api/docs/summarize' && req.method === 'POST') {
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');
    let row;
    try {
      row = db.prepare(`SELECT q.url, q.pdf_title, q.excerpt, q.ai_summary, q.ai_author, q.ai_summarized_at,
        h.hosted_title, h.host_url as source_url FROM pdf_quality q
        LEFT JOIN hosts h ON q.url=h.hosted_url WHERE q.url=?`).get(docUrl);
    } finally { db.close(); }
    if (!row) return err(res, 404, 'doc not found in pdf_quality');
    // Return cached if present
    if (row.ai_summarized_at) return json(res, { summary: row.ai_summary, author: row.ai_author });
    const prompt = buildSummaryPrompt(row);
    if (!prompt) return json(res, { summary: null, author: null }); // no context to summarize
    // Generate via Claude Haiku
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return err(res, 503, 'ANTHROPIC_API_KEY not set');
    try {
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = msg.content[0]?.text || '';
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const summary = lines[0] || null;
      const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
      const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
      // Store in DB
      const db2 = safeOpenDb(domain);
      if (db2) {
        try { db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_summarized_at=? WHERE url=?').run(summary, author, new Date().toISOString(), docUrl); }
        finally { db2.close(); }
      }
      return json(res, { summary, author });
    } catch (e) {
      console.error(`[summarize] ${docUrl}: ${e.message}`);
      return err(res, 500, e.message);
    }
  }

  return serveStatic(res, path);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[report-server] API listening on http://127.0.0.1:${PORT}`);
});
