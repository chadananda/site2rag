#!/usr/bin/env python3
"""EasyOCR runner. Takes PNG path, outputs JSON words array.
Usage: python easyocr_runner.py <png_path> [--lang en]
Output: JSON array of {text, conf, x1, y1, x2, y2, source}
"""
import sys, json, os

png_path = sys.argv[1] if len(sys.argv) > 1 else None
lang = 'en'
for i, a in enumerate(sys.argv):
    if a == '--lang' and i+1 < len(sys.argv):
        lang = sys.argv[i+1]

# Map common lang codes to EasyOCR codes
LANG_MAP = {
    'en': ['en'], 'eng': ['en'],
    'fr': ['fr'], 'fra': ['fr'],
    'ar': ['ar'], 'ara': ['ar'],
    'fa': ['fa'], 'fas': ['fa'], 'per': ['fa'],
}
ocr_langs = LANG_MAP.get(lang, [lang, 'en'])

if not png_path or not os.path.exists(png_path):
    print(json.dumps({"error": f"file not found: {png_path}"}))
    sys.exit(1)

try:
    import easyocr
    reader = easyocr.Reader(ocr_langs, gpu=False, verbose=False)
    results = reader.readtext(png_path, detail=1)

    words = []
    for bbox_pts, text, conf in results:
        text = text.strip()
        if not text:
            continue
        # bbox_pts: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]] (4 corners)
        xs = [p[0] for p in bbox_pts]
        ys = [p[1] for p in bbox_pts]
        words.append({
            "text": text,
            "conf": int(conf * 100),
            "x1": int(min(xs)), "y1": int(min(ys)),
            "x2": int(max(xs)), "y2": int(max(ys)),
            "source": "easyocr"
        })

    print(json.dumps(words))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
