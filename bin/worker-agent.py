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
    on_ac = is_on_ac_power() if AC_ONLY else True
    available = on_ac and cpu < CAPACITY_LIMIT and mem < CAPACITY_LIMIT
    payload = {
        'available': available,
        'cpu_pct': round(cpu * 1000) / 10,
        'mem_pct': round(mem * 1000) / 10,
        'active_jobs': active_jobs,
        'queue_depth': queue_depth,
        'capacity_limit_pct': round(CAPACITY_LIMIT * 100),
    }
    if AC_ONLY:
        payload['on_ac'] = on_ac
    return payload

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
            if not cap['available']:
                return self.send_json(503, {'error': 'over capacity', **cap})

            # Resolve path: env override → system PATH → venv bin → bare name
            env_paths = {'surya_ocr': os.environ.get('SURYA_PATH', '')}
            cmd = (env_paths.get(tool)
                   or shutil.which(tool)
                   or shutil.which(tool, path=VENV_BIN)
                   or tool)

            # Write inputFiles to local tmp dir; remap placeholder keys in args to local paths.
            tmp_dir = None
            final_args = list(args)
            out_path_map = {}  # key → local tmp path for output files

            if input_files or output_paths:
                tmp_dir = tempfile.mkdtemp(prefix='worker-tool-')
                in_path_map = {}
                for key, b64 in input_files.items():
                    local = os.path.join(tmp_dir, key)
                    with open(local, 'wb') as f:
                        f.write(base64.b64decode(b64))
                    in_path_map[key] = local
                for key in output_paths:
                    out_path_map[key] = os.path.join(tmp_dir, key)
                final_args = [in_path_map.get(a) or out_path_map.get(a) or a for a in args]

            sem = get_semaphore(tool)
            with _lock:
                active_jobs_val = active_jobs
                active_jobs += 1

            sem.acquire()
            started = time.time()
            try:
                result = subprocess.run(
                    [cmd] + final_args,
                    capture_output=True,
                    timeout=timeout,
                    text=True,
                )
                duration_ms = round((time.time() - started) * 1000)

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
                    'stdout': result.stdout,
                    'stderr': result.stderr,
                    'duration_ms': duration_ms,
                    'outputFiles': output_files,
                })
            except FileNotFoundError:
                self.send_json(404, {'error': f'tool not found: {tool}', 'code': 'ENOENT'})
            except subprocess.TimeoutExpired:
                self.send_json(500, {'error': f'timeout after {timeout}s', 'code': 'TIMEOUT'})
            except Exception as e:
                self.send_json(500, {'error': str(e)[:200], 'stdout': '', 'stderr': ''})
            finally:
                sem.release()
                with _lock:
                    active_jobs -= 1
                if tmp_dir:
                    shutil.rmtree(tmp_dir, ignore_errors=True)

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
    args = parser.parse_args()

    PORT = args.port
    CAPACITY_LIMIT = args.capacity_limit
    registry_url = args.registry

    server = HTTPServer(('0.0.0.0', PORT), WorkerHandler)

    def shutdown(sig, frame):
        print('\n[worker-agent] shutting down')
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f'[worker-agent] {HOST} listening on :{PORT} ({CPU_CORES} cores, {RAM_GB}GB RAM, limit={round(CAPACITY_LIMIT*100)}%)')

    # Probe tools eagerly
    def startup_probe():
        tools = get_tools()
        available = [k for k, v in tools.items() if v]
        print(f'[worker-agent] tools: {", ".join(available) or "none"}')
        if registry_url:
            register_with_registry(registry_url, f'http://{HOST}:{PORT}')

    threading.Thread(target=startup_probe, daemon=True).start()
    server.serve_forever()
