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
//   GET  /workers             → list of registered worker agents with health snapshots
//   POST /workers/register    → register a worker agent { url, hostname, platform }
//
// To move this service to another host: just point PipelineClient at the new URL.
// Remote hosts: pdfPath must be accessible from the server; for cross-machine use,
// extend with POST /jobs/upload (multipart) when needed.

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PIPELINE_VERSION } from './context.js';
import { runPipeline } from './index.js';
import { openJobStore } from './job-store.js';
import { getTmpDir } from '../config.js';

const __pyDir = join(dirname(fileURLToPath(import.meta.url)), '.');

const execFileAsync = promisify(execFile);
const log = (msg) => console.log(`[pipeline-server] ${new Date().toISOString().slice(0,19)} ${msg}`);

// ── Worker registry ─────────────────────────────────────────────────────────
// In-memory registry of worker agents on the network.
// Workers self-register via POST /workers/register on startup.
// Health snapshots are refreshed on GET /workers.
const workerRegistry = new Map(); // url → { url, hostname, platform, lastSeen, health }
const WORKER_HEALTH_TTL_MS = 30_000; // re-poll health every 30s

async function fetchWorkerHealth(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) }); // 8s: enough for Tailscale
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function refreshWorkerHealth(entry) {
  if (Date.now() - (entry.healthAt ?? 0) < WORKER_HEALTH_TTL_MS) return;
  const fresh = await fetchWorkerHealth(entry.url);
  if (fresh !== null) { entry.health = fresh; entry.healthOk = true; }
  else entry.healthOk = false; // keep last-known health for routing, but flag as unreachable
  entry.healthAt = Date.now();
}

// Seed from WORKER_URLS env var: comma-separated list of http://host:port URLs
const SEED_WORKERS = (process.env.WORKER_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
for (const url of SEED_WORKERS) {
  workerRegistry.set(url, { url, hostname: new URL(url).hostname, platform: 'unknown', lastSeen: Date.now() });
}

const REQUIRED_TOOLS = ['pdftoppm', 'tesseract', 'gs', 'surya_ocr', 'unpaper', 'convert'];
// Python OCR engines — required for cost-effective image PDF processing.
// Missing engines force expensive cloud vision fallback ($0.10-$0.20/page vs $0.01/page with local engines).
const PYTHON_OCR_SCRIPTS = [
  { name: 'easyocr', script: join(__pyDir, 'easyocr_ocr.py'), required: true  },
  { name: 'paddle',  script: join(__pyDir, 'paddle_ocr.py'),  required: true  },
  { name: 'doctr',   script: join(__pyDir, 'doctr_ocr.py'),   required: true  },
  { name: 'kraken',  script: join(__pyDir, 'kraken_ocr.py'),  required: false },
];
const OPTIONAL_TOOLS = [];

// Resolve tool name to actual command path (mirrors ToolRunner logic)
const TOOL_ENV_VARS = { surya_ocr: 'SURYA_PATH' };
function resolveToolCmd(tool, config = {}) {
  const envVar = TOOL_ENV_VARS[tool];
  return config.toolPaths?.[tool] ?? (envVar ? process.env[envVar] : null) ?? tool;
}

// FUNCTIONAL_TESTS: run a real operation instead of --version where feasible.
// surya_ocr imports torch at startup — a Python tempfile failure will show as import error.
const FUNCTIONAL_TESTS = {
  surya_ocr: async (cmd) => {
    // Run with --help; a torch import failure produces exit 1 + traceback, which is a real error
    const { stdout, stderr } = await execFileAsync(cmd, ['--help'], { timeout: 15000 })
      .catch(e => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', _err: e }));
    if ((stderr + stdout).includes('Traceback') || (stderr + stdout).includes('Error')) {
      const firstLine = (stderr || stdout).split('\n').find(l => l.includes('Error') || l.includes('error')) ?? 'import failed';
      throw new Error(firstLine.trim().slice(0, 120));
    }
  },
};

async function probeTool(tool, config = {}) {
  const cmd = resolveToolCmd(tool, config);
  try {
    const fn = FUNCTIONAL_TESTS[tool];
    if (fn) {
      await fn(cmd);
    } else {
      await execFileAsync(cmd, ['--version'], { timeout: 5000 });
    }
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: `not found: ${cmd}` };
    // For tools without a functional test, non-zero exit on --version = tool exists, just doesn't support the flag
    if (!FUNCTIONAL_TESTS[tool]) return { ok: true };
    return { ok: false, error: e.message.slice(0, 120) };
  }
}

async function checkDiskSpace() {
  try {
    const tmpDir = getTmpDir();
    const { stdout } = await execFileAsync('df', ['-BG', tmpDir], { timeout: 5000 });
    const line = stdout.split('\n')[1] ?? '';
    const parts = line.trim().split(/\s+/);
    const availGB = parseInt(parts[3]) || 0;
    const usePercent = parseInt((parts[4] ?? '0%').replace('%', '')) || 0;
    return { path: tmpDir, avail_gb: availGB, use_percent: usePercent,
      ok: availGB >= 5, error: availGB < 5 ? `only ${availGB}GB free in ${tmpDir}` : undefined };
  } catch {
    return { ok: true }; // df failure is non-fatal
  }
}

// Check Python OCR engine: script must exist AND library must be importable.
// Missing scripts or libraries cause silent cloud escalation — both are required.
async function checkPythonOcrEngine({ name, script }) {
  if (!existsSync(script)) return { ok: false, error: `script not found: ${script}` };
  try {
    const { stdout } = await execFileAsync('python3', [script, '--check'], { timeout: 15000 });
    const ok = stdout.trim() === 'ok';
    return ok ? { ok: true } : { ok: false, error: `library not importable (python3 ${script} --check returned: ${stdout.trim().slice(0, 60)})` };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 120) };
  }
}

async function checkDeps(config = {}) {
  const [required, optional, pythonEngines, disk] = await Promise.all([
    Promise.all(REQUIRED_TOOLS.map(async t => [t, await probeTool(t, config)])),
    Promise.all(OPTIONAL_TOOLS.map(async t => [t, await probeTool(t, config)])),
    Promise.all(PYTHON_OCR_SCRIPTS.map(async e => [e.name, await checkPythonOcrEngine(e), e.required !== false])),
    checkDiskSpace(),
  ]);
  const deps = {};
  for (const [t, r] of required) deps[t] = { ...r, required: true };
  for (const [t, r] of optional) deps[t] = { ...r, required: false };
  for (const [t, r, isRequired] of pythonEngines) {
    deps[`python_ocr_${t}`] = { ...r, required: isRequired };
    if (!r.ok) log(`WARN: python OCR engine '${t}' unavailable — image PDFs will use expensive cloud fallback: ${r.error}`);
  }
  const missing_required = [
    ...required.filter(([, r]) => !r.ok).map(([t]) => t),
    ...pythonEngines.filter(([, r, isRequired]) => isRequired && !r.ok).map(([t]) => `python_ocr_${t}`),
    ...(!disk.ok ? [`disk: ${disk.error}`] : []),
  ];
  return { deps, missing_required, disk, healthy: missing_required.length === 0 };
}

export async function startPipelineServer({
  port        = 49900,
  dbPath      = null,
  concurrency = 2,    // process 2 PDFs in parallel; tool calls distribute across worker pool
  config: baseConfig = {},
  apiKey      = null,   // if set, require Authorization: Bearer <key> on all requests
} = {}) {
  const resolvedDbPath = dbPath ?? `${getTmpDir()}/pipeline-jobs.db`;
  const jobs = await openJobStore(resolvedDbPath);
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
      // GET /health — returns 503 (not 200) when required tools are broken or disk is low
      if (req.method === 'GET' && path === '/health') {
        const { deps, missing_required, disk, healthy } = await checkDeps(baseConfig);
        return reply(res, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'UNHEALTHY',
          version: PIPELINE_VERSION,
          queue_depth: jobs.queueDepth(),
          deps,
          disk,
          missing_required,
        });
      }

      // GET /workers — list all registered worker agents with fresh health snapshots
      if (req.method === 'GET' && path === '/workers') {
        await Promise.all([...workerRegistry.values()].map(refreshWorkerHealth));
        // Prune workers that have been unreachable for >5 min (stale entries after worker restart)
        const STALE_MS = 5 * 60_000;
        for (const [url, entry] of workerRegistry.entries()) {
          if (entry.healthOk === false && Date.now() - (entry.lastSeen ?? 0) > STALE_MS) {
            workerRegistry.delete(url);
            log(`pruned stale worker: ${entry.hostname ?? url}`);
          }
        }
        return reply(res, 200, {
          workers: [...workerRegistry.values()].map(({ url, hostname, platform, lastSeen, health }) => ({
            url, hostname, platform, lastSeen, health,
          })),
        });
      }

      // POST /workers/register — worker agent calls this on startup
      if (req.method === 'POST' && path === '/workers/register') {
        const { url, hostname, platform: plat } = await readBody(req);
        if (!url) return reply(res, 400, { error: 'url required' });
        const existing = workerRegistry.get(url) ?? {};
        workerRegistry.set(url, { ...existing, url, hostname: hostname ?? url, platform: plat ?? 'unknown', lastSeen: Date.now(), healthAt: 0 });
        log(`worker registered: ${hostname ?? url} → ${url}`);
        return reply(res, 200, { ok: true });
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
