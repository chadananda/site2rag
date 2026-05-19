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

CJK_CODES = {'ch_sim', 'ch_tra', 'ja', 'ko'}

def parse_langs(s):
    codes = []
    for part in s.replace(',', '+').split('+'):
        c = TESS_TO_EASY.get(part.strip())
        if c and c not in codes:
            codes.append(c)
    if not codes:
        return ['en']
    # CJK models require 'en' as co-language in EasyOCR
    if any(c in CJK_CODES for c in codes) and 'en' not in codes:
        codes.append('en')
    return codes

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

import subprocess as _subprocess

def _gpu_works():
    """Return True only if GPU matrix ops succeed (rocBLAS/CUDA actually functional)."""
    try:
        r = _subprocess.run(
            [sys.executable, '-c',
             'import torch; a=torch.ones(32,32).cuda(); b=torch.matmul(a,a); print("ok")'],
            capture_output=True, timeout=15,
        )
        return r.returncode == 0 and b'ok' in r.stdout
    except Exception:
        return False

def _mps_works():
    """Return True only if MPS (Apple Metal) is available and functional."""
    try:
        r = _subprocess.run(
            [sys.executable, '-c',
             'import torch; a=torch.ones(32,32,device="mps"); b=torch.matmul(a,a); print("ok")'],
            capture_output=True, timeout=15,
        )
        return r.returncode == 0 and b'ok' in r.stdout
    except Exception:
        return False

try:
    import torch as _torch
    if _torch.backends.mps.is_available() and _mps_works():
        _GPU = True   # EasyOCR gpu=True auto-selects MPS on Apple Silicon
    elif _torch.cuda.is_available() and _gpu_works():
        _GPU = True
    else:
        _GPU = False
except ImportError:
    _GPU = False

def run_batch(input_dir, output_json, langs_str):
    langs = parse_langs(langs_str)
    pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
    results = {}
    if pngs:
        reader = easyocr.Reader(langs, gpu=_GPU, verbose=False)
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

if '--serve' in sys.argv:
    # Persistent server mode: read JSON jobs from stdin, write {"ok":true} or {"error":...} to stdout.
    # Model loads are cached per lang set — eliminates cold-start on subsequent calls.
    _readers = {}
    print('ready', flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            input_dir = req['input_dir']
            output_json = req['output_json']
            langs_str = req.get('langs', 'eng')
            langs = parse_langs(langs_str)
            lang_key = ','.join(sorted(langs))
            if lang_key not in _readers:
                _readers[lang_key] = easyocr.Reader(langs, gpu=_GPU, verbose=False)
            reader = _readers[lang_key]
            pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
            results = {}
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
            print(json.dumps({'ok': True}), flush=True)
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True)
    sys.exit(0)

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        print(json.dumps({'error': 'usage: easyocr_ocr.py <input_dir> <output_json> <langs>'}))
        sys.exit(1)
    run_batch(args[0], args[1], args[2])
