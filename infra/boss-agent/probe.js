// Probes installed tools and GPU resources. Runs at startup and every 5 min.
// Uses functional tests (actual OCR on /opt/slp-test/probe.png) where available,
// binary/import checks as fallback for environments without the test image.
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';

const execAsync = promisify(exec);

const LLAMA_URL   = process.env.LLAMA_SERVER_URL  || 'http://localhost:8080';
const VISION_URL  = process.env.LLAMA_VISION_URL  || 'http://localhost:8081';
const TORCH_URL   = process.env.TORCH_OCR_URL     || process.env.OCR_SERVER_URL || 'http://localhost:8091';
const PADDLE_URL  = process.env.PADDLE_OCR_URL    || 'http://localhost:8092';
const PROBE_IMG   = '/opt/slp-test/probe.png';
const HAS_PROBE   = existsSync(PROBE_IMG);

async function which(cmd) {
  try { await execAsync(`which ${cmd}`); return true; } catch { return false; }
}

// Check engine availability: health endpoint first (instant), then python import fallback
async function testEngine(serverKey, importName, serverUrl = TORCH_URL) {
  try {
    const r = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    if (d.loaded?.includes(serverKey) || d.engines?.includes(serverKey)) return true;
  } catch {}
  try { await execAsync(`python3 -c "import ${importName}"`, { timeout: 10_000 }); return true; } catch { return false; }
}

// Functional OCR test via persistent server
async function testViaServer(engine, serverUrl = TORCH_URL) {
  if (!HAS_PROBE) return false;
  try {
    const { readFileSync } = await import('node:fs');
    const b64 = readFileSync(PROBE_IMG).toString('base64');
    const res = await fetch(`${serverUrl}/${engine}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: b64, options: {} }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const text = data.text || (data.result?.[0] ?? []).join(' ');
    return typeof text === 'string' && text.trim().length > 0;
  } catch { return false; }
}

// Subprocess test as fallback (cold model — slow but works without ocr-server)
async function testSubprocess(cmd, timeout = 60_000) {
  if (!HAS_PROBE) return false;
  try { await execAsync(cmd, { timeout }); return true; } catch { return false; }
}

async function gpuVramGB() {
  // AMD ROCm (UMA — reports total system RAM available to GPU)
  try {
    const { stdout } = await execAsync(`rocm-smi --showmeminfo vram --csv`, { timeout: 3000 });
    const line = stdout.split('\n').find(l => l.includes('VRAM Total Memory'));
    if (line) {
      const bytes = parseInt(line.split(',')[1], 10);
      if (!isNaN(bytes)) return Math.round(bytes / 1024 / 1024 / 1024);
    }
  } catch {}
  // NVIDIA
  try {
    const { stdout } = await execAsync(
      `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`, { timeout: 3000 }
    );
    const mb = parseInt(stdout.trim().split('\n')[0], 10);
    if (!isNaN(mb)) return Math.round(mb / 1024);
  } catch {}
  // Unified memory fallback (Strix Halo — report total system RAM)
  try {
    const { stdout } = await execAsync(`grep MemTotal /proc/meminfo`);
    const kb = parseInt(stdout.split(/\s+/)[1], 10);
    if (!isNaN(kb)) return Math.round(kb / 1024 / 1024);
  } catch {}
  return 0;
}

async function probeLlamaServer() {
  try {
    const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const body = await r.json();
    return body.status === 'ok';
  } catch { return false; }
}

async function probeVisionServer() {
  try {
    const r = await fetch(`${VISION_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const body = await r.json();
    return body.status === 'ok';
  } catch { return false; }
}

async function probeGpuActive() {
  if (!existsSync('/dev/kfd')) return false;
  try {
    const { stdout } = await execAsync(`rocm_agent_enumerator`, { timeout: 3000 });
    return stdout.trim().split('\n').some(l => l.trim() && l.trim() !== 'cpu');
  } catch {}
  try {
    await execAsync(`rocminfo`, { timeout: 5000 });
    return true;
  } catch { return false; }
}

// Test tesseract directly (fast CLI, no model loading delay)
async function probeTesseract() {
  if (!HAS_PROBE) return which('tesseract');
  try {
    const { stdout } = await execAsync(
      `tesseract ${PROBE_IMG} stdout -l eng --psm 6`, { timeout: 15_000 }
    );
    return stdout.trim().length > 5;
  } catch { return false; }
}

// Test marker (needs a PDF — use gs to create one from probe.png)
async function probeMarker() {
  if (!HAS_PROBE || !(await which('marker_single'))) return false;
  try {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/slp-probe-`);
    const pdf = `${dir}/probe.pdf`;
    await execAsync(`convert ${PROBE_IMG} ${pdf}`, { timeout: 10_000 });
    await execAsync(`marker_single ${pdf} --output_dir ${dir}`, { timeout: 120_000 });
    rmSync(dir, { recursive: true });
    return true;
  } catch { return false; }
}

async function probeKraken() {
  const url = process.env.KRAKEN_OCR_URL || null;
  if (url) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const data = await res.json();
      return data.status === 'ok';
    } catch { return false; }
  }
  // Fallback: check venv + model files exist
  const KRAKEN_VENV = process.env.KRAKEN_VENV || `${process.env.HOME}/slp/engines/kraken/venv`;
  const krakenBin = `${KRAKEN_VENV}/bin/kraken`;
  if (!existsSync(krakenBin)) return false;
  const { glob: _glob } = await import('node:fs/promises');
  let hasBllaModel = false;
  for await (const _ of _glob(`${KRAKEN_VENV}/lib/python*/site-packages/kraken/blla.mlmodel`)) { hasBllaModel = true; break; }
  if (!hasBllaModel) return false;
  const htrmopo = `${process.env.HOME}/.local/share/htrmopo`;
  for await (const _ of _glob(`${htrmopo}/**/*.mlmodel`)) return true;
  return false;
}


async function probePreprocessImage() {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'tools/preprocess_image.py');
  if (!existsSync(script)) return false;
  try {
    const { stdout } = await execAsync(`python3 ${script} --check`, { timeout: 15_000 });
    return stdout.trim() === 'ok';
  } catch { return false; }
}

export async function probe() {
  const [
    hasTesseract,
    hasEasyocr, hasPaddle, hasDoctr, hasSurya,
    hasKraken, hasMarker,
    hasGS, hasPdftoppm, hasConvert, hasUnpaper, hasFfmpeg,
    hasMarkdownify, hasPandoc,
    hasPreprocessImage,
    llamaUp, visionUp, gpuActive,
    kfdExists, nvidiaOk, vram,
  ] = await Promise.all([
    probeTesseract(),
    // Torch engines (8091): easyocr, doctr, surya
    testEngine('easyocr_en', 'easyocr',   TORCH_URL),
    testEngine('paddle',     'rapidocr_onnxruntime', PADDLE_URL),
    testEngine('doctr',      'doctr',     TORCH_URL),
    testEngine('surya',      'surya',     TORCH_URL),
    // CLI tools
    probeKraken(),
    which('marker_single'),
    // Document tools
    which('gs'),
    which('pdftoppm'),
    which('convert'),
    which('unpaper'),
    which('ffmpeg'),
    // HTML conversion
    testSubprocess(`python3 -c "from markdownify import markdownify; markdownify('<p>test</p>')"`, 10_000),
    which('pandoc'),
    // LLM servers
    probeLlamaServer(),
    probeVisionServer(),
    probePreprocessImage(),
    probeGpuActive(),
    Promise.resolve(existsSync('/dev/kfd')),
    which('nvidia-smi'),
    gpuVramGB(),
  ]);

  // GPU type detection
  const rocm  = kfdExists
    ? (await which('rocm_agent_enumerator') || await which('rocminfo'))
    : llamaUp;  // in container: infer from llama-server (systemd blocks CPU-only start)
  const cuda  = nvidiaOk && !kfdExists && !llamaUp;
  const metal = platform() === 'darwin' && arch() === 'arm64';

  const llmReady    = llamaUp;
  const visionReady = visionUp;

  return {
    'tesseract':    hasTesseract,
    'easyocr_ocr':  hasEasyocr,
    'paddle_ocr':   hasPaddle,
    'doctr_ocr':    hasDoctr,
    'kraken_ocr':   hasKraken,
    'surya_ocr':    hasSurya,
    'marker':       hasMarker,
    'mistral_ocr':  !!process.env.MISTRAL_API_KEY,
    'llm':          llmReady,
    'llm:thinking': llmReady,
    'vision':       visionReady,
    'gs':           hasGS,
    'pdftoppm':     hasPdftoppm,
    'convert':      hasConvert,
    'unpaper':      hasUnpaper,
    'ffmpeg':       hasFfmpeg,
    'html2md':      hasMarkdownify || hasPandoc,
    'gpu:rocm':     rocm,
    'gpu:cuda':     cuda,
    'preprocess_image': hasPreprocessImage,
    'gpu:metal':    metal,
    '_vram_gb':     vram,
    '_llama_url':   LLAMA_URL,
    '_vision_url':  VISION_URL,
    '_gpu_active':  gpuActive,
  };
}

if (process.argv[1].endsWith('probe.js')) {
  probe().then(r => console.log(JSON.stringify(r, null, 2)));
}
