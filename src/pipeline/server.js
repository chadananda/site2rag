// Pipeline HTTP service. Wraps runPipeline() behind a REST API for deployment isolation.
// Exports: startPipelineServer. Deps: job-store.js, index.js, context.js
//
// Routes:
//   GET  /health              → { status, version, queue_depth, deps, missing_required }
//   POST /jobs                → { jobId }        body: { pdfPath, sourceUrl, meta, config, importance }
//   GET  /jobs/:id            → { status, progress, receipt, error, ... }
//   GET  /jobs/:id/md         → text/markdown
//   GET  /jobs/:id/pdf        → application/pdf
//   GET  /jobs/:id/receipt    → JSON receipt from ctx.toReceipt()
//   DELETE /jobs/:id          → { ok: true }
//   GET  /workers             → list of registered worker agents with health snapshots
//   POST /workers/register    → register a worker agent { url, hostname, platform }
//
// To move this service to another host: just point PipelineClient at the new URL.
// Remote hosts: pdfPath must be accessible from the server; for cross-machine use,
// extend with POST /jobs/upload (multipart) when needed.

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PIPELINE_VERSION } from './context.js';
import { runPipeline } from './index.js';
import { openJobStore } from './job-store.js';
import { getTmpDir } from '../config.js';
import { handleRelayRequest } from './ai-relay.js';

const __pyDir = join(dirname(fileURLToPath(import.meta.url)), '.');

const execFileAsync = promisify(execFile);
const log = (msg) => console.log(`[pipeline-server] ${new Date().toISOString().slice(0,19)} ${msg}`);

// ── Worker registry ─────────────────────────────────────────────────────────
// In-memory registry of worker agents on the network.
// Workers self-register via POST /workers/register on startup.
// Health snapshots are refreshed on GET /workers.
// Registry is persisted to SQLite so it survives pm2 restarts without a 60s blind window.
const workerRegistry = new Map(); // url → { url, hostname, platform, lastSeen, health }
const WORKER_HEALTH_TTL_MS = 30_000; // re-poll health every 30s

// ── Worker persistence (SQLite) ──────────────────────────────────────────────
let _workerDb = null;
function openWorkerDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS workers (
    url        TEXT PRIMARY KEY,
    last_seen  INTEGER NOT NULL,
    health_json TEXT
  )`);
  return db;
}
function upsertWorkerDb(url, lastSeen, health) {
  if (!_workerDb) return;
  _workerDb.prepare('INSERT OR REPLACE INTO workers (url, last_seen, health_json) VALUES (?, ?, ?)')
    .run(url, lastSeen, health ? JSON.stringify(health) : null);
}
function deleteWorkerDb(url) {
  if (!_workerDb) return;
  _workerDb.prepare('DELETE FROM workers WHERE url = ?').run(url);
}
async function loadPersistedWorkers() {
  if (!_workerDb) return;
  const rows = _workerDb.prepare('SELECT url, last_seen, health_json FROM workers').all();
  if (!rows.length) return;
  log(`startup: pinging ${rows.length} persisted worker(s)…`);
  await Promise.all(rows.map(async (row) => {
    try {
      const health = await fetchWorkerHealth(row.url);
      if (health) {
        workerRegistry.set(row.url, {
          url: row.url,
          hostname: health.hostname ?? row.url,
          platform: health.platform ?? 'unknown',
          lastSeen: Date.now(),
          health,
          healthOk: true,
          healthAt: Date.now(),
        });
        upsertWorkerDb(row.url, Date.now(), health);
        log(`startup: restored worker ${health.hostname ?? row.url}`);
      } else {
        log(`startup: persisted worker unreachable, dropping: ${row.url}`);
        deleteWorkerDb(row.url);
      }
    } catch {
      deleteWorkerDb(row.url);
    }
  }));
}

async function fetchWorkerHealth(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) }); // 8s: enough for Tailscale
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function refreshWorkerHealth(entry) {
  if (Date.now() - (entry.healthAt ?? 0) < WORKER_HEALTH_TTL_MS) return;
  const fresh = await fetchWorkerHealth(entry.url);
  if (fresh !== null) {
    entry.health = fresh; entry.healthOk = true;
    upsertWorkerDb(entry.url, entry.lastSeen ?? Date.now(), fresh);
  } else entry.healthOk = false; // keep last-known health for routing, but flag as unreachable
  entry.healthAt = Date.now();
}


// Pick the least-loaded healthy registered worker. Returns null if none available.
async function pickWorker() {
  const entries = [...workerRegistry.values()];
  if (!entries.length) return null;
  await Promise.all(entries.map(refreshWorkerHealth));
  const healthy = entries.filter(e => e.healthOk !== false && e.health?.status === 'ok' && e.health?.worker_version != null);
  if (!healthy.length) return null;
  return healthy.sort((a, b) =>
    (a.health?.jobs_active ?? 99) - (b.health?.jobs_active ?? 99)
  )[0];
}

// Dispatch a job to a remote worker via multipart PDF upload.
// Returns { md, receipt } when done, or throws on failure.
async function dispatchToWorker(workerUrl, jobId, pdfPath, onProgress = null) {
  const { readFileSync } = await import('fs');
  const pdfData = readFileSync(pdfPath);
  const boundary = '----SLPBoundary' + Date.now();
  const CRLF = '\r\n';
  const field = (name, value) => Buffer.concat([
    Buffer.from('--' + boundary + CRLF),
    Buffer.from('Content-Disposition: form-data; name="' + name + '"' + CRLF + CRLF),
    Buffer.from(String(value)),
    Buffer.from(CRLF),
  ]);
  const body = Buffer.concat([
    field('doc_id', jobId),
    Buffer.from('--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="source.pdf"' + CRLF +
      'Content-Type: application/pdf' + CRLF + CRLF),
    pdfData,
    Buffer.from(CRLF + '--' + boundary + '--' + CRLF),
  ]);
  const submitRes = await fetch(workerUrl + '/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': String(body.length) },
    body, signal: AbortSignal.timeout(30_000),
  });
  if (!submitRes.ok) {
    const errBody = await submitRes.text();
    if (submitRes.status !== 409) throw new Error('worker submit HTTP ' + submitRes.status + ': ' + errBody.slice(0, 200));
    log('dispatch: 409 job already on worker, polling for completion: ' + jobId);
  }

  const deadline = Date.now() + 4 * 60 * 60 * 1000; // 4h — large docs can take 90+ min
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const d = await (await fetch(workerUrl + '/jobs/' + jobId, { signal: AbortSignal.timeout(15_000) })).json();
      if (onProgress && d.stage) onProgress({ stage: d.stage, pages: d.metrics?.find(m => m.stage === d.stage)?.pages_affected ?? null });
      if (d.status === 'done') {
        const mdRes = await fetch(workerUrl + '/jobs/' + jobId + '/md', { signal: AbortSignal.timeout(30_000) });
        const md = mdRes.ok ? await mdRes.text() : null;
        const rcptRes = await fetch(workerUrl + '/jobs/' + jobId + '/receipt', { signal: AbortSignal.timeout(15_000) });
        const rawReceipt = rcptRes.ok ? await rcptRes.json() : d;
        // Normalize boss receipt to format expected by pdf-upgrade consumer
        const pages = rawReceipt.pages ?? 0;
        const blocks = rawReceipt.blocks ?? 0;
        const synthBlocks = rawReceipt.synth_blocks ?? 0;
        const coverage = blocks > 0 ? synthBlocks / blocks : 0;
        const qualityFinal = parseFloat((0.5 + coverage * 0.4).toFixed(3));
        const receipt = { ...rawReceipt, page_count: pages, quality: { final: qualityFinal, gain: null } };
        // Clean up job on worker after successful retrieval
        fetch(workerUrl + '/jobs/' + jobId, { method: 'DELETE', signal: AbortSignal.timeout(5_000) }).catch(() => {});
        return { md, receipt };
      }
      if (d.status === 'failed' || d.status === 'cancelled') throw new Error('worker job ' + d.status);
    } catch (e) { if (e.message.startsWith('worker job')) throw e; }
  }
  throw new Error('worker job timed out: ' + jobId);
}

// Seed from WORKER_URLS env var: comma-separated list of http://host:port URLs
const SEED_WORKERS = (process.env.WORKER_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
for (const url of SEED_WORKERS) {
  workerRegistry.set(url, { url, hostname: new URL(url).hostname, platform: 'unknown', lastSeen: Date.now() });
}

// Cache dep check results — each check spawns heavy Python processes (PyTorch import = 10-30s, high CPU)
const DEP_CACHE_TTL_MS = 30_000;
let _depCache = null;
let _depCacheAt = 0;
async function checkDepsCached(config = {}) {
  if (_depCache && Date.now() - _depCacheAt < DEP_CACHE_TTL_MS) return _depCache;
  _depCache = await checkDeps(config);
  _depCacheAt = Date.now();
  return _depCache;
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
  // Open worker persistence DB (sibling to jobs DB) and reload saved workers
  const workerDbPath = resolvedDbPath.replace(/pipeline-jobs\.db$/, 'pipeline-workers.db');
  _workerDb = openWorkerDb(workerDbPath);
  await loadPersistedWorkers();
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

    try {
      // Prefer GPU worker (boss) — falls back to local pipeline if none available
      const worker = await pickWorker();
      if (worker) {
        log(`dispatch job=${job.id} → ${worker.hostname ?? worker.url}`);
        const { md, receipt } = await dispatchToWorker(worker.url, job.id, job.pdf_path, p => { if (!jobs.isClosed()) jobs.setProgress(job.id, p); });
        // Write output markdown to the expected location
        if (md && job.pdf_path) {
          const { writeFileSync, mkdirSync } = await import('fs');
          const { join, dirname } = await import('path');
          const outDir = join(dirname(job.pdf_path), '..', 'content');
          mkdirSync(outDir, { recursive: true });
          const mdPath = join(outDir, job.id + '.md');
          writeFileSync(mdPath, md, 'utf8');
          if (!jobs.isClosed()) jobs.setDone(job.id, { mdPath, receipt });
        } else {
          if (!jobs.isClosed()) jobs.setDone(job.id, { receipt });
        }
        log(`done job=${job.id} via ${worker.hostname ?? worker.url}`);
      } else {
        // No GPU worker available — requeue and wait for one
        log(`no worker available for job=${job.id} — requeueing`);
        if (!jobs.isClosed()) jobs.requeue(job.id);
      }
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
        const { deps, missing_required, disk, healthy } = await checkDepsCached(baseConfig);
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
        // Persist fresh health snapshots; prune workers unreachable for >5 min
        const STALE_MS = 5 * 60_000;
        for (const [url, entry] of workerRegistry.entries()) {
          if (entry.healthOk === false && Date.now() - (entry.lastSeen ?? 0) > STALE_MS) {
            workerRegistry.delete(url);
            deleteWorkerDb(url);
            log(`pruned stale worker: ${entry.hostname ?? url}`);
          } else if (entry.health) {
            upsertWorkerDb(url, entry.lastSeen ?? Date.now(), entry.health);
          }
        }
        // Deduplicate by health.hostname — keep the entry with the most recent lastSeen.
        // Prevents same machine registering under both IP and hostname URL.
        const deduped = new Map();
        for (const w of workerRegistry.values()) {
          const key = w.health?.hostname ?? w.hostname ?? w.url;
          const existing = deduped.get(key);
          if (!existing || (w.lastSeen ?? 0) > (existing.lastSeen ?? 0)) deduped.set(key, w);
        }
        return reply(res, 200, {
          workers: [...deduped.values()].map(({ url, hostname, platform, lastSeen, health }) => ({
            url, hostname, platform, lastSeen, health,
          })),
        });
      }

      // POST /workers/register — worker agent calls this on startup
      if (req.method === 'POST' && path === '/workers/register') {
        const { url, hostname, platform: plat } = await readBody(req);
        if (!url) return reply(res, 400, { error: 'url required' });
        const existing = workerRegistry.get(url) ?? {};
        const entry = { ...existing, url, hostname: hostname ?? url, platform: plat ?? 'unknown', lastSeen: Date.now(), healthAt: 0 };
        workerRegistry.set(url, entry);
        upsertWorkerDb(url, Date.now(), existing.health ?? null);
        log(`worker registered: ${hostname ?? url} → ${url}`);
        return reply(res, 200, { ok: true });
      }

      // POST /api/relay — workers relay AI calls through here; orchestrator owns keys + throttling
      if (req.method === 'POST' && path === '/api/relay') {
        const workerToken = req.headers['x-worker-token'] ?? '';
        const secret = process.env.WORKER_SECRET ?? '';
        if (secret && workerToken !== secret) return reply(res, 401, { error: 'unauthorized' });
        const body = await readBody(req);
        const outcome = handleRelayRequest(body, secret, log);
        return reply(res, outcome.error ? 400 : 202, outcome);
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
      const idMatch      = path.match(/^\/jobs\/([^/]+)$/);
      const mdMatch      = path.match(/^\/jobs\/([^/]+)\/md$/);
      const pdfMatch     = path.match(/^\/jobs\/([^/]+)\/pdf$/);
      const receiptMatch = path.match(/^\/jobs\/([^/]+)\/receipt$/);

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

      // GET /jobs/:id/receipt
      if (req.method === 'GET' && receiptMatch) {
        const job = jobs.get(receiptMatch[1]);
        if (!job) return reply(res, 404, { error: 'not found' });
        if (job.status !== 'done' || !job.receipt) return reply(res, 404, { error: 'receipt not available' });
        return reply(res, 200, job.receipt);
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
      return new Promise(r => server.close(() => { try { jobs.db.close(); } catch {} try { _workerDb?.close(); } catch {} r(); }));
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
