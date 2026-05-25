#!/usr/bin/env python3
"""PaddleOCR runner. Takes PNG path, outputs JSON words array.
Usage: python paddleocr_runner.py <png_path> [--lang en]
Output: JSON array of {text, conf, x1, y1, x2, y2, source}
"""
import sys, json, os

png_path = sys.argv[1] if len(sys.argv) > 1 else None
lang = 'en'
for i, a in enumerate(sys.argv):
    if a == '--lang' and i+1 < len(sys.argv):
        lang = sys.argv[i+1]

LANG_MAP = {
    'en': 'en', 'eng': 'en',
    'ar': 'ar', 'ara': 'ar',
    'fa': 'ar', 'fas': 'ar',  # PaddleOCR uses 'ar' for both Arabic and Persian
    'fr': 'fr', 'fra': 'fr',
}
ocr_lang = LANG_MAP.get(lang, 'en')

if not png_path or not os.path.exists(png_path):
    print(json.dumps({"error": f"file not found: {png_path}"}))
    sys.exit(1)

try:
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=True, lang=ocr_lang, show_log=False)
    results = ocr.ocr(png_path, cls=True)

    words = []
    if results and results[0]:
        for line in results[0]:
            bbox_pts, (text, conf) = line
            text = text.strip()
            if not text:
                continue
            xs = [p[0] for p in bbox_pts]
            ys = [p[1] for p in bbox_pts]
            words.append({
                "text": text,
                "conf": int(conf * 100),
                "x1": int(min(xs)), "y1": int(min(ys)),
                "x2": int(max(xs)), "y2": int(max(ys)),
                "source": "paddle"
            })

    print(json.dumps(words))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
