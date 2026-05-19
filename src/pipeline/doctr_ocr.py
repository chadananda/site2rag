#!/usr/bin/env python3
"""docTR batch wrapper. Usage: python3 doctr_ocr.py [--check|--serve] <input_dir> <output_json> <langs>
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

import subprocess as _subprocess
def _device():
    """Detect best available device: mps > cuda > cpu."""
    try:
        import torch
        if torch.backends.mps.is_available():
            r = _subprocess.run(
                [sys.executable, '-c', 'import torch; a=torch.ones(4,device="mps"); print("ok")'],
                capture_output=True, timeout=10)
            if r.returncode == 0 and b'ok' in r.stdout:
                return 'mps'
        if torch.cuda.is_available():
            r = _subprocess.run(
                [sys.executable, '-c', 'import torch; a=torch.ones(4).cuda(); print("ok")'],
                capture_output=True, timeout=10)
            if r.returncode == 0 and b'ok' in r.stdout:
                return 'cuda'
    except Exception:
        pass
    return 'cpu'

_DEVICE = os.environ.get('DOCTR_DEVICE') or _device()

# Scripts docTR handles well; skip for others to avoid garbage output
SUPPORTED = {'eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol', 'tur', 'rus', 'chi_sim', 'chi_tra', 'jpn', 'kor'}

def is_supported(langs_str):
    for part in langs_str.replace(',', '+').split('+'):
        if part.strip() in SUPPORTED:
            return True
    return False

def run_batch(input_dir, output_json, langs_str, model=None):
    pngs = sorted(glob.glob(os.path.join(input_dir, '*.png')))
    results = {}
    if pngs and is_supported(langs_str):
        if model is None:
            model = ocr_predictor(pretrained=True)
            if _DEVICE in ('cuda', 'mps'):
                try:
                    import torch
                    model = model.to(_DEVICE)
                except Exception:
                    pass
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
                                geo = word.geometry
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

if '--serve' in sys.argv:
    # Persistent server mode: load model once, serve jobs from stdin.
    # Eliminates 30-60s cold-start on every invocation.
    model = ocr_predictor(pretrained=True)
    if _DEVICE in ('cuda', 'mps'):
        try:
            import torch
            model = model.to(_DEVICE)
        except Exception:
            pass
    print('ready', flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            run_batch(req['input_dir'], req['output_json'], req.get('langs', 'eng'), model)
            print(json.dumps({'ok': True}), flush=True)
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True)
    sys.exit(0)

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        print(json.dumps({'error': 'usage: doctr_ocr.py <input_dir> <output_json> <langs>'}))
        sys.exit(1)
    run_batch(args[0], args[1], args[2])
