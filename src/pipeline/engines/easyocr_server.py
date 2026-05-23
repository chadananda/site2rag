#!/tank/site2rag/ocr-venv/bin/python3
"""EasyOCR persistent server. Loads model once, processes requests from stdin.
Protocol: one JSON line in {"path": "/tmp/page.png", "lang": "ar"} → one JSON line out.
Start: python3 easyocr_server.py
Stop: close stdin (EOF)
"""
import sys, json, os, traceback

LANG_MAP = {
    'en': ['en'], 'eng': ['en'],
    'fr': ['fr'], 'fra': ['fr'],
    'ar': ['ar'], 'ara': ['ar'],
    'fa': ['fa'], 'fas': ['fa'], 'per': ['fa'],
}

readers = {}

def get_reader(lang):
    langs = LANG_MAP.get(lang, [lang, 'en'])
    key = '+'.join(sorted(langs))
    if key not in readers:
        import easyocr
        readers[key] = easyocr.Reader(langs, gpu=False, verbose=False)
    return readers[key]

sys.stderr.write('easyocr_server: ready\n')
sys.stderr.flush()

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
        reader = get_reader(lang)
        results = reader.readtext(path, detail=1)
        words = []
        for bbox_pts, text, conf in results:
            text = text.strip()
            if not text:
                continue
            xs = [p[0] for p in bbox_pts]
            ys = [p[1] for p in bbox_pts]
            words.append({
                'text': text, 'conf': int(conf * 100),
                'x1': int(min(xs)), 'y1': int(min(ys)),
                'x2': int(max(xs)), 'y2': int(max(ys)),
                'source': 'easyocr'
            })
        print(json.dumps({'words': words}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
