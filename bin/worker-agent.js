#!/usr/bin/env node
// Worker agent — exposes CPU tools (tesseract, python OCR engines) as an HTTP service.
// Runs on any machine; auto-detects hardware and available tools on startup.
// Limits new jobs when load or memory exceeds CAPACITY_LIMIT (default 80%).
// Compatible with pipeline-server /tools/run interface for drop-in routing.
//
// Routes:
//   GET  /health       → capabilities, load metrics, tool availability
//   GET  /capacity     → { available: bool, cpu_pct, mem_pct, active_jobs, queue_depth }
//   POST /tools/run    → { stdout, stderr }  body: { tool, args, timeout? }
//                        503 when over capacity limit

import { createServer } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { cpus, loadavg, totalmem, freemem, hostname, platform, uptime, tmpdir } from 'os';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';

const execFileAsync = promisify(execFile);

const PORT           = parseInt(process.env.WORKER_PORT ?? '49910');
const CAPACITY_LIMIT = parseFloat(process.env.CAPACITY_LIMIT ?? '0.80');
const PYTHON3        = process.env.PYTHON3_PATH ?? 'python3';
const REGISTRY_URL   = process.env.WORKER_REGISTRY ?? '';  // e.g. http://tower-nas:49900
const PUBLIC_URL     = process.env.WORKER_PUBLIC_URL ?? `http://${hostname()}:${parseInt(process.env.WORKER_PORT ?? '49910')}`;
const VERSION        = '1.0.0';
const HOST           = hostname();
const PLATFORM       = platform();

// Python batch engines — NFS path set via env or defaults to tower-nas mount.
// Workers execute these as: python3 scriptPath args...
const PIPELINE_SCRIPTS = process.env.PIPELINE_SCRIPTS ?? '/tank/site2rag/app/src/pipeline';
const PYTHON_SCRIPTS = {
  easyocr_ocr: `${PIPELINE_SCRIPTS}/easyocr_ocr.py`,
  paddle_ocr:  `${PIPELINE_SCRIPTS}/paddle_ocr.py`,
  doctr_ocr:   `${PIPELINE_SCRIPTS}/doctr_ocr.py`,
  kraken_ocr:  `${PIPELINE_SCRIPTS}/kraken_ocr.py`,
};
const PKG_TO_TOOL = { easyocr: 'easyocr_ocr', paddleocr: 'paddle_ocr', doctr: 'doctr_ocr', kraken: 'kraken_ocr' };

// Engines that support --serve mode (persistent warm subprocess, eliminates 30-60s cold-start).
// SERVE_POOL_SIZE: number of parallel instances per engine — each handles one page at a time.
// On a 80-core machine, 4 instances gives ~4× throughput vs single-instance serialization.
const SERVE_CAPABLE = new Set(['easyocr_ocr', 'paddle_ocr', 'doctr_ocr']);
const SERVE_POOL_SIZE = parseInt(process.env.SERVE_POOL_SIZE ?? '4');
// Minimum free RAM to keep — pool stops adding instances below this threshold.
const MIN_POOL_FREE_RAM_GB = parseFloat(process.env.MIN_POOL_FREE_RAM_GB ?? '4.0');
const servePools = new Map(); // tool → [{ proc, ready, pending[], buf }, ...]

import { spawn } from 'child_process';

function _startOneServeInstance(tool, idx) {
  const script = PYTHON_SCRIPTS[tool];
  const entry = { proc: null, ready: false, pending: [], buf: '' };
  const proc = spawn(PYTHON3, [script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  entry.proc = proc;
  proc.stdout.on('data', chunk => {
    entry.buf += chunk.toString();
    const lines = entry.buf.split('\n');
    entry.buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t === 'ready') { entry.ready = true; console.log(`[worker-agent] ${tool}[${idx}] serve ready`); continue; }
      const cb = entry.pending.shift();
      if (cb) cb(null, t);
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('error', e => entry.pending.splice(0).forEach(cb => cb(e)));
  proc.on('close', () => {
    // Remove this instance; pool shrinks until next startServePool call
    const pool = servePools.get(tool);
    if (pool) { const i = pool.indexOf(entry); if (i >= 0) pool.splice(i, 1); }
    entry.pending.splice(0).forEach(cb => cb(new Error('serve proc closed')));
    console.log(`[worker-agent] ${tool}[${idx}] serve exited`);
  });
  return entry;
}

function startServePool(tool) {
  const script = PYTHON_SCRIPTS[tool];
  if (!script) return;
  const existing = servePools.get(tool) ?? [];
  const needed = SERVE_POOL_SIZE - existing.length;
  if (needed <= 0) return;
  const instances = existing;
  for (let i = 0; i < needed; i++) {
    const freeGb = freemem() / (1024 ** 3);
    if (freeGb < MIN_POOL_FREE_RAM_GB) {
      console.log(`[worker-agent] ${tool} pool capped at ${instances.length} instance(s) — only ${freeGb.toFixed(1)}GB free (need ${MIN_POOL_FREE_RAM_GB}GB)`);
      break;
    }
    instances.push(_startOneServeInstance(tool, existing.length + i));
  }
  servePools.set(tool, instances);
}

function runViaServe(tool, args) {
  const pool = servePools.get(tool);
  if (!pool?.length) return null;
  // Pick the ready instance with shortest pending queue
  const ready = pool.filter(e => e.ready);
  if (!ready.length) return null;
  const entry = ready.reduce((a, b) => a.pending.length <= b.pending.length ? a : b);
  const [input_dir, output_json, langs] = args;
  return new Promise((resolve, reject) => {
    entry.pending.push((err, line) => {
      if (err) return reject(err);
      try { const r = JSON.parse(line); r.error ? reject(new Error(r.error)) : resolve({ stdout: '', stderr: '' }); }
      catch (e) { reject(new Error(`bad serve response: ${line}`)); }
    });
    entry.proc.stdin.write(JSON.stringify({ input_dir, output_json, langs: langs ?? 'eng' }) + '\n');
  });
}

// ── Resource detection ─────────────────────────────────────────────────────────

const CPU_CORES = cpus().length;
const RAM_GB    = Math.round(totalmem() / 1024 ** 3 * 10) / 10;

function cpuLoadPct() {
  // loadavg[0] = 1-minute average; normalize by core count
  return Math.min(1, loadavg()[0] / CPU_CORES);
}

function memUsedPct() {
  return 1 - (freemem() / totalmem());
}

function isOverCapacity() {
  return cpuLoadPct() > CAPACITY_LIMIT || memUsedPct() > CAPACITY_LIMIT;
}

// ── Tool probing ───────────────────────────────────────────────────────────────

const TOOLS_TO_PROBE = [
  'tesseract', 'pdftoppm', 'convert', 'gs', 'unpaper', 'python3',
  'surya_ocr', 'ffmpeg',
];

// Python package availability (checked via import)
const PYTHON_PKGS = ['easyocr', 'paddleocr', 'doctr', 'kraken'];

// Env overrides for tool paths (e.g. SURYA_PATH=/tank/site2rag/venv/bin/surya_ocr)
const CMD_ENV_PATHS = { surya_ocr: process.env.SURYA_PATH };

async function probeCmd(cmd) {
  const resolved = CMD_ENV_PATHS[cmd] ?? cmd;
  try {
    await execFileAsync(resolved, ['--version'], { timeout: 5000 });
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    return true; // exists but --version returned non-zero (fine)
  }
}

async function probePythonPkg(pkg) {
  try {
    await execFileAsync(PYTHON3, ['-c', `import ${pkg}`], { timeout: 8000 });
    return true;
  } catch { return false; }
}

async function detectTools() {
  const [cmdResults, pkgResults] = await Promise.all([
    Promise.all(TOOLS_TO_PROBE.map(async t => [t, await probeCmd(t)])),
    Promise.all(PYTHON_PKGS.map(async p => [p, await probePythonPkg(p)])),
  ]);
  const tools = {};
  for (const [t, ok] of cmdResults) tools[t] = ok;
  for (const [p, ok] of pkgResults) tools[`py:${p}`] = ok;
  // Expose engine tool names for workerPool routing (easyocr_ocr, paddle_ocr, etc.)
  for (const [pkg, toolName] of Object.entries(PKG_TO_TOOL)) tools[toolName] = tools[`py:${pkg}`] === true;
  return tools;
}

// ── Job tracking ───────────────────────────────────────────────────────────────

let activeJobs = 0;
let queueDepth = 0;
let totalJobsServed = 0;
let startedAt = new Date().toISOString();

// Per-tool concurrency limits based on core count.
// Tesseract: CPU-bound, run up to (cores * limit) in parallel.
// Neural engines: heavier per-process, fewer concurrent.
function concurrencyFor(tool) {
  if (tool === 'tesseract')  return Math.max(1, Math.floor(CPU_CORES * CAPACITY_LIMIT));
  if (tool === 'surya_ocr')  return 1; // GPU-bound; serialize
  return Math.max(1, Math.floor(CPU_CORES / 4)); // python engines, conservative
}

const toolSemaphores = new Map(); // tool → { active: number, max: number, queue: Function[] }

function getSemaphore(tool) {
  if (!toolSemaphores.has(tool))
    toolSemaphores.set(tool, { active: 0, max: concurrencyFor(tool), queue: [] });
  return toolSemaphores.get(tool);
}

function acquireSlot(tool) {
  return new Promise(resolve => {
    const sem = getSemaphore(tool);
    if (sem.active < sem.max) { sem.active++; resolve(); return; }
    queueDepth++;
    sem.queue.push(() => { queueDepth--; sem.active++; resolve(); });
  });
}

function releaseSlot(tool) {
  const sem = getSemaphore(tool);
  const next = sem.queue.shift();
  if (next) { next(); } else { sem.active--; }
}

// ── HTTP handlers ──────────────────────────────────────────────────────────────

let cachedTools = null;
let toolsProbeTime = 0;
const TOOLS_TTL_MS = 5 * 60 * 1000; // re-probe every 5 minutes

async function getTools() {
  if (!cachedTools || Date.now() - toolsProbeTime > TOOLS_TTL_MS) {
    cachedTools = await detectTools();
    toolsProbeTime = Date.now();
  }
  return cachedTools;
}

function capacityPayload() {
  const cpu = cpuLoadPct();
  const mem = memUsedPct();
  return {
    available: cpu < CAPACITY_LIMIT && mem < CAPACITY_LIMIT,
    cpu_pct:   Math.round(cpu * 1000) / 10,
    mem_pct:   Math.round(mem * 1000) / 10,
    active_jobs: activeJobs,
    queue_depth: queueDepth,
    capacity_limit_pct: Math.round(CAPACITY_LIMIT * 100),
  };
}

async function handleHealth(res) {
  const tools = await getTools();
  const cap   = capacityPayload();
  send(res, 200, {
    status:        cap.available ? 'ok' : 'busy',
    version:       VERSION,
    hostname:      HOST,
    platform:      PLATFORM,
    cpu_cores:     CPU_CORES,
    ram_gb:        RAM_GB,
    uptime_seconds: Math.round(uptime()),
    started_at:    startedAt,
    total_jobs:    totalJobsServed,
    tools,
    ...cap,
  });
}

function handleCapacity(res) {
  send(res, 200, capacityPayload());
}

async function handleToolRun(req, res) {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch { return send(res, 400, { error: 'invalid JSON' }); }

    const { tool, args = [], timeout = 120000, inputFiles = {}, outputPaths = [] } = payload;
    if (!tool) return send(res, 400, { error: 'missing tool' });

    // Serve-capable tools use persistent warm subprocesses — they don't spawn new processes
    // per request, so capacity check is bypassed to prevent load spikes from blocking OCR.
    if (isOverCapacity() && !SERVE_CAPABLE.has(tool)) {
      const cap = capacityPayload();
      return send(res, 503, { error: 'over capacity', ...cap });
    }

    // Write inputFiles to a local tmp dir; remap placeholder keys in args to local paths.
    // This lets the orchestrator send file bytes instead of relying on shared filesystem.
    let tmpDir = null;
    let finalArgs = args;
    let outPathMap = {}; // key → local tmp path for output files to collect after run
    const dirKeyMap = new Map(); // dirKey → local tmp subdir path (hoisted for finally cleanup)

    const hasInputFiles = Object.keys(inputFiles).length > 0;
    if (hasInputFiles || outputPaths.length > 0) {
      tmpDir = mkdtempSync(join(tmpdir(), 'worker-tool-'));
      const inPathMap = {};
      // Reconstruct directories from __dir_N/filename keys; write flat files to tmpDir.
      for (const [key, b64] of Object.entries(inputFiles)) {
        if (key.includes('/')) {
          const slash = key.indexOf('/');
          const dirKey = key.slice(0, slash);
          const filename = key.slice(slash + 1);
          if (!dirKeyMap.has(dirKey)) {
            const dirPath = mkdtempSync(join(tmpdir(), 'wa-dir-'));
            dirKeyMap.set(dirKey, dirPath);
          }
          writeFileSync(join(dirKeyMap.get(dirKey), filename), Buffer.from(b64, 'base64'));
        } else {
          const localPath = join(tmpDir, key);
          writeFileSync(localPath, Buffer.from(b64, 'base64'));
          inPathMap[key] = localPath;
        }
      }
      for (const key of outputPaths) {
        outPathMap[key] = join(tmpDir, key);
      }
      // Remap __dir_N placeholder args to local directory paths; then flat files and output paths.
      finalArgs = args.map(a => dirKeyMap.has(a) ? dirKeyMap.get(a) : inPathMap[a] ?? outPathMap[a] ?? a);
    }

    activeJobs++;
    await acquireSlot(tool);
    const started = Date.now();
    try {
      // Serve mode: persistent warm subprocess for OCR batch engines. Eliminates 30-60s cold-start.
      const serveResult = SERVE_CAPABLE.has(tool) ? await runViaServe(tool, finalArgs) : null;
      const result = serveResult ?? await execFileAsync(
        PYTHON_SCRIPTS[tool] ? PYTHON3 : (CMD_ENV_PATHS[tool] ?? tool),
        PYTHON_SCRIPTS[tool] ? [PYTHON_SCRIPTS[tool], ...finalArgs] : finalArgs,
        { timeout, maxBuffer: 50 * 1024 * 1024 },
      );

      // Collect output files (e.g. pdftoppm output PNGs) and return as base64
      const outputFiles = {};
      for (const [key, localPath] of Object.entries(outPathMap)) {
        const dir = dirname(localPath);
        const base = basename(localPath);
        for (const f of readdirSync(dir).filter(n => n.startsWith(base))) {
          outputFiles[f] = readFileSync(join(dir, f)).toString('base64');
        }
      }

      totalJobsServed++;
      send(res, 200, { stdout: result.stdout, stderr: result.stderr ?? '', duration_ms: Date.now() - started, outputFiles });
    } catch (e) {
      const duration_ms = Date.now() - started;
      if (e.code === 'ENOENT') return send(res, 404, { error: `tool not found: ${tool}`, code: 'ENOENT' });
      // Non-zero exit: return 200 with exit_code so tool-runner doesn't retry uselessly.
      // Only return 500 for actual errors (spawn failure, timeout, OOM).
      if (e.stdout !== undefined || e.stderr !== undefined) {
        // execFile rejects with stdout/stderr on non-zero exit — treat as completed-with-error
        totalJobsServed++;
        return send(res, 200, {
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          exit_code: e.code ?? 1,
          duration_ms,
          outputFiles: {},
        });
      }
      send(res, 500, {
        error: e.message.slice(0, 200),
        code:  e.code,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        duration_ms,
      });
    } finally {
      releaseSlot(tool);
      activeJobs--;
      if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      for (const dirPath of dirKeyMap?.values() ?? []) try { rmSync(dirPath, { recursive: true, force: true }); } catch {}
    }
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

// ── Server ─────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const path = req.url?.split('?')[0];
  if (req.method === 'GET'  && path === '/health')    return handleHealth(res);
  if (req.method === 'GET'  && path === '/capacity')  return handleCapacity(res);
  if (req.method === 'POST' && path === '/tools/run') return handleToolRun(req, res);
  send(res, 404, { error: 'not found' });
});

async function registerWithRegistry() {
  if (!REGISTRY_URL) return;
  try {
    const res = await fetch(`${REGISTRY_URL}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: PUBLIC_URL, hostname: HOST, platform: PLATFORM }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) console.log(`[worker-agent] registered with ${REGISTRY_URL}`);
    else console.warn(`[worker-agent] register failed: ${res.status}`);
  } catch (e) {
    console.warn(`[worker-agent] register error: ${e.message}`);
  }
}

server.listen(PORT, () => {
  console.log(`[worker-agent] ${HOST} listening on :${PORT} (${CPU_CORES} cores, ${RAM_GB}GB RAM, limit=${Math.round(CAPACITY_LIMIT*100)}%)`);
  getTools().then(tools => {
    const available = Object.entries(tools).filter(([,v]) => v).map(([k]) => k);
    console.log(`[worker-agent] tools available: ${available.join(', ')}`);
    registerWithRegistry();
    // Pre-warm serve pools so first OCR job doesn't pay 30-60s cold-start
    for (const tool of SERVE_CAPABLE) {
      if (PYTHON_SCRIPTS[tool]) {
        startServePool(tool); // starts SERVE_POOL_SIZE instances
        console.log(`[worker-agent] pre-warming ${tool} (${SERVE_POOL_SIZE} instances)`);
      }
    }
  });
  setInterval(registerWithRegistry, 60_000);
});

server.on('error', err => {
  console.error(`[worker-agent] server error: ${err.message}`);
  process.exit(1);
});
