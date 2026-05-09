#!/usr/bin/env python3
"""PaddleOCR batch wrapper. Supports PaddleOCR 2.x and 3.x APIs.
Usage: python3 paddle_ocr.py [--check] <input_dir> <output_json> <langs>
Output JSON: {stem: {text, words: [{text,conf,x1,y1,x2,y2}]}}
"""
import sys, json, os, glob

TESS_TO_PADDLE = {
    'eng': 'en', 'fra': 'fr', 'deu': 'german', 'spa': 'es', 'ita': 'it',
    'por': 'pt', 'nld': 'nl', 'pol': 'pl', 'tur': 'tr', 'rus': 'ru',
    'ara': 'arabic', 'fas': 'arabic',  # Persian uses Arabic OCR model in Paddle
    'chi_sim': 'ch', 'chi_tra': 'chinese_cht',
    'jpn': 'japan', 'kor': 'korean',
}

def primary_lang(s):
    for part in s.replace(',', '+').split('+'):
        c = TESS_TO_PADDLE.get(part.strip())
        if c: return c
    return 'en'

def make_ocr_v2(paddle_lang):
    """PaddleOCR 2.x API. angle_cls=False: avoids a buggy cls model on some paddle builds."""
    from paddleocr import PaddleOCR
    return PaddleOCR(use_angle_cls=False, lang=paddle_lang, use_gpu=False, show_log=False), 'v2'

def make_ocr_v3(paddle_lang):
    """PaddleOCR 3.x API — lang and use_gpu params removed."""
    from paddleocr import PaddleOCR
    # 3.x only supports 'en' and 'ch' natively; others fall back to default multilingual
    safe_lang = paddle_lang if paddle_lang in ('en', 'ch', 'chinese_cht') else 'en'
    return PaddleOCR(lang=safe_lang), 'v3'

def make_ocr(paddle_lang):
    """Try 2.x API first (most compatible), fall back to 3.x."""
    try:
        return make_ocr_v2(paddle_lang)
    except (TypeError, ValueError):
        return make_ocr_v3(paddle_lang)

def run_ocr_v2(ocr, png):
    dets = ocr.ocr(png, cls=False)
    words = []
    if dets and dets[0]:
        for line in dets[0]:
            bbox, (text, conf) = line
            xs, ys = [p[0] for p in bbox], [p[1] for p in bbox]
            words.append({'text': text, 'conf': round(conf * 100),
                          'x1': round(min(xs)), 'y1': round(min(ys)),
                          'x2': round(max(xs)), 'y2': round(max(ys))})
    return words

def run_ocr_v3(ocr, png):
    results = list(ocr.predict(png))
    words = []
    for res in results:
        if not res: continue
        boxes = res.get('dt_boxes', [])
        texts = res.get('rec_text', [])
        scores = res.get('rec_score', [])
        for box, text, conf in zip(boxes, texts, scores):
            if not text: continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            words.append({'text': text, 'conf': round(float(conf) * 100),
                          'x1': round(min(xs)), 'y1': round(min(ys)),
                          'x2': round(max(xs)), 'y2': round(max(ys))})
    return words

if '--check' in sys.argv:
    try:
        from paddleocr import PaddleOCR
        import paddleocr
        ver = getattr(paddleocr, '__version__', '?')
        print('ok')
    except ImportError:
        print('missing')
    sys.exit(0)

try:
    from paddleocr import PaddleOCR
except ImportError:
    print(json.dumps({'error': 'paddleocr not installed — pip install paddleocr'}))
    sys.exit(1)

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        print(json.dumps({'error': 'usage: paddle_ocr.py <input_dir> <output_json> <langs>'}))
        sys.exit(1)
    input_dir, output_json, langs_str = args[0], args[1], args[2]
    paddle_lang = primary_lang(langs_str)
    pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
    results = {}
    if pngs:
        try:
            ocr, api_ver = make_ocr(paddle_lang)
            run_fn = run_ocr_v2 if api_ver == 'v2' else run_ocr_v3
        except Exception as e:
            results['_error'] = str(e)
            pngs = []  # skip processing
        for png in pngs:
            stem = os.path.splitext(os.path.basename(png))[0]
            try:
                words = run_fn(ocr, png)
                results[stem] = {'text': ' '.join(w['text'] for w in words), 'words': words}
            except Exception as e:
                results[stem] = {'text': '', 'words': [], 'error': str(e)}
    with open(output_json, 'w') as f:
        json.dump(results, f)
