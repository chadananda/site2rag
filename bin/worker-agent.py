#!/usr/bin/env python3
# Universal worker agent — CPU/GPU tool executor for any machine on the network.
# Auto-detects hardware, available tools, and load. Reports to any requester.
# Compatible with pipeline-server /tools/run interface.
#
# Install: python3 worker-agent.py [--port 49910] [--registry http://host:49900]
# Routes:
#   GET  /health       → capabilities, load, tool availability
#   GET  /capacity     → { available, cpu_pct, mem_pct, active_jobs, queue_depth }
#   POST /tools/run    → { stdout, stderr, duration_ms } or 503 when over capacity
#   POST /register     → register with a remote registry (called on startup if --registry set)

import base64
import glob
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 64  # allow many concurrent connections

# ── Config ─────────────────────────────────────────────────────────────────────

PORT           = int(os.environ.get('WORKER_PORT', 49910))
CAPACITY_LIMIT = float(os.environ.get('CAPACITY_LIMIT', 0.80))
REGISTRY_URL   = os.environ.get('WORKER_REGISTRY', '')  # e.g. http://tower-nas:49900
AC_ONLY        = os.environ.get('AC_ONLY', '').lower() in ('1', 'true', 'yes')
# Venv bin dir — tools installed via pip (surya_ocr, etc.) live here even if not in system PATH
VENV_BIN       = os.path.dirname(sys.executable)
VERSION        = '1.0.0'
HOST           = socket.gethostname()
PLATFORM       = platform.system().lower()
CPU_CORES      = os.cpu_count() or 1
RAM_GB         = round(__import__('os').sysconf('SC_PAGE_SIZE') * __import__('os').sysconf('SC_PHYS_PAGES') / 1024**3 * 10) / 10 if PLATFORM == 'linux' else 0

def _get_ram_gb():
    try:
        if PLATFORM == 'linux':
            pages = os.sysconf('SC_PHYS_PAGES')
            page_sz = os.sysconf('SC_PAGE_SIZE')
            return round(pages * page_sz / 1024**3 * 10) / 10
        elif PLATFORM == 'darwin':
            sysctl = shutil.which('sysctl') or '/usr/sbin/sysctl'
            out = subprocess.check_output([sysctl, '-n', 'hw.memsize'], text=True).strip()
            return round(int(out) / 1024**3 * 10) / 10
        return 0
    except Exception:
        return 0

def _free_ram_gb():
    """Available (not just free) RAM in GB — accounts for reclaimable cache."""
    try:
        if PLATFORM == 'linux':
            with open('/proc/meminfo') as f:
                for line in f:
                    if line.startswith('MemAvailable:'):
                        return int(line.split()[1]) / 1024**2
        elif PLATFORM == 'darwin':
            vm = subprocess.check_output(['vm_stat'], text=True)
            page_size = 16384  # 16K pages on Apple Silicon, 4K on Intel
            for line in vm.splitlines():
                if 'page size of' in line:
                    page_size = int(line.split()[-2])
                    break
            stats = {}
            for line in vm.splitlines():
                if ':' in line:
                    k, v = line.split(':', 1)
                    stats[k.strip()] = int(v.strip().rstrip('.'))
            free = stats.get('Pages free', 0)
            inactive = stats.get('Pages inactive', 0)
            speculative = stats.get('Pages speculative', 0)
            return round((free + inactive + speculative) * page_size / 1024**3, 1)
    except Exception:
        pass
    return RAM_GB  # if check fails, assume plenty of RAM

RAM_GB = _get_ram_gb()
STARTED_AT = datetime.now(timezone.utc).isoformat()

# ── Resource metrics ───────────────────────────────────────────────────────────

def is_on_ac_power():
    """Returns False when on battery (macOS only). Always True on other platforms."""
    if PLATFORM != 'darwin':
        return True
    try:
        pmset = shutil.which('pmset') or '/usr/bin/pmset'
        result = subprocess.run([pmset, '-g', 'ps'], capture_output=True, text=True, timeout=3)
        return 'AC Power' in result.stdout
    except Exception:
        return True  # assume AC if check fails

MIN_FREE_DISK_GB = float(os.environ.get('MIN_FREE_DISK_GB', '2.0'))  # refuse jobs if tmp dir has < 2GB free

def disk_free_gb():
    """Return free disk space in GB for the temp directory."""
    try:
        s = os.statvfs(tempfile.gettempdir())
        return s.f_bavail * s.f_frsize / 1024**3
    except Exception:
        return 99.0  # assume plenty if check fails

def cpu_load_pct():
    try:
        avg1 = os.getloadavg()[0]
        return min(1.0, avg1 / CPU_CORES)
    except Exception:
        return 0.0

def mem_used_pct():
    try:
        if PLATFORM == 'linux':
            with open('/proc/meminfo') as f:
                info = {}
                for line in f:
                    k, v = line.split(':', 1)
                    info[k.strip()] = int(v.split()[0])
            total = info.get('MemTotal', 1)
            free = info.get('MemAvailable', info.get('MemFree', 0))
            return 1.0 - free / total
        elif PLATFORM == 'darwin':
            out = subprocess.check_output(['vm_stat'], text=True)
            stats = {}
            for line in out.strip().splitlines():
                if ':' in line:
                    k, v = line.split(':', 1)
                    try:
                        stats[k.strip()] = int(v.strip().rstrip('.'))
                    except ValueError:
                        pass
            page_size = 4096
            # inactive pages are reclaimable — include them as "free" for capacity decisions
            free = (stats.get('Pages free', 0) + stats.get('Pages speculative', 0)
                    + stats.get('Pages inactive', 0))
            total_pages = os.sysconf('SC_PHYS_PAGES')
            return 1.0 - (free * page_size) / (total_pages * page_size)
        return 0.0
    except Exception:
        return 0.0

# ── Python script mapping ──────────────────────────────────────────────────────
# Node tool names (easyocr_ocr etc.) map to Python scripts that must be invoked
# via sys.executable, not as bare commands. Search common project locations.

def _find_pipeline_scripts_dir():
    candidates = [
        os.environ.get('PIPELINE_SCRIPTS_DIR', ''),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'pipeline'),
        os.path.expanduser('~/Dropbox/Public/JS/Projects/site2rag/src/pipeline'),
        os.path.expanduser('~/site2rag/src/pipeline'),
        '/opt/site2rag/src/pipeline',
    ]
    for d in candidates:
        if d and os.path.isfile(os.path.join(d, 'easyocr_ocr.py')):
            return d
    return None

_SCRIPTS_DIR = _find_pipeline_scripts_dir()
PYTHON_SCRIPTS = {}
if _SCRIPTS_DIR:
    for _name in ('easyocr_ocr', 'paddle_ocr', 'doctr_ocr', 'kraken_ocr'):
        _path = os.path.join(_SCRIPTS_DIR, f'{_name}.py')
        if os.path.isfile(_path):
            PYTHON_SCRIPTS[_name] = _path

# Engines that support --serve mode (persistent warm process, eliminates cold-start).
# SERVE_POOL_SIZE: parallel instances per engine for throughput (each handles one page at a time).
SERVE_CAPABLE = {'easyocr_ocr', 'paddle_ocr', 'doctr_ocr'}
SERVE_POOL_SIZE = int(os.environ.get('SERVE_POOL_SIZE', '4'))
# Minimum free RAM to keep available — serve pool stops adding instances if this would be violated.
# Prevents OOM on machines where large models exceed available RAM.
MIN_POOL_FREE_RAM_GB = float(os.environ.get('MIN_POOL_FREE_RAM_GB', '4.0'))

# Warm process pool: tool_name → [{'proc': Popen, 'lock': Lock}, ...]
_serve_pool = {}       # tool → list of instance dicts
_serve_pool_lock = threading.Lock()

def _start_serve_instance(tool):
    """Start one --serve subprocess and wait for 'ready'. Returns instance dict or raises.
    Reads lines until 'ready' to skip model download progress output."""
    script = PYTHON_SCRIPTS[tool]
    # Pass MPS fallback env so unsupported ops fall back to CPU instead of crashing on Apple Silicon
    serve_env = {**os.environ, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'}
    proc = subprocess.Popen(
        [sys.executable, script, '--serve'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1,
        env=serve_env,
    )
    try:
        # Models may print download progress to stdout before 'ready'; skip those lines.
        # Timeout: 300s to allow first-time model download on slow connections.
        deadline = time.time() + 300
        while time.time() < deadline:
            ready_line = proc.stdout.readline()
            if not ready_line:
                raise RuntimeError(f'{tool} serve proc closed stdout before ready')
            if ready_line.strip() == 'ready':
                break
        else:
            proc.kill()
            raise RuntimeError(f'{tool} serve proc did not send "ready" within 300s')
    except Exception:
        proc.kill()
        raise
    return {'proc': proc, 'lock': threading.Lock(), 'jobs': 0}

def _get_serve_instance(tool):
    """Return the least-loaded ready instance for tool, starting pool if needed."""
    with _serve_pool_lock:
        pool = _serve_pool.get(tool, [])
        # Remove dead instances
        pool = [e for e in pool if e['proc'].poll() is None]
        # Start new instances if pool is below target size, stopping if RAM is low.
        # _start_serve_instance blocks until the model is fully loaded, so the RAM
        # check after each instance reflects actual consumption — not a race.
        while len(pool) < SERVE_POOL_SIZE:
            free_gb = _free_ram_gb()
            if free_gb < MIN_POOL_FREE_RAM_GB:
                print(f'[worker-agent] {tool} pool capped at {len(pool)} instance(s) '
                      f'— only {free_gb:.1f}GB free (need {MIN_POOL_FREE_RAM_GB}GB)', flush=True)
                break
            try:
                pool.append(_start_serve_instance(tool))
                print(f'[worker-agent] {tool}[{len(pool)-1}] serve ready', flush=True)
            except Exception as e:
                print(f'[worker-agent] {tool} serve start failed: {e}', flush=True)
                break
        _serve_pool[tool] = pool
        if not pool:
            raise RuntimeError(f'no serve instances available for {tool}')
        # Pick instance with fewest in-flight jobs
        return min(pool, key=lambda e: e['jobs'])

def _run_serve_job(tool, input_dir, output_json, langs, timeout):
    """Send one job to least-loaded serve instance; return response."""
    entry = _get_serve_instance(tool)
    req = json.dumps({'input_dir': input_dir, 'output_json': output_json, 'langs': langs}) + '\n'
    with entry['lock']:
        entry['jobs'] += 1
        try:
            entry['proc'].stdin.write(req)
            entry['proc'].stdin.flush()
            resp_line = entry['proc'].stdout.readline()
            if not resp_line:
                raise RuntimeError('serve proc closed stdout')
            resp = json.loads(resp_line)
            if 'error' in resp:
                raise RuntimeError(resp['error'])
            return resp
        except Exception:
            try: entry['proc'].kill()
            except: pass
            with _serve_pool_lock:
                pool = _serve_pool.get(tool, [])
                if entry in pool: pool.remove(entry)
            raise
        finally:
            entry['jobs'] -= 1

# ── Tool probing ───────────────────────────────────────────────────────────────

TOOLS_TO_PROBE = [
    'tesseract', 'pdftoppm', 'convert', 'gs', 'unpaper',
    'python3', 'surya_ocr', 'ffmpeg', 'magick',
]
PYTHON_PKGS = ['easyocr', 'paddleocr', 'doctr', 'kraken', 'torch', 'transformers']

def probe_cmd(cmd):
    # Also search the venv bin dir — tools installed via pip won't be in system PATH
    resolved = shutil.which(cmd) or shutil.which(cmd, path=VENV_BIN) or cmd
    try:
        subprocess.run([resolved, '--version'], capture_output=True, timeout=5)
        return True
    except FileNotFoundError:
        return False
    except Exception:
        return True  # exists but --version errored

def probe_python_pkg(pkg):
    try:
        r = subprocess.run(
            [sys.executable, '-c', f'import {pkg}'],
            capture_output=True, timeout=10
        )
        return r.returncode == 0
    except Exception:
        return False

_cached_tools = None
_tools_probe_time = 0
TOOLS_TTL = 300  # re-probe every 5 minutes

OLLAMA_PORT = int(os.environ.get('OLLAMA_PORT', 11434))
MARKER_PORT  = int(os.environ.get('MARKER_PORT', 49801))

def _http_get_json(url, timeout=3):
    """Fetch JSON from a local HTTP service. Returns parsed dict or None."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None

def _probe_ollama():
    """Return dict of {llm, llm:thinking, vision} based on Ollama model list."""
    data = _http_get_json(f'http://localhost:{OLLAMA_PORT}/api/tags')
    if not data:
        return {'llm': False, 'llm:thinking': False, 'vision': False}
    models = [m.get('name', '') for m in data.get('models', [])]
    # Detect capability from model names/families
    has_vision   = any(any(t in m.lower() for t in ('llava', 'vision', 'minicpm-v', 'bakllava', 'moondream')) for m in models)
    has_thinking = any(any(t in m.lower() for t in ('think', 'r1', 'qwq', 'deepseek-r')) for m in models)
    has_llm      = len(models) > 0  # any model = can do LLM
    # VRAM gate: for non-unified-memory machines check GPU VRAM; for unified (Metal/Strix Halo)
    # treat RAM as VRAM since the same pool is shared.
    vram_gb = _get_vram_gb()
    return {
        'llm':          has_llm      and vram_gb >= 8,   # even 8B models need ~8GB
        'llm:thinking': has_thinking and vram_gb >= 20,
        'vision':       has_vision   and vram_gb >= 8,
    }

def _get_vram_gb():
    """Return estimated VRAM in GB. Uses unified RAM for Apple/AMD APU."""
    # Apple Silicon — unified memory; full RAM is VRAM
    if PLATFORM == 'darwin':
        return RAM_GB
    # AMD ROCm APU (Strix Halo etc.) — unified memory
    try:
        r = subprocess.run(['rocm-smi', '--showmeminfo', 'vram', '--json'],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            info = json.loads(r.stdout)
            # rocm-smi --json format: {"card0": {"VRAM Total Memory (B)": "..."}}
            total = 0
            for card in info.values():
                for k, v in card.items():
                    if 'total' in k.lower() and 'vram' in k.lower():
                        try:
                            total += int(v) / 1024**3
                        except Exception:
                            pass
            if total > 0:
                return total
            # Strix Halo uses unified memory — fall back to system RAM
            return RAM_GB
    except Exception:
        pass
    # NVIDIA: try nvidia-smi
    try:
        r = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            total_mb = sum(int(x.strip()) for x in r.stdout.strip().splitlines() if x.strip().isdigit())
            return total_mb / 1024
    except Exception:
        pass
    return 0

def _probe_marker():
    """Return True if the marker HTTP service is reachable on MARKER_PORT."""
    data = _http_get_json(f'http://localhost:{MARKER_PORT}/health')
    return data is not None

def get_tools():
    global _cached_tools, _tools_probe_time
    if _cached_tools is None or time.time() - _tools_probe_time > TOOLS_TTL:
        tools = {}
        for t in TOOLS_TO_PROBE:
            if shutil.which(t):
                tools[t] = True
            else:
                tools[t] = probe_cmd(t)
        for pkg in PYTHON_PKGS:
            tools[f'py:{pkg}'] = probe_python_pkg(pkg)
        # GPU detection
        tools['gpu:cuda'] = probe_python_pkg('torch') and _has_cuda()
        tools['gpu:rocm'] = probe_python_pkg('torch') and _has_rocm()
        tools['gpu:metal'] = PLATFORM == 'darwin' and probe_python_pkg('torch')
        # NFS check for informational purposes only — no longer gates OCR engines.
        # Files are sent via HTTP base64 inputFiles, so NFS is not required.
        tools['nfs_ok'] = os.path.isdir('/tank/site2rag')
        for pkg, tool_name in [('easyocr', 'easyocr_ocr'), ('paddleocr', 'paddle_ocr'),
                                ('doctr', 'doctr_ocr'), ('kraken', 'kraken_ocr')]:
            tools[tool_name] = tools.get(f'py:{pkg}', False)
        # Document intelligence — Ollama (LLM/vision) and marker HTTP services
        ollama_caps = _probe_ollama()
        tools.update(ollama_caps)
        tools['marker']  = _probe_marker()
        # html2md: pandoc is the primary converter; LLM fallback is handled by the pipeline
        tools['html2md'] = bool(shutil.which('pandoc'))
        # surya_ocr: GPU-only; only advertise if GPU is present
        if not (tools.get('gpu:cuda') or tools.get('gpu:rocm') or tools.get('gpu:metal')):
            tools['surya_ocr'] = False
        _cached_tools = tools
        _tools_probe_time = time.time()
    return _cached_tools

def _has_cuda():
    try:
        r = subprocess.run([sys.executable, '-c', 'import torch; print(torch.cuda.is_available())'],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() == 'True'
    except Exception:
        return False

def _has_rocm():
    try:
        r = subprocess.run(['rocm-smi', '--showuse'], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False

# ── Job tracking and semaphores ────────────────────────────────────────────────

active_jobs = 0
queue_depth = 0
total_jobs  = 0
_lock = threading.Lock()

def concurrency_for(tool):
    if tool == 'tesseract':
        return max(1, int(CPU_CORES * CAPACITY_LIMIT))
    if tool in ('surya_ocr', 'easyocr', 'paddleocr'):
        return 1  # GPU/memory-heavy; serialize
    return max(1, CPU_CORES // 4)

class Semaphore:
    def __init__(self, max_slots):
        self.max = max_slots
        self.active = 0
        self._cond = threading.Condition()

    def acquire(self):
        with self._cond:
            while self.active >= self.max:
                self._cond.wait()
            self.active += 1

    def release(self):
        with self._cond:
            self.active -= 1
            self._cond.notify()

_semaphores = {}
_sem_lock = threading.Lock()

def get_semaphore(tool):
    with _sem_lock:
        if tool not in _semaphores:
            _semaphores[tool] = Semaphore(concurrency_for(tool))
        return _semaphores[tool]

# ── Capacity payload ───────────────────────────────────────────────────────────

def capacity_payload():
    cpu = cpu_load_pct()
    mem = mem_used_pct()
    disk_gb = disk_free_gb()
    on_ac = is_on_ac_power() if AC_ONLY else True
    disk_ok = disk_gb >= MIN_FREE_DISK_GB
    available = on_ac and cpu < CAPACITY_LIMIT and mem < CAPACITY_LIMIT and disk_ok
    payload = {
        'available': available,
        'cpu_pct': round(cpu * 1000) / 10,
        'mem_pct': round(mem * 1000) / 10,
        'disk_free_gb': round(disk_gb * 10) / 10,
        'active_jobs': active_jobs,
        'queue_depth': queue_depth,
        'capacity_limit_pct': round(CAPACITY_LIMIT * 100),
    }
    if AC_ONLY:
        payload['on_ac'] = on_ac
    if not disk_ok:
        payload['disk_low'] = True
    return payload

# ── Dynamic OpenAPI spec ───────────────────────────────────────────────────────

# Human-readable description for each tool key, used in the generated spec.
TOOL_DESCRIPTIONS = {
    'gpu:cuda':     'NVIDIA CUDA GPU or AMD ROCm (ROCm reports true here)',
    'gpu:rocm':     'AMD ROCm GPU',
    'gpu:metal':    'Apple Silicon GPU',
    'gs':           'Ghostscript — PDF normalization and rasterization',
    'pdftoppm':     'Poppler — PDF page to image',
    'convert':      'ImageMagick — image manipulation',
    'unpaper':      'Scan deskew and despeckle',
    'ffmpeg':       'Media processing',
    'tesseract':    'Tesseract — script detection (OSD) and OCR with all language packs',
    'easyocr_ocr':  'EasyOCR — multi-script all-language OCR, serve pool, GPU-preferred',
    'paddle_ocr':   'PaddleOCR — CJK-optimized, Arabic, Latin, serve pool, GPU-preferred',
    'doctr_ocr':    'DocTR — printed document OCR, serve pool, GPU-preferred',
    'kraken_ocr':   'Kraken — historical and Latin OCR, serve pool',
    'surya_ocr':    'Surya — layout segmentation and OCR for complex documents, GPU-preferred',
    'marker':       'Marker — PDF to Markdown with layout understanding, GPU recommended',
    'llm':          'Local LLM via Ollama — orchestration, re-ranking, analysis (requires VRAM ≥16GB)',
    'llm:thinking': 'Thinking/reasoning model via Ollama (requires VRAM ≥20GB)',
    'vision':       'Vision model via Ollama — image to text, not used for RTL scripts (requires VRAM ≥8GB)',
    'html2md':      'HTML/DOCX/EPUB to Markdown conversion',
}

def build_openapi_spec():
    """Build OpenAPI spec dynamically from current tool availability."""
    tools = get_tools()
    available_tools = [k for k, v in tools.items() if v and not k.startswith('gpu:') and not k.startswith('py:') and not k.startswith('nfs')]

    tool_props = {}
    for key, desc in TOOL_DESCRIPTIONS.items():
        tool_props[key] = {'type': 'boolean', 'description': desc}

    return {
        'openapi': '3.0.0',
        'info': {
            'title': f'site2rag Worker Agent — {HOST}',
            'version': VERSION,
            'description': (
                f'Worker on **{HOST}** ({PLATFORM}, {CPU_CORES} cores, {RAM_GB}GB RAM). '
                f'GPU: {"ROCm" if tools.get("gpu:rocm") else "Metal" if tools.get("gpu:metal") else "CUDA" if tools.get("gpu:cuda") else "none"}. '
                f'Available tools: {", ".join(available_tools)}. '
                f'Spec regenerates on each request — reflects current hardware and running services.'
            ),
        },
        'servers': [{'url': f'http://{HOST}:{PORT}'}],
        'paths': {
            '/health': {
                'get': {
                    'summary': 'Full capabilities and current load',
                    'responses': {'200': {'description': 'Worker health snapshot', 'content': {'application/json': {'schema': {'$ref': '#/components/schemas/HealthResponse'}}}}},
                }
            },
            '/capacity': {
                'get': {
                    'summary': 'Lightweight availability check — no tool list',
                    'responses': {'200': {'content': {'application/json': {'schema': {'$ref': '#/components/schemas/CapacityResponse'}}}}},
                }
            },
            '/openapi.json': {
                'get': {
                    'summary': 'This spec — regenerated on each request from live hardware probe',
                    'responses': {'200': {'description': 'OpenAPI spec'}},
                }
            },
            '/tools/run': {
                'post': {
                    'summary': 'Execute an available tool',
                    'description': (
                        'Accepts any tool key currently true in /health tools. '
                        'Files passed as base64 in inputFiles — no shared filesystem required. '
                        'Directories: use __dir_N/filename keys. '
                        'Output files returned as base64 in outputFiles.'
                    ),
                    'requestBody': {
                        'required': True,
                        'content': {'application/json': {'schema': {'$ref': '#/components/schemas/RunRequest'}}},
                    },
                    'responses': {
                        '200': {'description': 'Tool completed', 'content': {'application/json': {'schema': {'$ref': '#/components/schemas/RunResponse'}}}},
                        '400': {'description': 'Missing tool or args'},
                        '500': {'description': 'Tool execution failed'},
                        '503': {'description': 'Worker over capacity — retry with another worker'},
                    },
                }
            },
        },
        'components': {
            'schemas': {
                'Tools': {
                    'type': 'object',
                    'description': 'Live capability map. Regenerated every 5 minutes from hardware probe. Only true values are active.',
                    'properties': tool_props,
                    'example': tools,
                },
                'HealthResponse': {
                    'type': 'object',
                    'properties': {
                        'status':             {'type': 'string', 'enum': ['ok', 'busy']},
                        'hostname':           {'type': 'string'},
                        'platform':           {'type': 'string'},
                        'cpu_cores':          {'type': 'integer'},
                        'ram_gb':             {'type': 'number'},
                        'cpu_pct':            {'type': 'number', 'description': '0–100'},
                        'mem_pct':            {'type': 'number', 'description': '0–100'},
                        'disk_free_gb':       {'type': 'number'},
                        'queue_depth':        {'type': 'integer'},
                        'active_jobs':        {'type': 'integer'},
                        'total_jobs':         {'type': 'integer'},
                        'uptime_seconds':     {'type': 'integer'},
                        'available':          {'type': 'boolean', 'description': 'False when cpu_pct or mem_pct exceeds capacity_limit_pct. Serve-capable OCR tools are exempt.'},
                        'capacity_limit_pct': {'type': 'integer', 'default': 80},
                        'tools':              {'$ref': '#/components/schemas/Tools'},
                    },
                },
                'CapacityResponse': {
                    'type': 'object',
                    'properties': {
                        'available':   {'type': 'boolean'},
                        'cpu_pct':     {'type': 'number'},
                        'mem_pct':     {'type': 'number'},
                        'queue_depth': {'type': 'integer'},
                        'active_jobs': {'type': 'integer'},
                    },
                },
                'RunRequest': {
                    'type': 'object',
                    'required': ['tool', 'args'],
                    'properties': {
                        'tool':        {'type': 'string', 'enum': available_tools, 'description': 'Currently available tools on this worker'},
                        'args':        {'type': 'array', 'items': {'type': 'string'}},
                        'timeout':     {'type': 'integer', 'default': 120000, 'description': 'Milliseconds'},
                        'inputFiles':  {'type': 'object', 'description': 'filename → base64. Directories: __dir_N/filename keys.', 'additionalProperties': {'type': 'string', 'format': 'byte'}},
                        'outputPaths': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Keys to collect after run and return as base64'},
                    },
                },
                'RunResponse': {
                    'type': 'object',
                    'properties': {
                        'stdout':      {'type': 'string'},
                        'stderr':      {'type': 'string'},
                        'duration_ms': {'type': 'integer'},
                        'outputFiles': {'type': 'object', 'additionalProperties': {'type': 'string', 'format': 'byte'}},
                    },
                },
            }
        },
    }

SWAGGER_UI_HTML = '''<!DOCTYPE html>
<html>
<head>
  <title>Worker Agent — {host}</title>
  <meta charset="utf-8"/>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  SwaggerUIBundle({{
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    deepLinking: true,
  }});
</script>
</body>
</html>'''.format(host=HOST)

# ── HTTP handler ───────────────────────────────────────────────────────────────

class WorkerHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default access log

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, status, html):
        data = html.encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/health':
            tools = get_tools()
            cap = capacity_payload()
            self.send_json(200, {
                'status': 'ok' if cap['available'] else 'busy',
                'version': VERSION,
                'hostname': HOST,
                'platform': PLATFORM,
                'arch': platform.machine(),
                'cpu_cores': CPU_CORES,
                'ram_gb': RAM_GB,
                'uptime_seconds': round(time.time() - _start_time),
                'started_at': STARTED_AT,
                'total_jobs': total_jobs,
                'tools': tools,
                **cap,
            })
        elif path == '/capacity':
            self.send_json(200, capacity_payload())
        elif path == '/openapi.json':
            self.send_json(200, build_openapi_spec())
        elif path in ('/docs', '/docs/'):
            self.send_html(200, SWAGGER_UI_HTML)
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        global active_jobs, queue_depth, total_jobs
        path = self.path.split('?')[0]

        length = int(self.headers.get('Content-Length', 0))
        body_raw = self.rfile.read(length)

        if path == '/tools/run':
            try:
                payload = json.loads(body_raw)
            except Exception:
                return self.send_json(400, {'error': 'invalid JSON'})

            tool         = payload.get('tool')
            args         = payload.get('args', [])
            timeout      = payload.get('timeout', 120)
            input_files  = payload.get('inputFiles', {})
            output_paths = payload.get('outputPaths', [])

            if not tool:
                return self.send_json(400, {'error': 'missing tool'})

            cap = capacity_payload()
            # Serve-capable tools use persistent warm processes — bypass capacity check
            # so load spikes don't block OCR (serve instances don't spawn per request).
            use_serve_capable = tool in SERVE_CAPABLE and tool in PYTHON_SCRIPTS
            if not cap['available'] and not use_serve_capable:
                return self.send_json(503, {'error': 'over capacity', **cap})

            # Write inputFiles to local tmp dir; remap placeholder keys in args.
            tmp_dir = None
            out_path_map = {}

            if input_files or output_paths:
                tmp_dir = tempfile.mkdtemp(prefix='worker-tool-')
                in_path_map = {}
                dir_key_map = {}  # dirKey → local tmp subdir path
                for key, b64 in input_files.items():
                    if '/' in key:
                        slash = key.index('/')
                        dir_key = key[:slash]
                        filename = key[slash + 1:]
                        if dir_key not in dir_key_map:
                            dir_path = tempfile.mkdtemp(prefix='wa-dir-')
                            dir_key_map[dir_key] = dir_path
                        local = os.path.join(dir_key_map[dir_key], filename)
                    else:
                        local = os.path.join(tmp_dir, key)
                        in_path_map[key] = local
                    with open(local, 'wb') as f:
                        f.write(base64.b64decode(b64))
                for key in output_paths:
                    out_path_map[key] = os.path.join(tmp_dir, key)
                # Remap __dir_N placeholder args to local directory paths, then flat files/output paths
                remapped = [dir_key_map.get(a) or in_path_map.get(a) or out_path_map.get(a) or a for a in args]
            else:
                remapped = list(args)
                dir_key_map = {}

            # Resolve command
            is_check = '--check' in args
            use_serve = SERVE_POOL_SIZE > 0 and tool in SERVE_CAPABLE and tool in PYTHON_SCRIPTS and not is_check
            if tool in PYTHON_SCRIPTS:
                cmd = sys.executable
                final_args = [PYTHON_SCRIPTS[tool]] + remapped
            else:
                env_paths = {'surya_ocr': os.environ.get('SURYA_PATH', '')}
                cmd = (env_paths.get(tool)
                       or shutil.which(tool)
                       or shutil.which(tool, path=VENV_BIN)
                       or tool)
                final_args = remapped

            sem = get_semaphore(tool)
            with _lock:
                active_jobs_val = active_jobs
                active_jobs += 1

            sem.acquire()
            started = time.time()
            try:
                if use_serve:
                    # Warm serve process — no cold-start model load on repeated calls.
                    # remapped args for OCR scripts: [input_dir, output_json, langs_str]
                    pos = [a for a in remapped if not a.startswith('--')]
                    input_dir_s, output_json_s = pos[0], pos[1]
                    langs_s = pos[2] if len(pos) > 2 else 'eng'
                    _run_serve_job(tool, input_dir_s, output_json_s, langs_s, timeout)
                    result_stdout, result_stderr = '', ''
                    result_code = 0
                else:
                    run_env = {**os.environ, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'}
                    r = subprocess.run(
                        [cmd] + final_args,
                        capture_output=True,
                        timeout=timeout,
                        text=True,
                        env=run_env,
                    )
                    result_stdout, result_stderr = r.stdout, r.stderr
                    result_code = r.returncode
                duration_ms = round((time.time() - started) * 1000)

                if result_code != 0 and not use_serve:
                    # Non-zero exit: return 200 with exit_code rather than raising — avoids
                    # tool-runner retrying tesseract --psm 0 which legitimately exits 1.
                    self.send_json(200, {
                        'stdout': result_stdout,
                        'stderr': result_stderr,
                        'exit_code': result_code,
                        'duration_ms': duration_ms,
                        'outputFiles': {},
                    })
                    return

                # Collect output files and return as base64
                output_files = {}
                for key, local_path in out_path_map.items():
                    base_name = os.path.basename(local_path)
                    parent = os.path.dirname(local_path)
                    for f in os.listdir(parent):
                        if f.startswith(base_name):
                            with open(os.path.join(parent, f), 'rb') as fh:
                                output_files[f] = base64.b64encode(fh.read()).decode()

                with _lock:
                    total_jobs_val = total_jobs
                    total_jobs += 1
                self.send_json(200, {
                    'stdout': result_stdout,
                    'stderr': result_stderr,
                    'duration_ms': duration_ms,
                    'outputFiles': output_files,
                })
            except FileNotFoundError:
                self.send_json(404, {'error': f'tool not found: {tool}', 'code': 'ENOENT'})
            except subprocess.TimeoutExpired:
                self.send_json(500, {'error': f'timeout after {timeout}s', 'code': 'TIMEOUT'})
            except subprocess.CalledProcessError as e:
                self.send_json(500, {'error': e.stderr[:200] if e.stderr else str(e)[:200], 'stdout': e.stdout or '', 'stderr': e.stderr or ''})
            except Exception as e:
                self.send_json(500, {'error': str(e)[:200], 'stdout': '', 'stderr': ''})
            finally:
                sem.release()
                with _lock:
                    active_jobs -= 1
                if tmp_dir:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                for dir_path in dir_key_map.values():
                    shutil.rmtree(dir_path, ignore_errors=True)

        else:
            self.send_json(404, {'error': 'not found'})

# ── Registry registration ──────────────────────────────────────────────────────

def register_with_registry(registry_url, worker_url):
    try:
        payload = json.dumps({
            'url': worker_url,
            'hostname': HOST,
            'platform': PLATFORM,
        }).encode()
        req = urllib.request.Request(
            f'{registry_url}/workers/register',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        urllib.request.urlopen(req, timeout=5)
        print(f'[worker-agent] registered with registry at {registry_url}')
    except Exception as e:
        print(f'[worker-agent] registry registration failed: {e}')

# ── Main ───────────────────────────────────────────────────────────────────────

_start_time = time.time()

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Universal worker agent')
    parser.add_argument('--port', type=int, default=PORT)
    parser.add_argument('--registry', default=REGISTRY_URL)
    parser.add_argument('--capacity-limit', type=float, default=CAPACITY_LIMIT)
    parser.add_argument('--public-url', default='', help='URL to advertise to registry (overrides hostname-based default)')
    args = parser.parse_args()

    PORT = args.port
    CAPACITY_LIMIT = args.capacity_limit
    registry_url = args.registry

    server = ThreadingHTTPServer(('0.0.0.0', PORT), WorkerHandler)

    def shutdown(sig, frame):
        print('\n[worker-agent] shutting down')
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f'[worker-agent] {HOST} listening on :{PORT} ({CPU_CORES} cores, {RAM_GB}GB RAM, limit={round(CAPACITY_LIMIT*100)}%)')

    # Probe tools eagerly, then re-register on a 60s heartbeat so the registry
    # survives pipeline-server restarts without requiring worker restarts.
    def heartbeat_loop():
        tools = get_tools()
        available = [k for k, v in tools.items() if v]
        print(f'[worker-agent] tools: {", ".join(available) or "none"}')
        worker_url = args.public_url or f'http://{HOST}:{PORT}'
        while True:
            if registry_url:
                register_with_registry(registry_url, worker_url)
            time.sleep(60)

    threading.Thread(target=heartbeat_loop, daemon=True).start()

    # Re-probe OCR engines after 15s — on machines with slow venvs (e.g. M1 mini),
    # import easyocr/paddleocr/doctr may fail at cold start but succeed shortly after.
    # A single retry catches this without requiring a manual worker restart.
    def reprobe_ocr_if_needed():
        global _cached_tools, _tools_probe_time
        ocr_pkgs = ['easyocr', 'paddleocr', 'doctr', 'kraken']
        initial = get_tools()
        if not any(initial.get(f'py:{pkg}') is False for pkg in ocr_pkgs):
            return  # all OCR packages found — no retry needed
        time.sleep(15)
        print('[worker-agent] re-probing OCR engines (slow venv startup detected)…', flush=True)
        # Force a fresh probe by resetting the cache timestamp
        _tools_probe_time = 0
        fresh = get_tools()
        gained = [pkg for pkg in ocr_pkgs if not initial.get(f'py:{pkg}') and fresh.get(f'py:{pkg}')]
        if gained:
            print(f'[worker-agent] re-probe gained: {", ".join(gained)}', flush=True)
            # Re-register immediately so the server gets corrected capabilities
            worker_url = args.public_url or f'http://{HOST}:{PORT}'
            registry_url_local = args.registry
            if registry_url_local:
                register_with_registry(registry_url_local, worker_url)
        else:
            print('[worker-agent] re-probe: OCR engines still unavailable', flush=True)

    threading.Thread(target=reprobe_ocr_if_needed, daemon=True).start()

    # Pre-warm serve pools in background — models load once at startup so the
    # first real job doesn't pay the 30-60s cold-start cost.
    def prewarm_serve_pools():
        if SERVE_POOL_SIZE <= 0:
            return  # serve pools disabled
        for tool in SERVE_CAPABLE:
            if tool not in PYTHON_SCRIPTS:
                continue
            try:
                _get_serve_instance(tool)
                print(f'[worker-agent] pre-warmed {tool} ({SERVE_POOL_SIZE} instances)', flush=True)
            except Exception as e:
                print(f'[worker-agent] pre-warm {tool} failed: {e}', flush=True)

    threading.Thread(target=prewarm_serve_pools, daemon=True).start()

    server.serve_forever()
