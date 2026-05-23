#!/usr/bin/env python3
# Persistent preprocess_image server. Loads torch/GPU once at startup; handles requests without
# per-call import overhead (~2-3s saved per page). Port PREPROCESS_PORT (8094).
# Deps: same as preprocess_image.py (torch, pillow, cv2, unpaper, imagemagick).
import json, base64, tempfile, os, sys, traceback, threading
os.environ.setdefault('HSA_OVERRIDE_GFX_VERSION', '11.5.1')
os.environ.setdefault('ROCBLAS_TENSILE_LIBPATH', '/usr/lib/x86_64-linux-gnu/rocblas/5.1.0/library')

from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# Import process_image — this triggers GPU probe + torch warmup at startup
sys.path.insert(0, os.path.dirname(__file__))
from preprocess_image import process_image

_startup_lock = threading.Lock()
_ready = False

def _warm():
    global _ready
    # Run a no-op to force torch module-level init (GPU probe already runs at import time)
    print('[preprocess-server] warming GPU...', flush=True)
    with _startup_lock:
        _ready = True
    print('[preprocess-server] ready', flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'[preprocess-server] {fmt % args}', flush=True)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'ready': _ready})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/preprocess':
            self._json(404, {'error': 'use POST /preprocess'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except Exception as e:
            self._json(400, {'error': f'bad request: {e}'})
            return

        try:
            result = _handle(body)
            self._json(200, result)
        except Exception as e:
            self._json(500, {'error': traceback.format_exc()})

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)


def _handle(body):
    """
    body: {
      input_b64: <base64 PNG>,
      force: bool,
      issues: [str],
      method: str | null,
      api_key: str | null,
    }
    Returns: {
      result: <process_image result dict>,
      output_b64: <base64 PNG of enhanced image, only if enhanced=true>
    }
    """
    img_bytes = base64.b64decode(body['input_b64'])
    force     = body.get('force', False)
    issues    = body.get('issues', [])
    method    = body.get('method')
    api_key   = body.get('api_key') or os.environ.get('ANTHROPIC_API_KEY')

    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as fin:
        fin.write(img_bytes)
        in_path = fin.name

    out_fd, out_path = tempfile.mkstemp(suffix='.png')
    os.close(out_fd)

    try:
        result = process_image(in_path, out_path,
                               force=force, issues=issues,
                               method=method, api_key=api_key)
        resp = {'result': result}
        if result.get('enhanced') and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            with open(out_path, 'rb') as f:
                resp['output_b64'] = base64.b64encode(f.read()).decode()
    finally:
        try: os.unlink(in_path)
        except: pass
        try: os.unlink(out_path)
        except: pass

    return resp


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    port = int(os.environ.get('PREPROCESS_PORT', 8094))
    _warm()
    server = ThreadedHTTPServer(('0.0.0.0', port), Handler)
    print(f'[preprocess-server] listening on port {port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
