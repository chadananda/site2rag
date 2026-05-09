#!/usr/bin/env python3
"""EasyOCR batch wrapper. Usage: python3 easyocr_ocr.py [--check] <input_dir> <output_json> <langs>
langs: comma/plus-separated Tesseract codes (fra,eng or fra+eng)
Output JSON: {stem: {text, words: [{text,conf,x1,y1,x2,y2}]}}
--check: print 'ok' if easyocr is importable, 'missing' otherwise
"""
import sys, json, os, glob

TESS_TO_EASY = {
    'eng': 'en', 'fra': 'fr', 'deu': 'de', 'spa': 'es', 'ita': 'it',
    'por': 'pt', 'nld': 'nl', 'pol': 'pl', 'tur': 'tr', 'rus': 'ru',
    'ara': 'ar', 'fas': 'fa', 'heb': 'he', 'jpn': 'ja', 'kor': 'ko',
    'chi_sim': 'ch_sim', 'chi_tra': 'ch_tra',
}

def parse_langs(s):
    codes = []
    for part in s.replace(',', '+').split('+'):
        c = TESS_TO_EASY.get(part.strip())
        if c and c not in codes:
            codes.append(c)
    return codes or ['en']

if '--check' in sys.argv:
    try:
        import easyocr
        print('ok')
    except ImportError:
        print('missing')
    sys.exit(0)

try:
    import easyocr
except ImportError:
    print(json.dumps({'error': 'easyocr not installed — pip install easyocr'}))
    sys.exit(1)

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        print(json.dumps({'error': 'usage: easyocr_ocr.py <input_dir> <output_json> <langs>'}))
        sys.exit(1)
    input_dir, output_json, langs_str = args[0], args[1], args[2]
    langs = parse_langs(langs_str)
    pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
    results = {}
    if pngs:
        reader = easyocr.Reader(langs, gpu=False, verbose=False)
        for png in pngs:
            stem = os.path.splitext(os.path.basename(png))[0]
            try:
                dets = reader.readtext(png, detail=1)
                words = []
                for bbox, text, conf in dets:
                    xs, ys = [p[0] for p in bbox], [p[1] for p in bbox]
                    words.append({'text': text, 'conf': round(conf * 100),
                                  'x1': round(min(xs)), 'y1': round(min(ys)),
                                  'x2': round(max(xs)), 'y2': round(max(ys))})
                results[stem] = {'text': ' '.join(w['text'] for w in words), 'words': words}
            except Exception as e:
                results[stem] = {'text': '', 'words': [], 'error': str(e)}
    with open(output_json, 'w') as f:
        json.dump(results, f)
