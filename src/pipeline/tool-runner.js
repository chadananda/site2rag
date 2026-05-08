// Tool execution abstraction — local CLI, HTTP, or workerPool routing per tool.
// Exports: createToolRunner
//   createToolRunner(config) → run(tool, args, opts) → {stdout,stderr}
// Config:
//   toolBackends[tool] = { type:'local'|'http'|'workerPool', url?, registryUrl? }
//   toolPaths[tool]    = '/bin/path'
// workerPool: queries registryUrl/workers, picks lowest-load available worker that has the tool.
// http/workerPool assume shared filesystem (NFS); paths in args must be reachable on the worker.

import * as childProcess from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __pyDir = dirname(fileURLToPath(import.meta.url));

const ENV_PATH_VARS = { surya_ocr: 'SURYA_PATH' };

// Local fallback: Python batch engines map to scripts in this same directory.
// Workers handle these via their own PYTHON_SCRIPTS map in worker-agent.js.
const PYTHON_SCRIPTS = {
  easyocr_ocr: join(__pyDir, 'easyocr_ocr.py'),
  paddle_ocr:  join(__pyDir, 'paddle_ocr.py'),
  doctr_ocr:   join(__pyDir, 'doctr_ocr.py'),
  kraken_ocr:  join(__pyDir, 'kraken_ocr.py'),
};

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

function pickWorker(workers, tool) {
  // Filter: available, has the tool, not over capacity
  const candidates = workers.filter(w =>
    w.health?.available &&
    w.health?.tools?.[tool] === true
  );
  if (!candidates.length) return null;
  // Pick lowest CPU load
  return candidates.sort((a, b) => (a.health.cpu_pct ?? 100) - (b.health.cpu_pct ?? 100))[0];
}

export function createToolRunner(config = {}) {
  const execFileAsync = promisify(childProcess.execFile);

  return async function runTool(tool, args, opts = {}) {
    const backend = config.toolBackends?.[tool] ?? { type: 'local' };

    if (backend.type === 'workerPool') {
      const registryUrl = backend.registryUrl ?? config.registryUrl ?? 'http://localhost:49900';
      const workers = await fetchWorkers(registryUrl);
      const worker = pickWorker(workers, tool);
      if (worker) {
        const log = config._log ?? (() => {});
        log(`[tool-runner] routing ${tool} → ${worker.hostname} (cpu=${worker.health.cpu_pct}%)`);
        return runToolHttp(tool, args, opts, worker.url);
      }
      // No available worker — fall through to local
      const log = config._log ?? (() => {});
      log(`[tool-runner] no available worker for ${tool}, running locally`);
    }

    if (backend.type === 'http') {
      return runToolHttp(tool, args, opts, backend.url);
    }

    // Local — Python batch engines use python3 + script path
    const scriptPath = PYTHON_SCRIPTS[tool];
    if (scriptPath) return execFileAsync('python3', [scriptPath, ...args], opts);
    const envVar = ENV_PATH_VARS[tool];
    const cmd = config.toolPaths?.[tool] ?? (envVar ? process.env[envVar] : null) ?? tool;
    return execFileAsync(cmd, args, opts);
  };
}

async function runToolHttp(tool, args, opts, baseUrl) {
  const timeout = opts.timeout ?? 120000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout + 5000);
  try {
    const res = await fetch(`${baseUrl}/tools/run`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args, timeout }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.error ?? `Tool '${tool}' failed with HTTP ${res.status}`);
      if (body.code) e.code = body.code;
      throw e;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}
