#!/usr/bin/env python3
"""Surya OCR runner. Takes PNG path, outputs JSON words array.
Usage: python surya_runner.py <png_path> [--lang en]
Output: JSON array of {text, conf, x1, y1, x2, y2, source}
"""
import sys, json, os

png_path = sys.argv[1] if len(sys.argv) > 1 else None
lang = 'en'
for i, a in enumerate(sys.argv):
    if a == '--lang' and i+1 < len(sys.argv):
        lang = sys.argv[i+1]

if not png_path or not os.path.exists(png_path):
    print(json.dumps({"error": f"file not found: {png_path}"}))
    sys.exit(1)

try:
    from PIL import Image
    from surya.ocr import run_ocr
    from surya.model.detection.model import load_model as load_det_model, load_processor as load_det_processor
    from surya.model.recognition.model import load_model as load_rec_model
    from surya.model.recognition.processor import load_processor as load_rec_processor

    img = Image.open(png_path).convert('RGB')

    det_model = load_det_model()
    det_processor = load_det_processor()
    rec_model = load_rec_model()
    rec_processor = load_rec_processor()

    results = run_ocr([img], [[lang]], det_model, det_processor, rec_model, rec_processor)

    words = []
    for page in results:
        for line in page.text_lines:
            text = line.text.strip()
            if not text:
                continue
            b = line.bbox  # [x1, y1, x2, y2]
            conf = int((line.confidence or 0) * 100)
            words.append({
                "text": text,
                "conf": conf,
                "x1": int(b[0]), "y1": int(b[1]),
                "x2": int(b[2]), "y2": int(b[3]),
                "source": "surya"
            })

    print(json.dumps(words))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
