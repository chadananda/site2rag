// Pipeline HTTP service. Wraps runPipeline() behind a REST API for deployment isolation.
// Exports: startPipelineServer. Deps: job-store.js, index.js, context.js
//
// Routes:
//   GET  /health              → { status, version, queue_depth, deps, missing_required }
//   POST /jobs                → { jobId }        body: { pdfPath, sourceUrl, meta, config, importance }
//   GET  /jobs/:id            → { status, progress, receipt, error, ... }
//   GET  /jobs/:id/md         → text/markdown
//   GET  /jobs/:id/pdf        → application/pdf
//   DELETE /jobs/:id          → { ok: true }
//
// To move this service to another host: just point PipelineClient at the new URL.
// Remote hosts: pdfPath must be accessible from the server; for cross-machine use,
// extend with POST /jobs/upload (multipart) when needed.

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PIPELINE_VERSION } from './context.js';
import { runPipeline } from './index.js';
import { openJobStore } from './job-store.js';

const execFileAsync = promisify(execFile);
const log = (msg) => console.log(`[pipeline-server] ${new Date().toISOString().slice(0,19)} ${msg}`);

const REQUIRED_TOOLS = ['pdftoppm', 'tesseract', 'gs', 'surya_ocr', 'unpaper', 'convert'];
const OPTIONAL_TOOLS = [];

// Resolve tool name to actual command path (mirrors ToolRunner logic)
const TOOL_ENV_VARS = { surya_ocr: 'SURYA_PATH' };
function resolveToolCmd(tool, config = {}) {
  const envVar = TOOL_ENV_VARS[tool];
  return config.toolPaths?.[tool] ?? (envVar ? process.env[envVar] : null) ?? tool;
}

async function probeTool(tool, config = {}) {
  const cmd = resolveToolCmd(tool, config);
  try {
    await execFileAsync(cmd, ['--version'], { timeout: 5000 });
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: 'not found' };
    // Many tools exit non-zero for --version but still write to stdout/stderr — treat as present
    return { ok: true };
  }
}

async function checkDeps(config = {}) {
  const [required, optional] = await Promise.all([
    Promise.all(REQUIRED_TOOLS.map(async t => [t, await probeTool(t, config)])),
    Promise.all(OPTIONAL_TOOLS.map(async t => [t, await probeTool(t, config)])),
  ]);
  const deps = {};
  for (const [t, r] of required) deps[t] = { ...r, required: true };
  for (const [t, r] of optional) deps[t] = { ...r, required: false };
  const missing_required = required.filter(([, r]) => !r.ok).map(([t]) => t);
  return { deps, missing_required, healthy: missing_required.length === 0 };
}

export async function startPipelineServer({
  port        = 49900,
  dbPath      = '/tmp/pipeline-jobs.db',
  concurrency = 1,
  config: baseConfig = {},
  apiKey      = null,   // if set, require Authorization: Bearer <key> on all requests
} = {}) {
  const jobs = await openJobStore(dbPath);
  let running = 0;

  // Reset jobs stuck in 'processing' from a previous instance. Use server start time as the
  // cutoff so jobs started by THIS instance (after startup) are never reset.
  const serverStartedAt = new Date().toISOString();
  const resetStuckTimer = setTimeout(() => {
    const resetCount = jobs.resetStuck(serverStartedAt);
    if (resetCount > 0) log(`startup: reset ${resetCount} stuck processing jobs to pending`);
  }, 5000);

  // Worker: pick up next pending job and run it
  const processNext = async () => {
    if (jobs.isClosed()) return;
    if (running >= concurrency) return;
    const job = jobs.nextPending();
    if (!job) return;

    running++;
    jobs.setProcessing(job.id);
    log(`start job=${job.id}`);

    let stageStartedAt = null;
    const completedStages = [];
    try {
      const ctx = await runPipeline({
        docId:      job.id,
        sourcePath: job.pdf_path,
        sourceUrl:  job.source_url ?? null,
        importance: job.importance ?? 1,
        meta:       job.meta ?? {},
        config:     { ...baseConfig, ...job.config },
        onStageStart: (stage) => {
          stageStartedAt = Date.now();
          if (jobs.isClosed()) return;
          const prev = jobs.getProgress(job.id) || {};
          jobs.setProgress(job.id, {
            stage,
            stage_started_at: new Date().toISOString(),
            total_pages: prev.total_pages || 0,
            pages_done: 0,
            completed: completedStages,
          });
        },
        onProgress: (stage, pagesAffected, totalPages) => {
          const duration_ms = stageStartedAt ? Date.now() - stageStartedAt : 0;
          completedStages.push({ stage, pages: pagesAffected, ms: duration_ms });
          if (jobs.isClosed()) return;
          jobs.setProgress(job.id, {
            stage: null,
            stage_started_at: null,
            total_pages: totalPages,
            pages_done: pagesAffected,
            completed: completedStages,
          });
        },
      });

      if (!jobs.isClosed()) jobs.setDone(job.id, {
        mdPath:     ctx.outputs.mdPath ?? null,
        pdfOutPath: ctx.outputs.archivalPdfPath ?? null,
        receipt:    ctx.toReceipt(),
      });
      log(`done job=${job.id}`);
    } catch (err) {
      if (!jobs.isClosed()) jobs.setFailed(job.id, err.message);
      log(`failed job=${job.id}: ${err.message}`);
    } finally {
      running--;
    }
  };

  // Poll every 2 s; process multiple pending jobs per poll up to concurrency limit
  let pollTimer;
  const poll = () => {
    if (jobs.isClosed()) return;
    for (let i = 0; i < concurrency; i++) processNext().catch(() => {});
    pollTimer = setTimeout(poll, 2000);
  };
  pollTimer = setTimeout(poll, 100);

  const server = createServer(async (req, res) => {
    // Optional API key auth
    if (apiKey) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${apiKey}`) return reply(res, 401, { error: 'unauthorized' });
    }

    const url  = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    try {
      // GET /health
      if (req.method === 'GET' && path === '/health') {
        const { deps, missing_required, healthy } = await checkDeps(baseConfig);
        return reply(res, 200, {
          status: healthy ? 'ok' : 'degraded',
          version: PIPELINE_VERSION,
          queue_depth: jobs.queueDepth(),
          deps,
          missing_required,
        });
      }

      // POST /tools/run — execute a CLI tool on this host (for remote tool backend usage)
      if (req.method === 'POST' && path === '/tools/run') {
        const { tool, args, timeout = 120000 } = await readBody(req);
        if (!tool || !Array.isArray(args)) return reply(res, 400, { error: 'tool and args required' });
        try {
          const { stdout, stderr } = await execFileAsync(tool, args, { timeout, maxBuffer: 50 * 1024 * 1024 });
          return reply(res, 200, { stdout, stderr });
        } catch (e) {
          return reply(res, 500, { error: e.message, code: e.code ?? null });
        }
      }

      // POST /jobs
      if (req.method === 'POST' && path === '/jobs') {
        const body = await readBody(req);
        if (!body.pdfPath)            return reply(res, 400, { error: 'pdfPath required' });
        if (!existsSync(body.pdfPath)) return reply(res, 400, { error: `pdfPath not found: ${body.pdfPath}` });
        const id = jobs.create({
          pdfPath:    body.pdfPath,
          sourceUrl:  body.sourceUrl  ?? null,
          meta:       body.meta       ?? {},
          config:     body.config     ?? {},
          importance: body.importance ?? 1,
        });
        log(`queued job=${id} path=${body.pdfPath}`);
        return reply(res, 202, { jobId: id });
      }

      // Routes that need a job id
      const idMatch  = path.match(/^\/jobs\/([^/]+)$/);
      const mdMatch  = path.match(/^\/jobs\/([^/]+)\/md$/);
      const pdfMatch = path.match(/^\/jobs\/([^/]+)\/pdf$/);

      // GET /jobs/:id
      if (req.method === 'GET' && idMatch) {
        const job = jobs.get(idMatch[1]);
        if (!job) return reply(res, 404, { error: 'not found' });
        // Omit internal paths from public response
        const { pdf_path, md_path, pdf_out_path, meta, config, ...pub } = job;
        pub.has_markdown = !!md_path && existsSync(md_path);
        pub.has_pdf      = !!pdf_out_path && existsSync(pdf_out_path);
        return reply(res, 200, pub);
      }

      // GET /jobs/:id/md
      if (req.method === 'GET' && mdMatch) {
        const job = jobs.get(mdMatch[1]);
        if (!job) return reply(res, 404, { error: 'not found' });
        if (job.status !== 'done' || !job.md_path || !existsSync(job.md_path))
          return reply(res, 404, { error: 'markdown not available' });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(readFileSync(job.md_path, 'utf8'));
      }

      // GET /jobs/:id/pdf
      if (req.method === 'GET' && pdfMatch) {
        const job = jobs.get(pdfMatch[1]);
        if (!job) return reply(res, 404, { error: 'not found' });
        if (job.status !== 'done' || !job.pdf_out_path || !existsSync(job.pdf_out_path))
          return reply(res, 404, { error: 'upgraded pdf not available' });
        const buf = readFileSync(job.pdf_out_path);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
        return res.end(buf);
      }

      // DELETE /jobs/:id
      if (req.method === 'DELETE' && idMatch) {
        const job = jobs.get(idMatch[1]);
        if (!job) return reply(res, 404, { error: 'not found' });
        jobs.delete(idMatch[1]);
        return reply(res, 200, { ok: true });
      }

      reply(res, 404, { error: 'not found' });
    } catch (err) {
      log(`request error: ${err.message}`);
      reply(res, 500, { error: 'internal error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => { log(`listening on port ${port}`); resolve(); });
  });

  return {
    server,
    jobs,
    close: () => {
      clearTimeout(resetStuckTimer);
      clearTimeout(pollTimer);
      jobs._closed = true; // prevent background worker from writing to DB after close
      // closeIdleConnections releases keep-alive sockets without killing active requests;
      // closeAllConnections would abort in-flight responses causing 'other side closed' errors.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      return new Promise(r => server.close(() => { try { jobs.db.close(); } catch {} r(); }));
    },
  };
}

// --- helpers ---

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
