#!/tank/site2rag/ocr-venv/bin/python3
"""PaddleOCR persistent server. Loads model once, processes requests from stdin.
Protocol: one JSON line in {"path": "/tmp/page.png", "lang": "ar"} → one JSON line out.
"""
import sys, json, os, traceback

LANG_MAP = {
    'ar': 'arabic', 'ara': 'arabic',
    'fa': 'arabic', 'fas': 'arabic', 'per': 'arabic',
    'fr': 'french', 'fra': 'french',
    'en': 'en', 'eng': 'en',
}

ocrs = {}

def get_ocr(lang):
    paddle_lang = LANG_MAP.get(lang, 'en')
    if paddle_lang not in ocrs:
        from paddleocr import PaddleOCR
        ocrs[paddle_lang] = PaddleOCR(use_angle_cls=True, lang=paddle_lang, show_log=False)
    return ocrs[paddle_lang]

sys.stderr.write('paddleocr_server: ready\n')
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
        ocr = get_ocr(lang)
        result = ocr.ocr(path, cls=True)
        words = []
        if result and result[0]:
            for line_data in result[0]:
                if not line_data:
                    continue
                bbox_pts, (text, conf) = line_data
                text = text.strip()
                if not text:
                    continue
                xs = [p[0] for p in bbox_pts]
                ys = [p[1] for p in bbox_pts]
                words.append({
                    'text': text, 'conf': int(conf * 100),
                    'x1': int(min(xs)), 'y1': int(min(ys)),
                    'x2': int(max(xs)), 'y2': int(max(ys)),
                    'source': 'paddleocr'
                })
        print(json.dumps({'words': words}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
