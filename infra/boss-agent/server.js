// Node agent server. Exposes capability API on :49910.
import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { hostname, cpus } from 'node:os';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSpec, invalidateCache } from './swagger.js';
import { probe } from './probe.js';
import { snapshot, queue } from './capacity.js';
import { runTool } from './tools/run.js';
import { createJob, updateJob, getJob, listJobs } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
const PORT = parseInt(process.env.NODE_PORT || '49910', 10);
const START_MS = Date.now();

// ── Persistent Python OCR server ──────────────────────────────────────────────
// Keeps ML models warm so engines don't pay 8-12s model-reload per call.
const OCR_SERVER_PORT = parseInt(process.env.OCR_SERVER_PORT || '8090', 10);
const OCR_SERVER_URL  = `http://127.0.0.1:${OCR_SERVER_PORT}`;
const ocrServerScript = path.join(__dirname, 'ocr_server.py');

if (existsSync(ocrServerScript)) {
  const ocrProc = spawn('python3', [ocrServerScript], {
    env: { ...process.env, OCR_SERVER_PORT: String(OCR_SERVER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ocrProc.stdout.on('data', d => process.stdout.write(`[ocr-server] ${d}`));
  ocrProc.stderr.on('data', d => process.stderr.write(`[ocr-server] ${d}`));
  ocrProc.on('exit', (code) => {
    if (code !== 0) console.error(`[ocr-server] exited with code ${code}`);
  });
  process.on('exit', () => ocrProc.kill());
  process.env.OCR_SERVER_URL = OCR_SERVER_URL;
}

const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.raw({ type: '*/*', limit: '500mb' }));

// Cached tool state — refreshed every 5 min
let _tools = {};
let _vramGb = 0;
async function refreshTools() {
  _tools = await probe();
  _vramGb = _tools['_vram_gb'] || 0;
  invalidateCache();
}
await refreshTools();
setInterval(refreshTools, 5 * 60 * 1000);

// --- Routes ---

app.get('/health', (_req, res) => {
  const available = Object.entries(_tools)
    .filter(([k, v]) => !k.startsWith('_') && v)
    .map(([k]) => k);
  res.json({
    status: 'ok',
    hostname: hostname(),
    version: pkg.version,
    uptime_s: Math.round((Date.now() - START_MS) / 1000),
    available_tools: available,
  });
});

app.get(['/swagger', '/openapi.json'], async (_req, res) => {
  const spec = await buildSpec();
  res.json(spec);
});

// Serve Swagger UI for human browsing
app.get('/docs', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Node Agent</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/swagger',dom_id:'#swagger-ui',presets:[SwaggerUIBundle.presets.apis]})</script>
</body></html>`);
});

app.get('/capacity', (_req, res) => {
  res.json(snapshot(_vramGb));
});

// site2rag workerPool compatibility: registry lists this node as only worker
app.get('/workers', (_req, res) => {
  const cap = snapshot(_vramGb);
  // Exclude local CLI tools — pipeline runs these in-process, not via HTTP
  const LOCAL_ONLY = new Set(["tesseract", "pdftoppm", "convert", "unpaper", "gs", "ffmpeg"]);
  const tools = Object.fromEntries(
    Object.entries(_tools).filter(([k, v]) => !k.startsWith("_") && v && !LOCAL_ONLY.has(k))
  );
  res.json({
    workers: [{
      url:      process.env.NODE_PUBLIC_URL || `http://${hostname()}:${PORT}`,
      hostname: hostname(),
      health:   {
        available:   cap.cpu_pct < 90 && cap.queue_depth < 8,
        cpu_pct:     cap.cpu_pct,
        queue_depth: cap.queue_depth,
        cpu_cores:   cpus().length,
        tools,
      },
    }],
  });
});

app.get('/tools/jobs', (_req, res) => {
  res.json(listJobs());
});

app.get('/tools/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// site2rag workerPool compatibility: handles {tool, args, inputFiles, outputPaths} format.
// Supports: tesseract (hocr output), batch OCR engines (dir → JSON).
async function handleArgsRequest(tool, args, inputFiles, outputPaths) {
  // tesseract [inputPng, 'stdout', 'hocr'|'txt', '-l', lang, ...]
  if (tool === 'tesseract') {
    const inKey = args[0];
    const imgB64 = (inputFiles || {})[inKey];
    if (!imgB64) return null;
    const hocrIdx = args.indexOf('hocr');
    const isHocr  = hocrIdx >= 0;
    const langIdx  = args.indexOf('-l');
    const lang     = langIdx >= 0 ? args[langIdx + 1] : 'eng';
    const psmIdx   = args.indexOf('--psm');
    const psm      = psmIdx >= 0 ? parseInt(args[psmIdx + 1], 10) : 3;
    const imgBuf   = Buffer.from(imgB64, 'base64');
    const out      = await runTool('tesseract', imgBuf, { lang, psm, hocr: isHocr });
    return { stdout: out.text || out.hocr || '', stderr: '', exitCode: 0 };
  }

  // Batch OCR: easyocr_ocr, paddle_ocr, doctr_ocr, surya_ocr, kraken_ocr
  // args[0] = inputDir key (e.g. "__dir_0"), args[1] = outputPath key, args[2] = langs (tesseract codes)
  const BATCH_OCR = { easyocr_ocr: true, paddle_ocr: true, doctr_ocr: true, surya_ocr: true, kraken_ocr: true };
  // Tesseract lang codes → easyocr/paddle lang codes
  const TESS_TO_EASYOCR = { eng:'en', fra:'fr', deu:'de', spa:'es', ita:'it', por:'pt', nld:'nl', pol:'pl',
    tur:'tr', rus:'ru', ara:'ar', fas:'fa', heb:'he', jpn:'ja', kor:'ko', chi_sim:'ch_sim', chi_tra:'ch_tra' };
  const TESS_TO_PADDLE = { eng:'en', fra:'fr', deu:'de', spa:'es', ita:'it', por:'pt', nld:'nl', pol:'pl',
    tur:'tr', rus:'ru', ara:'ar', fas:'fa', heb:'he', jpn:'japan', kor:'korean', chi_sim:'ch', chi_tra:'ch' };
  if (BATCH_OCR[tool]) {
    const dirKey    = args[0];
    const outputKey = args[1] || (outputPaths && outputPaths[0]);
    const tessLangs = (args[2] || 'eng').replace(/,/g, '+').split('+').map(l => l.trim()).filter(Boolean);
    if (!dirKey) return null;

    const prefix = dirKey + '/';
    const images = Object.entries(inputFiles || {})
      .filter(([k]) => k.startsWith(prefix) && k.toLowerCase().endsWith('.png'))
      .sort(([a], [b]) => a.localeCompare(b));

    let totalInferenceMs = 0;
    const results = {};
    const langOpt = tool === 'paddle_ocr'
      ? (TESS_TO_PADDLE[tessLangs[0]] || tessLangs[0])
      : tessLangs.map(l => TESS_TO_EASYOCR[l] || l);
    await Promise.all(images.map(async ([key, b64]) => {
      const stem = key.slice(prefix.length).replace(/\.png$/i, '');
      try {
        const imgBuf = Buffer.from(b64, 'base64');
        const out = await runTool(tool, imgBuf, { lang: langOpt });
        if (out.processing_ms) totalInferenceMs += out.processing_ms;
        results[stem] = { text: out.text || (out.result?.[0] ?? []).join(' ') || '', words: [] };
      } catch (e) {
        results[stem] = { text: '', words: [], error: e.message };
      }
    }));

    const jsonB64 = Buffer.from(JSON.stringify(results)).toString('base64');
    const response = { stdout: '', stderr: '', exitCode: 0, inference_ms: totalInferenceMs };
    if (outputKey) response.outputFiles = { [outputKey]: jsonB64 };
    return response;
  }


  // preprocess_image: args = [...flags, inputKey, outputKey] with file contents in inputFiles
  if (tool === 'preprocess_image') {
    const __serverDir = path.dirname(new URL(import.meta.url).pathname);
    const PREPROCESS_PY = path.join(__serverDir, 'tools', 'preprocess_image.py');
    
    const PREPROCESS_PYTHON = process.env.PREPROCESS_PYTHON || '/usr/bin/python3';
    const inKey  = args.find(a => a.startsWith('__in_'));
    const outKey = args.find(a => a.startsWith('__out_')) || (outputPaths && outputPaths[0]);
    const imgB64 = inKey && (inputFiles || {})[inKey];
    if (!imgB64) return null;
    const { mkdtempSync } = await import('node:fs');
    const { rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'slp-pre-'));
    try {
      const inPath  = path.join(dir, 'input.png');
      const outPath = path.join(dir, 'output.png');
      const { writeFile: _wf, readFile: _rf } = await import('node:fs/promises');
      await _wf(inPath, Buffer.from(imgB64, 'base64'));
      const remapped = args.map(a => a === inKey ? inPath : a === outKey ? outPath : a);
      const { stdout, stderr } = await execAsync(
        `${PREPROCESS_PYTHON} ${PREPROCESS_PY} ${remapped.map(a => JSON.stringify(a)).join(' ')}`,
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );
      const result = { stdout, stderr, exitCode: 0 };
      const { existsSync: fsExists } = await import('node:fs');
      if (fsExists(outPath)) {
        const outB64 = (await _rf(outPath)).toString('base64');
        result.outputFiles = { [outKey || '__out_0.png']: outB64 };
      }
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return null;  // not handled — caller falls through to binary-input path
}

app.post('/tools/run', async (req, res) => {
  // Accept JSON body or raw binary (multipart handled by client sending raw bytes)
  const body = Buffer.isBuffer(req.body) ? {} : req.body;
  const tool = body.tool || req.query.tool;
  const opts = body.options || {};
  const isAsync = body.async === true;

  if (!tool) return res.status(400).json({ error: 'tool is required' });
  if (!_tools[tool]) {
    const available = Object.entries(_tools)
      .filter(([k, v]) => !k.startsWith('_') && v).map(([k]) => k);
    return res.status(503).json({ error: `Tool not available: ${tool}`, available_tools: available });
  }

  // site2rag workerPool format: {tool, args, inputFiles, outputPaths}
  if (body.args) {
    queue.increment();
    try {
      const result = await handleArgsRequest(tool, body.args, body.inputFiles, body.outputPaths || []);
      if (result) return res.json(result);
      // Unrecognized args format — fall through to binary handling below
    } catch (err) {
      return res.status(500).json({ error: err.message });
    } finally {
      queue.decrement();
    }
  }

  // Input: base64 in JSON body, or raw binary body, or input_url
  let input;
  if (body.input_b64) {
    input = Buffer.from(body.input_b64, 'base64');
  } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    input = req.body;
  } else if (body.input_url) {
    const r = await fetch(body.input_url);
    input = Buffer.from(await r.arrayBuffer());
  } else {
    input = Buffer.alloc(0);
  }

  if (isAsync) {
    const job_id = createJob(tool);
    queue.increment();
    setImmediate(async () => {
      updateJob(job_id, { status: 'running' });
      try {
        const output = await runTool(tool, input, opts);
        updateJob(job_id, { status: 'complete', output });
      } catch (err) {
        updateJob(job_id, { status: 'failed', error: err.message });
      } finally {
        queue.decrement();
      }
    });
    return res.json({ tool, job_id, status: 'running', node: hostname() });
  }

  queue.increment();
  const t0 = Date.now();
  try {
    const output = await runTool(tool, input, opts);
    res.json({ tool, status: 'complete', output, duration_ms: Date.now() - t0, node: hostname() });
  } catch (err) {
    const status = err.code === 'TOOL_UNAVAILABLE' ? 503 : 500;
    res.status(status).json({ error: err.message });
  } finally {
    queue.decrement();
  }
});

// ── Pipeline: rasterize + all OCR engines + LLM synthesis ────────────────────
// POST /process/page  body: { input_b64, page?, options? }
// Returns: { text, engines: {name: {text, ms}}, synthesis_ms, total_ms }
app.post('/process/page', async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? {} : req.body;
  const opts = body.options || {};
  const page = (body.page || 1) - 1;  // 0-indexed

  let pdfBuf;
  if (body.input_b64)   pdfBuf = Buffer.from(body.input_b64, 'base64');
  else if (body.input_url) { const r = await fetch(body.input_url); pdfBuf = Buffer.from(await r.arrayBuffer()); }
  else return res.status(400).json({ error: 'input_b64 or input_url required' });

  queue.increment();
  const t0 = Date.now();
  try {
    // Stage 1: rasterize
    const raster = await runTool('pdftoppm', pdfBuf, { resolution: opts.resolution || 300, format: 'png' });
    const pagePng = Buffer.from(raster.pages[Math.min(page, raster.pages.length - 1)], 'base64');

    // Stage 2: all available OCR engines in parallel
    const ocrEngines = ['tesseract', 'easyocr_ocr', 'paddle_ocr', 'doctr_ocr', 'surya_ocr', 'kraken_ocr']
      .filter(e => _tools[e]);
    const engineOpts = {
      tesseract:   { lang: opts.lang || 'eng', psm: 3 },
      easyocr_ocr: { lang: [opts.lang2 || 'en'] },
      paddle_ocr:  { lang: opts.lang2 || 'en' },
      doctr_ocr:   {},
      surya_ocr:   {},
      kraken_ocr:  {},
    };

    const results = await Promise.all(
      ocrEngines.map(async name => {
        const t1 = Date.now();
        try {
          const out = await runTool(name, pagePng, engineOpts[name] || {});
          const text = out.text || (out.result?.[0] ?? []).join(' ') || '';
          return { name, text, ms: Date.now() - t1 };
        } catch { return { name, text: '', ms: Date.now() - t1 }; }
      })
    );

    const goodOutputs = results.filter(r => r.text.trim().length > 20);

    // Stage 3: LLM synthesis (skip if no LLM or only one engine output)
    let synthesisText = goodOutputs[0]?.text || '';
    let synthMs = 0;
    if (_tools.llm && goodOutputs.length > 1) {
      const synthPrompt = `Cross-reference these OCR outputs from the same page and produce the most accurate transcription. Preserve layout. Return only the corrected text.\n\n${
        goodOutputs.map(r => `=== ${r.name.toUpperCase()} ===\n${r.text.slice(0, 2000)}`).join('\n\n')
      }`;
      const t2 = Date.now();
      try {
        const synth = await runTool('llm', Buffer.from(synthPrompt), { max_tokens: 2048, temperature: 0.1 });
        synthesisText = synth.text || synthesisText;
        synthMs = Date.now() - t2;
      } catch {}
    }

    const engines = Object.fromEntries(results.map(r => [r.name, { text: r.text, ms: r.ms }]));
    res.json({
      text: synthesisText,
      engines,
      synthesis_ms: synthMs,
      total_ms: Date.now() - t0,
      page_count: raster.pages.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    queue.decrement();
  }
});

// POST /page-task — per-page OCR pipeline (s3+s4+s5), called by Tower orchestrator
app.post('/page-task', async (req, res) => {
  const { image_b64, pageNo, baseline = {}, docContext = {}, config = {} } = req.body;
  if (!image_b64) return res.status(400).json({ error: 'image_b64 required' });
  try {
    const { runPage } = await import('@slp/pipeline/src/page.js');
    const imageBuffer = Buffer.from(image_b64, 'base64');
    const result = await runPage(imageBuffer, baseline, docContext, { ...config, tools: _tools });
    return res.json({ pageNo, ...result });
  } catch (err) {
    console.error(`[page-task] p${pageNo} failed:`, err.message);
    return res.status(500).json({ error: err.message, pageNo });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const available = Object.entries(_tools)
    .filter(([k, v]) => !k.startsWith('_') && v).map(([k]) => k);
  console.log(`[node-agent] ${hostname()} listening on :${PORT}`);
  console.log(`[node-agent] tools: ${available.join(', ') || '(none detected)'}`);
  console.log(`[node-agent] vram: ${_vramGb}GB`);
});
