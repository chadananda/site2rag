#!/tank/site2rag/ocr-venv/bin/python3
# Surya persistent server. Loads model once, processes requests from stdin.
# Protocol: one JSON line in {"path": "/tmp/page.png"} -> one JSON line out.
# Uses surya 0.17+ API: RecognitionPredictor(FoundationPredictor) + DetectionPredictor
import sys, json, os, traceback

sys.stderr.write('surya_server: loading models...\n')
sys.stderr.flush()

try:
    from PIL import Image
    from surya.recognition import RecognitionPredictor, FoundationPredictor
    from surya.detection import DetectionPredictor
    foundation_predictor = FoundationPredictor()
    rec_predictor = RecognitionPredictor(foundation_predictor)
    det_predictor = DetectionPredictor()
    sys.stderr.write('surya_server: ready\n')
    sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'surya_server: FATAL load error: {e}\n')
    sys.stderr.flush()
    sys.exit(1)

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
        img = Image.open(path).convert('RGB')
        preds = rec_predictor([img], det_predictor=det_predictor)
        lines_text = []
        for page_pred in preds:
            for line_pred in (getattr(page_pred, 'text_lines', None) or []):
                t = getattr(line_pred, 'text', '') or ''
                if t.strip():
                    lines_text.append(t)
        print(json.dumps({'text': ' '.join(lines_text)}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
