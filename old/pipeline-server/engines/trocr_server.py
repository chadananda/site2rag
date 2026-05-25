#!/tank/site2rag/ocr-venv/bin/python3
"""TrOCR persistent server. Handwritten + printed text recognition.
Protocol: {"path": "...", "lang": "en", "mode": "handwritten|printed"} → {"text": "..."}
Models: microsoft/trocr-large-handwritten, microsoft/trocr-large-printed
"""
import sys, json, os, traceback
from PIL import Image

sys.stderr.write('trocr_server: loading models...\n'); sys.stderr.flush()
try:
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel
    # Load handwritten model by default (most useful for archival)
    MODEL_HW = 'microsoft/trocr-large-handwritten'
    MODEL_PR = 'microsoft/trocr-base-printed'
    processors = {}
    models = {}
    def get_model(mode='handwritten'):
        key = 'hw' if mode == 'handwritten' else 'pr'
        model_id = MODEL_HW if key == 'hw' else MODEL_PR
        if key not in models:
            processors[key] = TrOCRProcessor.from_pretrained(model_id)
            models[key] = VisionEncoderDecoderModel.from_pretrained(model_id)
        return processors[key], models[key]
    sys.stderr.write('trocr_server: ready (lazy load)\n'); sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'trocr_server: FATAL: {e}\n'); sys.exit(1)

import torch

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        req = json.loads(line)
        path = req.get('path', '')
        mode = req.get('mode', 'handwritten')
        if not os.path.exists(path):
            print(json.dumps({'error': f'file not found: {path}'}), flush=True); continue
        processor, model = get_model(mode)
        img = Image.open(path).convert('RGB')
        pixel_values = processor(images=img, return_tensors='pt').pixel_values
        with torch.no_grad():
            generated_ids = model.generate(pixel_values)
        text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        print(json.dumps({'text': text}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
