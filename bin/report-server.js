// HTTP API + static file server. Routes: /api/sites, /api/docs, /api/thumbnail, /api/runs, /api/docs/*, /api/pdf; static public/. Deps: report-queries, report-utils, thumb-worker-pool, db, config, Anthropic
import { createServer } from 'http';
import { existsSync, readFileSync, mkdirSync, statSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, getMirrorRoot } from '../src/config.js';
import { openDb, logLlmCall, llmCost } from '../src/db.js';
import { detectLanguage } from '../src/language.js';
import { siteSummary, siteDocs, recentRuns } from './report-queries.js';
import { stripHtml, getLinkContext, buildSummaryPrompt } from './report-utils.js';
import { generateThumb } from './thumb-worker-pool.js';

const PORT = parseInt(process.env.REPORT_PORT || '7840', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://site2rag.lnker.com';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PDFJS_DIR = resolve(__dirname, '..', 'node_modules', 'pdfjs-dist');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const corsHeaders = { 'Access-Control-Allow-Origin': CORS_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const noCacheHeaders = { ...corsHeaders, 'Cache-Control': 'no-cache, no-store' };
const cacheHeaders = (maxAge = 86400) => ({ ...corsHeaders, 'Cache-Control': `public, max-age=${maxAge}` });
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', ...noCacheHeaders }); res.end(JSON.stringify(data)); };
const err = (res, status, msg) => json(res, { error: msg }, status);

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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(readFileSync(index));
  }
  const mime = STATIC_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const noCache = filePath.endsWith('sw.js') || filePath.endsWith('version.json');
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': noCache ? 'no-cache, no-store' : 'public, max-age=3600' });
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
  const sites = cfg.sites.map(s => ({ domain: new URL(s.url).hostname, url: s.url }));

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
    try { db.prepare('UPDATE pdf_quality SET skip=? WHERE url=?').run(skip ? 1 : 0, docUrl); return json(res, { ok: true, skip }); }
    finally { db.close(); }
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
    } catch (e) { db.close(); return err(res, 500, e.message); } finally { db.close(); }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders });
    const client = new Anthropic({ apiKey });
    let done = 0;
    const total = rows.length;

    const processRow = async (row) => {
      try {
        const prompt = buildSummaryPrompt(row);
        if (!prompt) return;
        const msg = await client.messages.create({ model: HAIKU_MODEL, max_tokens: 120, messages: [{ role: 'user', content: prompt }] });
        const text = msg.content[0]?.text || '';
        const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const summary = lines[0] || null;
        const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
        const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
        const lang = detectLanguage([row.excerpt, row.pdf_title, row.hosted_title].filter(Boolean).join(' '));
        const db2 = safeOpenDb(domain);
        if (db2) {
          try {
            db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?').run(summary, author, lang, 'haiku', new Date().toISOString(), row.url);
            logLlmCall(db2, { stage: 'summarize', url: row.url, page_no: null, provider: 'claude', model: HAIKU_MODEL, tokens_in: msg.usage?.input_tokens || 0, tokens_out: msg.usage?.output_tokens || 0, cost_usd: llmCost(HAIKU_MODEL, msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0), ok: 1 });
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
    const domain = url.searchParams.get('site');
    const docUrl = url.searchParams.get('url');
    if (!domain || !docUrl) return err(res, 400, 'site and url params required');
    const db = safeOpenDb(domain);
    if (!db) return err(res, 404, 'db unavailable');

    let row, ocrText;
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
      ocrText = db.prepare(`SELECT text_md FROM ocr_pages WHERE doc_url=? AND page_no=1 ORDER BY COALESCE(confidence,0) DESC LIMIT 1`).get(docUrl)?.text_md || null;
    } catch (e) { db.close(); return err(res, 500, e.message); } finally { db.close(); }

    if (!row) return err(res, 404, 'doc not found in pdf_quality');
    if (row.summary_tier === 'haiku' && row.ai_summarized_at) {
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

    const sampleText = [ocrText, row.excerpt, row.title].filter(Boolean).join(' ');
    const language = detectLanguage(sampleText) || 'English';
    const slug = docUrl.split('/').pop().replace(/\.pdf$/i,'').replace(/[_-]/g,' ').trim();
    const title = row.title || (slug.length > 3 ? slug : null);
    const parts = [];
    if (title) parts.push(`Title: ${title}`);
    parts.push(`URL: ${docUrl}`);
    if (row.source_url) parts.push(`Found on: ${row.source_url}`);
    if (linkContext) parts.push(`\nContext on host page:\n${linkContext}`);
    else if (hostPageText) parts.push(`\nHost page text:\n${hostPageText.slice(0, 400)}`);
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
      const msg = await client.messages.create({ model: HAIKU_MODEL, max_tokens: 160, messages: [{ role: 'user', content: prompt }] });
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
          db2.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?').run(summary, author, detectedLang, 'haiku', new Date().toISOString(), docUrl);
          logLlmCall(db2, { stage: 'summarize', url: docUrl, page_no: null, provider: 'claude', model: HAIKU_MODEL, tokens_in: msg.usage?.input_tokens || 0, tokens_out: msg.usage?.output_tokens || 0, cost_usd: llmCost(HAIKU_MODEL, msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0), ok: 1 });
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
