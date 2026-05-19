// Tool execution abstraction — local CLI, HTTP, or workerPool routing per tool.
// Exports: createToolRunner, queryWorkerCapacity
//   createToolRunner(config) → run(tool, args, opts) → {stdout,stderr}
//   queryWorkerCapacity(tool, config) → total concurrency slots across available workers, or null
// Config:
//   toolBackends[tool] = { type:'local'|'http'|'workerPool', url?, registryUrl? }
//   toolPaths[tool]    = '/bin/path'
// workerPool: picks least-loaded worker via /tools/run API. File paths in args are auto-inlined
//   as base64 inputFiles so workers need no shared filesystem. Output files are returned as
//   base64 outputFiles and written back locally. Retries up to 5× on any 5xx, falls back to local.

import * as childProcess from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { dirname, join, basename, extname } from 'path';

const __pyDir = dirname(fileURLToPath(import.meta.url));

const ENV_PATH_VARS = { surya_ocr: 'SURYA_PATH' };

// Local fallback: Python batch engines map to scripts in this same directory.
// Workers handle these via their own PYTHON_SCRIPTS map in worker-agent.js.
const PYTHON_SCRIPTS = {
  easyocr_ocr:      join(__pyDir, 'easyocr_ocr.py'),
  paddle_ocr:       join(__pyDir, 'paddle_ocr.py'),
  doctr_ocr:        join(__pyDir, 'doctr_ocr.py'),
  kraken_ocr:       join(__pyDir, 'kraken_ocr.py'),
  preprocess_image: join(__pyDir, 'preprocess_image.py'),
};

// Python worker-agent.py reports batch engine tools as 'easyocr_ocr' etc. when NFS is available.
// No aliases needed — workers only expose these tool names when they can handle directory-based input.
const TOOL_KEY_ALIASES = {};

// Batch OCR engines use persistent serve pools on workers — they accept requests even when the
// worker is "over capacity" (capacity check bypassed for SERVE_CAPABLE tools in worker-agent.js).
// pickWorker must route these to workers regardless of available flag to prevent local fallback.
const SERVE_CAPABLE_TOOLS = new Set(['easyocr_ocr', 'paddle_ocr', 'doctr_ocr', 'kraken_ocr']);

// Tools routed to boss/GPU workers — all compute-heavy work runs on dedicated workers, not the
// orchestrator. GPU workers get a 30-point score advantage. preprocess_image uses CPU OpenCV
// now but will use GPU-accelerated variants (ResShift etc.) in future.
const GPU_PREFERRED_TOOLS = new Set(['easyocr_ocr', 'paddle_ocr', 'doctr_ocr', 'surya_ocr', 'kraken_ocr', 'tesseract', 'preprocess_image']);

// Worker health cache — shared across all tool runners in this process
const _workerCache = new Map(); // registryUrl → { workers, fetchedAt }
const WORKER_CACHE_TTL = 15_000; // 15s — enough to batch a page, fresh enough to react to load

async function fetchWorkers(registryUrl) {
  const cached = _workerCache.get(registryUrl);
  if (cached && Date.now() - cached.fetchedAt < WORKER_CACHE_TTL) return cached.workers;
  try {
    const res = await fetch(`${registryUrl}/workers`, { signal: AbortSignal.timeout(20000) });
    const { workers } = await res.json();
    _workerCache.set(registryUrl, { workers, fetchedAt: Date.now() });
    return workers;
  } catch {
    return cached?.workers ?? [];
  }
}

function workerHasGpu(w) {
  const h = w.health;
  if (!h) return false;
  if (h.tools && (h.tools['gpu:cuda'] || h.tools['gpu:rocm'] || h.tools['gpu:metal'])) return true;
  if (Array.isArray(h.available_tools)) return h.available_tools.some(t => t.startsWith('gpu:'));
  return false;
}

// Score a worker — lower is better.
// cpu_pct drives primary selection; queue_depth penalizes workers with backlogged jobs.
// Unknown cpu_pct (worker doesn't report it) defaults to 30 (assume mostly idle) so
// workers like boss that omit the field aren't penalized vs. known-loaded workers.
// GPU workers get a 30-point advantage for GPU-preferred tools.
function scoreWorker(w, tool) {
  const cpu = w.health.cpu_pct ?? 30;
  const q   = w.health.queue_depth ?? 0;
  let score = cpu + q * 10;
  if (GPU_PREFERRED_TOOLS.has(tool) && !workerHasGpu(w)) score += 30;
  return score;
}

function workerHasTool(w, tool) {
  const h = w.health;
  if (!h) return false;
  // Object format: { tesseract: true, ... } (tower-nas worker-agent)
  if (h.tools && h.tools[tool] === true) return true;
  // Array format: available_tools: ["tesseract", ...] (boss worker-agent)
  if (Array.isArray(h.available_tools) && h.available_tools.includes(tool)) return true;
  // Alias fallback
  const alias = TOOL_KEY_ALIASES[tool];
  if (alias) {
    if (h.tools?.[alias] === true) return true;
    if (Array.isArray(h.available_tools) && h.available_tools.includes(alias)) return true;
  }
  return false;
}

function pickWorker(workers, tool, excludeUrls = new Set()) {
  // Serve-capable tools bypass capacity check on the worker side — route to them even when
  // the worker reports available=false to prevent the local-fallback CPU death spiral.
  if (SERVE_CAPABLE_TOOLS.has(tool)) {
    const capable = workers.filter(w => !excludeUrls.has(w.url) && workerHasTool(w, tool));
    return capable.length ? capable.sort((a, b) => scoreWorker(a, tool) - scoreWorker(b, tool))[0] : null;
  }
  // Prefer workers with confirmed availability; fall back to workers with stale/null health
  // if they have the tool — we'd rather try and get a 503 than skip a healthy worker
  // available: explicit true (tower worker-agent) OR status=ok (boss worker-agent) OR unset (assume ok)
  const isAvailable = (w) => w.health?.available === true || (w.health?.status === 'ok' && w.health?.available == null);
  const confirmed = workers.filter(w => !excludeUrls.has(w.url) && isAvailable(w) && workerHasTool(w, tool));
  if (confirmed.length) return confirmed.sort((a, b) => scoreWorker(a, tool) - scoreWorker(b, tool))[0];
  const optimistic = workers.filter(w => !excludeUrls.has(w.url) && w.health?.available !== false && workerHasTool(w, tool));
  if (!optimistic.length) return null;
  return optimistic.sort((a, b) => scoreWorker(a, tool) - scoreWorker(b, tool))[0];
}

/**
 * Query total concurrency slots available for a tool across all registered workers.
 * Uses cpu_cores from health to estimate slots (same formula as worker-agent.js concurrencyFor).
 * Returns null when not using workerPool or no workers are reachable.
 */
export async function queryWorkerCapacity(tool, config = {}) {
  const backend = config.toolBackends?.[tool];
  if (!backend || backend.type !== 'workerPool') return null;
  const registryUrl = backend.registryUrl ?? config.registryUrl ?? 'http://localhost:49900';
  try {
    const workers = await fetchWorkers(registryUrl);
    const available = workers.filter(w => w.health?.available && workerHasTool(w, tool));
    if (!available.length) return null;
    return available.reduce((sum, w) => {
      const cores  = w.health.cpu_cores ?? 4;
      const capPct = w.health.capacity_limit_pct != null ? w.health.capacity_limit_pct / 100 : 0.8;
      // Surya is GPU-serialized (1 per worker); all others scale with cores × capacity limit
      const slots = tool === 'surya_ocr' ? 1 : Math.max(1, Math.floor(cores * capPct));
      return sum + slots;
    }, 0);
  } catch {
    return null;
  }
}

export function createToolRunner(config = {}) {
  const execFileAsync = promisify(childProcess.execFile);

  return async function runTool(tool, args, opts = {}) {
    const backend = config.toolBackends?.[tool] ?? { type: 'local' };

    if (backend.type === 'workerPool') {
      const registryUrl = backend.registryUrl ?? config.registryUrl ?? 'http://localhost:49900';
      const log = (msg) => console.log(`[tool-runner] ${msg}`);
      const excluded = new Set();
      let lastErr;

      // Retry loop: up to 5 attempts. On any 5xx: exclude the failed worker, try next.
      // Scales to a 10-machine farm — exhausts 5 workers before falling through to local.
      for (let attempt = 0; attempt <= 4; attempt++) {
        if (attempt > 0) _workerCache.delete(registryUrl); // force fresh health on retry
        const workers = await fetchWorkers(registryUrl);
        const worker = pickWorker(workers, tool, excluded);
        if (!worker) break; // no eligible workers remain

        const gpuTag = workerHasGpu(worker) ? ' gpu' : '';
        log(`routing ${tool} → ${worker.hostname} cpu=${worker.health.cpu_pct}%${gpuTag} q=${worker.health.queue_depth ?? 0}${attempt > 0 ? ` [retry ${attempt}]` : ''}`);
        try {
          return await runToolHttp(tool, args, opts, worker.url);
        } catch (e) {
          if (e.httpStatus >= 500 || !e.httpStatus) {
            // 5xx = worker-side failure; no httpStatus = network error (connection refused, timeout)
            // In both cases, excluding this worker and trying the next is the right move.
            const reason = e.httpStatus === 503 ? 'over capacity' : e.httpStatus ? `error ${e.httpStatus}` : 'network error';
            log(`${worker.hostname} ${reason} for ${tool} — trying next worker`);
            excluded.add(worker.url);
            lastErr = e;
            continue;
          }
          throw e; // 4xx errors are not retried
        }
      }

      // All eligible workers failed or none available — fall through to local
      log(`no available worker for ${tool}${lastErr ? ` (${lastErr.message.slice(0, 80)})` : ''}, running locally`);
    }

    if (backend.type === 'http') {
      return runToolHttp(tool, args, opts, backend.url);
    }

    // Local — Python batch engines use python3 + script path; PYTHON3_PATH overrides python3
    const python3 = config.python3Path ?? process.env.PYTHON3_PATH ?? 'python3';
    const scriptPath = PYTHON_SCRIPTS[tool];
    if (scriptPath) return execFileAsync(python3, [scriptPath, ...args], opts);
    const envVar = ENV_PATH_VARS[tool];
    const cmd = config.toolPaths?.[tool] ?? (envVar ? process.env[envVar] : null) ?? tool;
    return execFileAsync(cmd, args, opts);
  };
}

async function runToolHttp(tool, args, opts, baseUrl) {
  const timeout = opts.timeout ?? 120000;

  // Auto-inline local file paths as base64 so workers need no shared filesystem.
  // Existing files → inputFiles (keyed by basename). Non-existent path-like args → outputPaths
  // (worker writes the tool's output there and returns them as base64 outputFiles).
  const inputFiles = {};
  const outputPaths = [];
  const outputPathMap = {}; // key → original local path for writing back after run
  let keyIdx = 0;

  const remappedArgs = args.map(arg => {
    if (typeof arg !== 'string' || !arg.startsWith('/')) return arg;
    if (existsSync(arg)) {
      // Directories: pack all files as inputFiles so workers need no shared filesystem.
      try {
        if (statSync(arg).isDirectory()) {
          const dirKey = `__dir_${keyIdx++}`;
          for (const f of readdirSync(arg)) {
            const fp = join(arg, f);
            if (statSync(fp).isFile())
              inputFiles[`${dirKey}/${f}`] = readFileSync(fp).toString('base64');
          }
          return dirKey;
        }
      } catch {}

      const key = `__in_${keyIdx++}${extname(arg)}`;
      inputFiles[key] = readFileSync(arg).toString('base64');
      return key;
    }
    // Non-existent absolute path → treat as output file; worker will collect and return it
    const parentExists = existsSync(dirname(arg));
    if (parentExists) {
      const key = `__out_${keyIdx++}${extname(arg)}`;
      outputPaths.push(key);
      outputPathMap[key] = arg;
      return key;
    }
    return arg;
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout + 5000);
  try {
    const res = await fetch(`${baseUrl}/tools/run`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args: remappedArgs, inputFiles, outputPaths, timeout }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.error ?? `Tool '${tool}' failed with HTTP ${res.status}`);
      e.httpStatus = res.status;
      if (body.code) e.code = body.code;
      throw e;
    }
    const result = await res.json();
    // Write back any output files the worker returned
    for (const [key, b64] of Object.entries(result.outputFiles ?? {})) {
      // Match worker-returned filename to our outputPathMap key prefix
      const matchKey = outputPaths.find(k => key.startsWith(k) || key === k);
      const localPath = matchKey ? outputPathMap[matchKey].replace(extname(outputPathMap[matchKey]), extname(key))
                                 : join(dirname(Object.values(outputPathMap)[0] ?? '/tmp'), key);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, Buffer.from(b64, 'base64'));
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
