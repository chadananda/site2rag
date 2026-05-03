#!/usr/bin/env python3
"""Marker PDF-to-Markdown HTTP service for tower-nas.
Loads Surya/Marker models once at startup, serves conversions on demand.
Uses MARKER_WORKERS concurrent conversions (default 8 for 80-core tower-nas).

Endpoint: POST /convert  { "pdf_path": "/abs/path/to/file.pdf" }
          GET  /health
          GET  /stats
"""
import json, os, sys, threading, time
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get('MARKER_PORT', 7842))
WORKERS = int(os.environ.get('MARKER_WORKERS', 8))

print('[marker-service] loading models...', flush=True)
t0 = time.time()

from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

MODELS = create_model_dict()
print(f'[marker-service] models loaded in {time.time()-t0:.1f}s', flush=True)

_sem = threading.Semaphore(WORKERS)
_stats = {'requests': 0, 'ok': 0, 'errors': 0, 'total_ms': 0}
_lock = threading.Lock()


def convert_pdf(pdf_path):
    converter = PdfConverter(artifact_dict=MODELS)
    rendered = converter(pdf_path)
    text, _, _ = text_from_rendered(rendered)
    return text


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        elif self.path == '/stats':
            with _lock:
                s = dict(_stats)
            avg_ms = int(s['total_ms'] / max(s['ok'], 1))
            self.send_json(200, {**s, 'avg_ms': avg_ms, 'workers': WORKERS, 'port': PORT})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != '/convert':
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length))
        except Exception:
            self.send_json(400, {'error': 'invalid JSON', 'ok': False})
            return
        pdf_path = body.get('pdf_path', '')
        if not pdf_path or not os.path.isabs(pdf_path) or not os.path.exists(pdf_path):
            self.send_json(400, {'error': f'pdf_path not found: {pdf_path}', 'ok': False})
            return
        t_start = time.time()
        with _lock:
            _stats['requests'] += 1
        _sem.acquire()
        try:
            markdown = convert_pdf(pdf_path)
            elapsed_ms = int((time.time() - t_start) * 1000)
            with _lock:
                _stats['ok'] += 1
                _stats['total_ms'] += elapsed_ms
            self.send_json(200, {'markdown': markdown, 'ok': True, 'ms': elapsed_ms})
        except Exception as e:
            with _lock:
                _stats['errors'] += 1
            self.send_json(500, {'error': str(e), 'ok': False})
        finally:
            _sem.release()


print(f'[marker-service] ready on :{PORT} ({WORKERS} workers)', flush=True)
ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
