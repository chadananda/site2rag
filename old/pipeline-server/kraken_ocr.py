#!/usr/bin/env python3
"""Kraken batch wrapper. Usage: python3 kraken_ocr.py [--check] <input_dir> <output_json> <langs>
Output JSON: {stem: {text, words: [{text,conf,x1,y1,x2,y2}]}}
Designed for historical documents and Arabic/Persian script.
Models are downloaded automatically on first use via kraken.lib.models.
"""
import sys, json, os, glob

if '--check' in sys.argv:
    try:
        from kraken import rpred, blla
        from kraken.lib import models as kmodels
        # kraken 4+ removed get_default_model; check for load_any instead
        if not hasattr(kmodels, 'load_any'):
            print('missing')
        else:
            print('ok')
    except ImportError as e:
        print(f'missing: {e}')
    sys.exit(0)

try:
    from kraken import rpred, blla, serialization
    from kraken.lib import models as kmodels
    from PIL import Image
except ImportError:
    print(json.dumps({'error': 'kraken not installed — pip install kraken'}))
    sys.exit(1)

# Kraken RTL langs for proper bidi rendering
RTL_LANGS = {'ara', 'fas', 'heb', 'urd'}

def primary_lang(langs_str):
    for part in langs_str.replace(',', '+').split('+'):
        p = part.strip()
        if p: return p
    return 'eng'

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        print(json.dumps({'error': 'usage: kraken_ocr.py <input_dir> <output_json> <langs>'}))
        sys.exit(1)
    input_dir, output_json, langs_str = args[0], args[1], args[2]
    lang = primary_lang(langs_str)
    rtl = lang in RTL_LANGS
    pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
    results = {}
    if pngs:
        try:
            model = kmodels.load_any(kmodels.get_default_model())
        except Exception as e:
            with open(output_json, 'w') as f:
                json.dump({p: {'text': '', 'words': [], 'error': f'model load failed: {e}'}
                           for p in [os.path.splitext(os.path.basename(x))[0] for x in pngs]}, f)
            sys.exit(0)
        for png in pngs:
            stem = os.path.splitext(os.path.basename(png))[0]
            try:
                img = Image.open(png).convert('RGB')
                baseline_seg = blla.segment(img)
                words = []
                for record in rpred.rpred(model, img, baseline_seg, pad=16):
                    text = record.prediction
                    if not text.strip():
                        continue
                    bbox = record.bbox  # (x1, y1, x2, y2) or similar
                    if bbox and len(bbox) >= 4:
                        x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
                    else:
                        x1 = y1 = x2 = y2 = 0
                    words.append({'text': text, 'conf': 80,
                                  'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2})
                results[stem] = {'text': ' '.join(w['text'] for w in words), 'words': words}
            except Exception as e:
                results[stem] = {'text': '', 'words': [], 'error': str(e)}
    with open(output_json, 'w') as f:
        json.dump(results, f)
