#!/usr/bin/env python3
"""docTR batch wrapper. Usage: python3 doctr_ocr.py [--check] <input_dir> <output_json> <langs>
Output JSON: {stem: {text, words: [{text,conf,x1,y1,x2,y2}]}}
Supports Latin scripts well; no Arabic/CJK.
"""
import sys, json, os, glob

if '--check' in sys.argv:
    try:
        from doctr.io import DocumentFile
        from doctr.models import ocr_predictor
        print('ok')
    except ImportError:
        print('missing')
    sys.exit(0)

try:
    from doctr.io import DocumentFile
    from doctr.models import ocr_predictor
except ImportError:
    print(json.dumps({'error': 'doctr not installed — pip install python-doctr'}))
    sys.exit(1)

# Scripts docTR handles well; skip for others to avoid garbage output
SUPPORTED = {'eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol', 'tur', 'rus', 'chi_sim', 'chi_tra', 'jpn', 'kor'}

def is_supported(langs_str):
    for part in langs_str.replace(',', '+').split('+'):
        if part.strip() in SUPPORTED:
            return True
    return False

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        print(json.dumps({'error': 'usage: doctr_ocr.py <input_dir> <output_json> <langs>'}))
        sys.exit(1)
    input_dir, output_json, langs_str = args[0], args[1], args[2]
    pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
    results = {}
    if pngs and is_supported(langs_str):
        model = ocr_predictor(pretrained=True)
        for png in pngs:
            stem = os.path.splitext(os.path.basename(png))[0]
            try:
                doc = DocumentFile.from_images(png)
                result = model(doc)
                words = []
                for page in result.pages:
                    h, w = page.dimensions
                    for block in page.blocks:
                        for line in block.lines:
                            for word in line.words:
                                geo = word.geometry  # [[x1_norm,y1_norm],[x2_norm,y2_norm]]
                                words.append({
                                    'text': word.value,
                                    'conf': round(word.confidence * 100),
                                    'x1': round(geo[0][0] * w), 'y1': round(geo[0][1] * h),
                                    'x2': round(geo[1][0] * w), 'y2': round(geo[1][1] * h),
                                })
                results[stem] = {'text': ' '.join(w['text'] for w in words), 'words': words}
            except Exception as e:
                results[stem] = {'text': '', 'words': [], 'error': str(e)}
    with open(output_json, 'w') as f:
        json.dump(results, f)
