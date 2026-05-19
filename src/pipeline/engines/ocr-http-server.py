#!/tank/site2rag/ocr-venv/bin/python3
"""
OCR HTTP service — deploy on any network node to expose OCR engines via HTTP.
Usage: python3 ocr-http-server.py --engine surya --port 8081
Exposes: POST /ocr, GET /health
Protocol: {engine, image_b64, lang} -> {text?, words?}
Supported engines: surya, easyocr, paddleocr, kraken, doctr, tesseract
"""
import sys, os, json, base64, tempfile, argparse, subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

# --- argument parsing ---
parser = argparse.ArgumentParser(description='OCR HTTP service')
parser.add_argument('--engine', required=True, choices=['surya', 'easyocr', 'paddleocr', 'kraken', 'doctr', 'tesseract'])
parser.add_argument('--port', type=int, default=8081)
args = parser.parse_args()

ENGINE_ID = args.engine
PORT = args.port

# --- engine loader: import and init on startup ---
_engine_fn = None

def load_engine():
    global _engine_fn
    sys.stderr.write(f'ocr-http-server: loading engine {ENGINE_ID}...\n')
    sys.stderr.flush()
    if ENGINE_ID == 'surya':
        from PIL import Image
        from surya.recognition import batch_recognition
        from surya.model.recognition.model import load_model
        from surya.model.recognition.processor import load_processor
        rec_model = load_model()
        rec_processor = load_processor()
        LANG_MAP = {
            'ar': ['ar'], 'ara': ['ar'], 'fa': ['fa'], 'fas': ['fa'],
            'fr': ['fr'], 'fra': ['fr'], 'en': ['en'], 'eng': ['en'],
        }
        def _surya(png_path, lang):
            langs = LANG_MAP.get(lang, ['en'])
            img = Image.open(png_path).convert('RGB')
            results = batch_recognition([img], [langs], rec_model, rec_processor)
            text = ' '.join(line.text for page in results for line in page.text_lines)
            return {'text': text, 'words': None}
        _engine_fn = _surya
    elif ENGINE_ID == 'easyocr':
        import easyocr
        LANG_MAP = {
            'en': ['en'], 'eng': ['en'], 'fr': ['fr'], 'fra': ['fr'],
            'ar': ['ar'], 'ara': ['ar'], 'fa': ['fa'], 'fas': ['fa'],
        }
        readers = {}
        def _get_reader(lang):
            langs = LANG_MAP.get(lang, [lang, 'en'])
            key = '+'.join(sorted(langs))
            if key not in readers:
                readers[key] = easyocr.Reader(langs, gpu=False, verbose=False)
            return readers[key]
        def _easyocr(png_path, lang):
            reader = _get_reader(lang)
            raw = reader.readtext(png_path)
            words = [{'text': t, 'conf': float(c), 'x1': int(b[0][0]), 'y1': int(b[0][1]),
                      'x2': int(b[2][0]), 'y2': int(b[2][1])} for b, t, c in raw]
            return {'text': ' '.join(w['text'] for w in words), 'words': words}
        _engine_fn = _easyocr
    elif ENGINE_ID == 'paddleocr':
        from paddleocr import PaddleOCR
        LANG_MAP = {
            'ar': 'arabic', 'ara': 'arabic', 'fa': 'arabic', 'fas': 'arabic',
            'fr': 'french', 'fra': 'french', 'en': 'en', 'eng': 'en',
        }
        ocrs = {}
        def _get_ocr(lang):
            paddle_lang = LANG_MAP.get(lang, 'en')
            if paddle_lang not in ocrs:
                ocrs[paddle_lang] = PaddleOCR(use_angle_cls=True, lang=paddle_lang, show_log=False)
            return ocrs[paddle_lang]
        def _paddle(png_path, lang):
            ocr = _get_ocr(lang)
            result = ocr.ocr(png_path, cls=True)
            words = []
            for page in (result or []):
                for line in (page or []):
                    box, (text, conf) = line
                    xs = [p[0] for p in box]; ys = [p[1] for p in box]
                    words.append({'text': text, 'conf': float(conf),
                                  'x1': int(min(xs)), 'y1': int(min(ys)),
                                  'x2': int(max(xs)), 'y2': int(max(ys))})
            return {'text': ' '.join(w['text'] for w in words), 'words': words}
        _engine_fn = _paddle
    elif ENGINE_ID == 'kraken':
        from kraken import blla, rpred
        from kraken.lib import models as kraken_models
        from PIL import Image
        MODEL_CACHE_DIR = os.path.expanduser('~/.cache/kraken')
        os.makedirs(MODEL_CACHE_DIR, exist_ok=True)
        LANG_MODELS = {'ar': 'arabic_best.mlmodel', 'he': 'hebrew_best.mlmodel'}
        _rec_models = {}
        def _get_model(lang):
            model_name = LANG_MODELS.get(lang, 'en_best.mlmodel')
            if model_name not in _rec_models:
                _rec_models[model_name] = kraken_models.load_any(model_name)
            return _rec_models[model_name]
        def _kraken(png_path, lang):
            img = Image.open(png_path).convert('RGB')
            seg = blla.segment(img)
            model = _get_model(lang)
            pred = rpred.rpred(model, img, seg)
            words = []
            for record in pred:
                for cut in record.cuts:
                    words.append({'text': cut.prediction, 'conf': float(cut.confidences[0]) if cut.confidences else 0.0,
                                  'x1': cut.cuts[0][0], 'y1': cut.cuts[0][1],
                                  'x2': cut.cuts[2][0], 'y2': cut.cuts[2][1]})
            return {'text': ' '.join(w['text'] for w in words), 'words': words}
        _engine_fn = _kraken
    elif ENGINE_ID == 'doctr':
        from doctr.models import ocr_predictor
        from doctr.io import DocumentFile
        predictor = ocr_predictor(pretrained=True)
        def _doctr(png_path, lang):
            doc = DocumentFile.from_images([png_path])
            result = predictor(doc)
            words = []
            for page in result.pages:
                h, w = page.dimensions
                for block in page.blocks:
                    for line in block.lines:
                        for word in line.words:
                            (x1r, y1r), (x2r, y2r) = word.geometry
                            words.append({'text': word.value, 'conf': float(word.confidence),
                                          'x1': int(x1r * w), 'y1': int(y1r * h),
                                          'x2': int(x2r * w), 'y2': int(y2r * h)})
            return {'text': ' '.join(w['text'] for w in words), 'words': words}
        _engine_fn = _doctr
    elif ENGINE_ID == 'tesseract':
        LANG_MAP = {'ar': 'ara', 'ara': 'ara', 'fa': 'fas', 'fas': 'fas', 'fr': 'fra', 'fra': 'fra'}
        def _tesseract(png_path, lang):
            t_lang = LANG_MAP.get(lang, 'eng')
            result = subprocess.run(
                ['tesseract', png_path, 'stdout', '-l', t_lang, 'tsv'],
                capture_output=True, text=True, timeout=60
            )
            words = []
            for line in result.stdout.splitlines()[1:]:
                parts = line.split('\t')
                if len(parts) < 12 or not parts[11].strip():
                    continue
                try:
                    conf = float(parts[10])
                    x1, y1, w2, h2 = int(parts[6]), int(parts[7]), int(parts[8]), int(parts[9])
                    words.append({'text': parts[11].strip(), 'conf': conf,
                                  'x1': x1, 'y1': y1, 'x2': x1 + w2, 'y2': y1 + h2})
                except (ValueError, IndexError):
                    continue
            return {'text': ' '.join(w['text'] for w in words), 'words': words}
        _engine_fn = _tesseract
    sys.stderr.write(f'ocr-http-server: {ENGINE_ID} ready on port {PORT}\n')
    sys.stderr.flush()

# --- HTTP handler ---
class OcrHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass  # suppress default access log

    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'status': 'ok', 'engine': ENGINE_ID}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != '/ocr':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length))
            image_b64 = payload.get('image_b64', '')
            lang = payload.get('lang', 'en')
            # write image to temp file, call engine, clean up
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tf:
                tf.write(base64.b64decode(image_b64))
                tmp_path = tf.name
            try:
                result = _engine_fn(tmp_path, lang)
            finally:
                os.unlink(tmp_path)
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            err = json.dumps({'error': str(e)}).encode()
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(err))
            self.end_headers()
            self.wfile.write(err)

if __name__ == '__main__':
    load_engine()
    server = HTTPServer(('0.0.0.0', PORT), OcrHandler)
    sys.stderr.write(f'ocr-http-server: listening on 0.0.0.0:{PORT}\n')
    sys.stderr.flush()
    server.serve_forever()
