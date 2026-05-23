// Persistent Python OCR server pool. Loads each model once per process, reuses across pages.
// callEngineEndpoint routes to local subprocess or remote HTTP node based on engine.endpoint.
// Exports: runAllSecondaryEngines, runSuryaServer, runEasyOcrServer, runPaddleOcrServer, callPersistentServer, callEngineEndpoint
// Deps: engines/surya_server.py, engines/easyocr_server.py, engines/paddleocr_server.py (ocr-venv)
// Protocol (local): spawn once → send {path,lang} JSON lines → receive {text}/{words} JSON lines
// Protocol (remote): POST {endpoint}/ocr {engine,image_b64,lang} → {text?,words?}
// Pool routing: if engine has a pool registered in service-registry, callEngineEndpoint delegates to callService()

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const ENGINES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'engines');
export const SURYA_PYTHON = process.env.SURYA_PYTHON ?? '/tank/site2rag/ocr-venv/bin/python3';
export const EASYOCR_PYTHON = process.env.EASYOCR_PYTHON ?? '/tank/site2rag/ocr-venv/bin/python3';
export const PADDLE_PYTHON = process.env.PADDLE_PYTHON ?? '/tank/site2rag/ocr-venv/bin/python3';

// Persistent OCR server processes — models loaded once, reused across all pages.
const _ocrServers = {};

function _getOcrServer(name, pythonBin, script) {
  if (_ocrServers[name]?.proc?.exitCode === null) return _ocrServers[name];
  const proc = spawn(pythonBin, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`));
  proc.on('exit', () => { delete _ocrServers[name]; });
  const server = { proc, pending: [], buf: '' };
  proc.stdout.on('data', chunk => {
    server.buf += chunk.toString();
    let nl;
    while ((nl = server.buf.indexOf('\n')) >= 0) {
      const line = server.buf.slice(0, nl);
      server.buf = server.buf.slice(nl + 1);
      if (server.pending.length > 0) server.pending.shift()(line);
    }
  });
  _ocrServers[name] = server;
  return server;
}

async function _callOcrServer(name, pythonBin, script, req, timeoutMs = 120000) {
  const server = _getOcrServer(name, pythonBin, script);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs);
    server.pending.push(line => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
    server.proc.stdin.write(JSON.stringify(req) + '\n');
  });
}

/** Dispatch a local engine by id to the appropriate persistent server. */
async function callLocalEngine(engineId, pngPath, lang) {
  if (engineId === 'surya') {
    const text = await runSuryaServer(pngPath, lang);
    return { text, words: null };
  }
  if (engineId === 'easyocr') {
    const res = await _callOcrServer('easyocr', EASYOCR_PYTHON, `${ENGINES_DIR}/easyocr_server.py`, { path: pngPath, lang });
    const words = res.words ?? [];
    return { text: words.map(w => w.text).join(' '), words };
  }
  if (engineId === 'paddleocr') {
    const res = await _callOcrServer('paddle', PADDLE_PYTHON, `${ENGINES_DIR}/paddleocr_server.py`, { path: pngPath, lang });
    const words = res.words ?? [];
    return { text: words.map(w => w.text).join(' '), words };
  }
  if (engineId === 'kraken') {
    const res = await _callOcrServer('kraken', SURYA_PYTHON, `${ENGINES_DIR}/kraken_server.py`, { path: pngPath, lang, model: null });
    if (res.error) return { text: '', words: [] };
    const words = res.words ?? [];
    return { text: words.map(w => w.text).join(' '), words };
  }
  if (engineId === 'doctr') {
    const res = await _callOcrServer('doctr', SURYA_PYTHON, `${ENGINES_DIR}/doctr_server.py`, { path: pngPath, lang });
    if (res.error) return { text: '', words: [], layout: null };
    return { text: (res.words ?? []).map(w => w.text).join(' '), words: res.words ?? [], layout: res.layout ?? null };
  }
  if (engineId === 'trocr') {
    const HANDWRITING_LANGS = new Set(['ara','fas','per','ug','pus','dzo']);
    const mode = HANDWRITING_LANGS.has(lang) ? 'handwritten' : 'printed';
    const res = await _callOcrServer('trocr', SURYA_PYTHON, `${ENGINES_DIR}/trocr_server.py`, { path: pngPath, lang, mode });
    if (res.error) return { text: '', words: [] };
    return { text: res.text ?? '', words: [] };
  }
  if (engineId === 'docling') {
    const res = await _callOcrServer('docling', SURYA_PYTHON, `${ENGINES_DIR}/docling_server.py`, { path: pngPath, lang });
    if (res.error) return { text: '', words: [] };
    return { text: res.markdown ?? res.text ?? '', words: [], tables: res.tables ?? [] };
  }
  throw new Error(`callLocalEngine: unknown engine id '${engineId}'`);
}

/**
 * Route an engine call to local subprocess, remote HTTP node, or pool.
 * engine: full engine object from registry (has .endpoint and .id)
 * pngPath: local filesystem path to PNG
 * lang: language code string
 * If the engine has a pool registered in service-registry, delegates to callService() for pool routing.
 */
export async function callEngineEndpoint(engine, pngPath, lang) {
  // Delegate to service-registry pool routing if this engine has a pool
  const { getPoolStatus, callService } = await import('./service-registry.js');
  if (getPoolStatus(engine.id) !== null) return callService(engine.id, pngPath, lang);
  if (engine.endpoint === 'local') return callLocalEngine(engine.id, pngPath, lang);
  // Single remote HTTP call — send image as base64, no shared filesystem required
  const imageB64 = readFileSync(pngPath).toString('base64');
  const res = await fetch(`${engine.endpoint}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: engine.id, image_b64: imageB64, lang }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${engine.id} remote: HTTP ${res.status}`);
  return res.json();
}

/** Run Surya OCR via persistent server. Returns text string. */
export async function runSuryaServer(pngPath, lang) {
  try {
    const res = await _callOcrServer('surya', SURYA_PYTHON, `${ENGINES_DIR}/surya_server.py`, { path: pngPath, lang });
    if (res.error) return '';
    return res.text ?? '';
  } catch { return ''; }
}

/** Run EasyOCR via persistent server. Returns text string. */
export async function runEasyOcrServer(pngPath, lang) {
  try {
    const res = await _callOcrServer('easyocr', EASYOCR_PYTHON, `${ENGINES_DIR}/easyocr_server.py`, { path: pngPath, lang });
    if (res.error) return '';
    return (res.words ?? []).map(w => w.text).join(' ');
  } catch { return ''; }
}

/** Run PaddleOCR via persistent server. Returns text string. */
export async function runPaddleOcrServer(pngPath, lang) {
  try {
    const res = await _callOcrServer('paddle', PADDLE_PYTHON, `${ENGINES_DIR}/paddleocr_server.py`, { path: pngPath, lang });
    if (res.error) return '';
    return (res.words ?? []).map(w => w.text).join(' ');
  } catch { return ''; }
}

/** Run secondary engines in parallel, return {engineName: fullTextString}. */
export async function runAllSecondaryEngines(pngPath, lang, pageNo, engines) {
  const tasks = {};
  const all = engines === 'all' || (Array.isArray(engines) && engines.includes('all'));
  if (all || engines.includes('easyocr')) tasks.easyocr = runEasyOcrServer(pngPath, lang);
  if (all || engines.includes('surya'))   tasks.surya   = runSuryaServer(pngPath, lang);
  if (all || engines.includes('paddle'))  tasks.paddle  = runPaddleOcrServer(pngPath, lang);
  const results = {};
  await Promise.all(Object.entries(tasks).map(async ([name, p]) => {
    results[name] = await p.catch(() => '');
  }));
  return results;
}

export const callPersistentServer = _callOcrServer;
