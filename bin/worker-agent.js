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
import { cpus, loadavg, totalmem, freemem, hostname, platform, uptime } from 'os';

const execFileAsync = promisify(execFile);

const PORT          = parseInt(process.env.WORKER_PORT ?? '49910');
const CAPACITY_LIMIT = parseFloat(process.env.CAPACITY_LIMIT ?? '0.80');  // 80% threshold
const VERSION       = '1.0.0';
const HOST          = hostname();
const PLATFORM      = platform();

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
    await execFileAsync('python3', ['-c', `import ${pkg}`], { timeout: 8000 });
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

    const { tool, args = [], timeout = 120000 } = payload;
    if (!tool) return send(res, 400, { error: 'missing tool' });

    if (isOverCapacity()) {
      const cap = capacityPayload();
      return send(res, 503, { error: 'over capacity', ...cap });
    }

    // Resolve command: Python batch engines use python3 + script path; others use CMD_ENV_PATHS or tool name.
    const scriptPath = PYTHON_SCRIPTS[tool];
    const [cmd, execArgs] = scriptPath
      ? ['python3', [scriptPath, ...args]]
      : [CMD_ENV_PATHS[tool] ?? tool, args];

    activeJobs++;
    await acquireSlot(tool);
    const started = Date.now();
    try {
      const result = await execFileAsync(cmd, execArgs, {
        timeout,
        maxBuffer: 50 * 1024 * 1024,
      });
      totalJobsServed++;
      send(res, 200, { stdout: result.stdout, stderr: result.stderr ?? '', duration_ms: Date.now() - started });
    } catch (e) {
      const duration_ms = Date.now() - started;
      if (e.code === 'ENOENT') return send(res, 404, { error: `tool not found: ${tool}`, code: 'ENOENT' });
      // execFile rejects with stdout/stderr on non-zero exit — surface them so caller can diagnose
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

server.listen(PORT, () => {
  console.log(`[worker-agent] ${HOST} listening on :${PORT} (${CPU_CORES} cores, ${RAM_GB}GB RAM, limit=${Math.round(CAPACITY_LIMIT*100)}%)`);
  // Probe tools eagerly on startup so first /health is fast
  getTools().then(tools => {
    const available = Object.entries(tools).filter(([,v]) => v).map(([k]) => k);
    console.log(`[worker-agent] tools available: ${available.join(', ')}`);
  });
});

server.on('error', err => {
  console.error(`[worker-agent] server error: ${err.message}`);
  process.exit(1);
});
