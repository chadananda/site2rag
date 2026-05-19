#!/tank/site2rag/ocr-venv/bin/python3
"""Kraken persistent server. Protocol: {"path": "...", "lang": "ar", "model": null} → {"words": [...]}
Loads default blla segmentation model on startup. Downloads lang-specific rec model on first use.
"""
import sys, json, os, traceback

sys.stderr.write('kraken_server: loading models...\n')
sys.stderr.flush()

try:
    from kraken import blla, rpred
    from kraken.lib import models as kraken_models
    from PIL import Image
    sys.stderr.write('kraken_server: ready\n')
    sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'kraken_server: FATAL load error: {e}\n')
    sys.stderr.flush()
    sys.exit(1)

# Cache for loaded recognition models keyed by model path/name
_rec_models = {}

# Default model paths — these are checked locally first, then downloaded
MODEL_CACHE_DIR = os.path.expanduser('~/.cache/kraken')
os.makedirs(MODEL_CACHE_DIR, exist_ok=True)

# Language → model name mapping (Kraken model hub)
LANG_MODELS = {
    'ar': 'arabic_best.mlmodel',
    'ara': 'arabic_best.mlmodel',
    'he': 'hebrew_best.mlmodel',
    'la': 'latin_best.mlmodel',
    'gr': 'greek_best.mlmodel',
    'en': 'en_best.mlmodel',
    'fr': 'french_best.mlmodel',
    'de': 'german_best.mlmodel',
}

def get_model_path(lang):
    model_name = LANG_MODELS.get(lang, 'en_best.mlmodel')
    local_path = os.path.join(MODEL_CACHE_DIR, model_name)
    return local_path, model_name

def get_rec_model(lang):
    model_path, model_name = get_model_path(lang)
    key = model_path
    if key not in _rec_models:
        if os.path.exists(model_path):
            try:
                _rec_models[key] = kraken_models.load_any(model_path)
            except Exception as e:
                sys.stderr.write(f'kraken_server: failed to load {model_path}: {e}\n')
                sys.stderr.flush()
                _rec_models[key] = None
        else:
            sys.stderr.write(f'kraken_server: model not found at {model_path}, trying download...\n')
            sys.stderr.flush()
            try:
                from kraken.repo import get_model
                get_model(model_name, MODEL_CACHE_DIR)
                _rec_models[key] = kraken_models.load_any(model_path)
            except Exception as e:
                sys.stderr.write(f'kraken_server: download failed for {model_name}: {e}\n')
                sys.stderr.flush()
                _rec_models[key] = None
    return _rec_models[key]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        path = req.get('path', '')
        lang = req.get('lang', 'en')
        if not os.path.exists(path):
            print(json.dumps({'error': f'file not found: {path}'}), flush=True)
            continue
        img = Image.open(path).convert('RGB')
        # Segment using blla
        seg = blla.segment(img)
        rec_model = get_rec_model(lang)
        if rec_model is None:
            print(json.dumps({'error': f'no recognition model available for lang: {lang}'}), flush=True)
            continue
        # Run recognition
        pred_it = rpred.rpred(rec_model, img, seg)
        words = []
        for record in pred_it:
            text = record.prediction.strip()
            if not text:
                continue
            # Extract bbox from cuts/baseline
            cuts = getattr(record, 'cuts', None)
            if cuts and len(cuts) > 0:
                xs = [pt[0] for cut in cuts for pt in cut]
                ys = [pt[1] for cut in cuts for pt in cut]
                x1, y1, x2, y2 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
            else:
                x1 = y1 = x2 = y2 = 0
            avg_conf = int(sum(getattr(record, 'confidences', [0.0])) / max(len(getattr(record, 'confidences', [1])), 1) * 100)
            words.append({'text': text, 'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'conf': avg_conf, 'source': 'kraken'})
        print(json.dumps({'words': words}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
