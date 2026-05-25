#!/tank/site2rag/ocr-venv/bin/python3
"""docTR persistent server. Protocol: {"path": "...", "lang": "en"} → {"words": [...], "layout": {...}}
Strong on layout detection and reading order. Returns structured block/line/word hierarchy.
"""
import sys, json, os, traceback

sys.stderr.write('doctr_server: loading model...\n')
sys.stderr.flush()

try:
    from doctr.models import ocr_predictor
    from doctr.io import DocumentFile
    predictor = ocr_predictor(pretrained=True)
    sys.stderr.write('doctr_server: ready\n')
    sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'doctr_server: FATAL load error: {e}\n')
    sys.stderr.flush()
    sys.exit(1)

def extract_words_and_layout(result):
    """Extract flat word list and structured layout from docTR result."""
    words = []
    layout = {'pages': []}
    for page_idx, page in enumerate(result.pages):
        page_layout = {'blocks': [], 'dimensions': page.dimensions}
        h, w = page.dimensions
        for block_idx, block in enumerate(page.blocks):
            block_layout = {'lines': [], 'geometry': block.geometry}
            for line_idx, line in enumerate(block.lines):
                line_layout = {'words': [], 'geometry': line.geometry}
                for word in line.words:
                    text = word.value.strip()
                    if not text:
                        continue
                    # Convert normalized geometry to pixel coords
                    (x0n, y0n), (x1n, y1n) = word.geometry
                    x1p, y1p = int(x0n * w), int(y0n * h)
                    x2p, y2p = int(x1n * w), int(y1n * h)
                    conf = int(word.confidence * 100)
                    word_obj = {
                        'text': text,
                        'x1': x1p, 'y1': y1p, 'x2': x2p, 'y2': y2p,
                        'conf': conf,
                        'source': 'doctr',
                        'block': block_idx,
                        'line': line_idx,
                        'page': page_idx,
                    }
                    words.append(word_obj)
                    line_layout['words'].append({'text': text, 'geometry': word.geometry, 'conf': conf})
                block_layout['lines'].append(line_layout)
            page_layout['blocks'].append(block_layout)
        layout['pages'].append(page_layout)
    return words, layout

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        path = req.get('path', '')
        if not os.path.exists(path):
            print(json.dumps({'error': f'file not found: {path}'}), flush=True)
            continue
        doc = DocumentFile.from_images([path])
        result = predictor(doc)
        words, layout = extract_words_and_layout(result)
        print(json.dumps({'words': words, 'layout': layout}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
