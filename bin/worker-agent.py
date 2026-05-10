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
        # Start new instances if pool is below target size
        while len(pool) < SERVE_POOL_SIZE:
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
