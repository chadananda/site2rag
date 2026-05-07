// Tool execution abstraction — local CLI, HTTP, or cloud routing per tool.
// Exports: createToolRunner
//   createToolRunner(config) → run(tool, args, opts) → {stdout,stderr}
// Config: toolBackends[tool]={type:'local'|'http', url?}; toolPaths[tool]='/bin/path'
// HTTP backend assumes shared filesystem (NFS/SMB); uses /tools/run on remote pipeline-server

import * as childProcess from 'child_process';
import { promisify } from 'util';

// Known env-var overrides for tool paths (backward compat)
const ENV_PATH_VARS = {
  surya_ocr: 'SURYA_PATH',
};

/**
 * Create a tool runner bound to a config object.
 * Usage: const run = createToolRunner(ctx.config);
 *        await run('pdftoppm', ['-png', '-r', '300', ...], { timeout: 60000 });
 * Note: reads childProcess.execFile at runner-creation time so vi.spyOn mocks are honoured.
 */
export function createToolRunner(config = {}) {
  // Read execFile from the namespace object at creation time — picks up vi.spyOn replacements
  const execFileAsync = promisify(childProcess.execFile);
  return async function runTool(tool, args, opts = {}) {
    const backend = config.toolBackends?.[tool] ?? { type: 'local' };

    if (backend.type === 'http') {
      return runToolHttp(tool, args, opts, backend.url);
    }

    // Local CLI — resolve path from config, then env var, then PATH
    const envVar = ENV_PATH_VARS[tool];
    const cmd = config.toolPaths?.[tool] ?? (envVar ? process.env[envVar] : null) ?? tool;
    return execFileAsync(cmd, args, opts);
  };
}

async function runToolHttp(tool, args, opts, baseUrl) {
  const timeout = opts.timeout ?? 120000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout + 5000); // extra 5s for network
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
    return res.json(); // { stdout, stderr }
  } finally {
    clearTimeout(timer);
  }
}
