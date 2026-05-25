#!/usr/bin/env python3
"""Detect text column blocks via horizontal projection profiles.
Works on degraded newspaper scans where Tesseract layout analysis fails.
Returns JSON: [{x1,y1,x2,y2}, ...] in image pixel coordinates.

Usage: python3 detect_columns.py <image.png> [gutter_thresh=0.82] [min_col_width_px=40]
"""
import sys, json
import numpy as np
from PIL import Image

def detect_columns(png_path, gutter_thresh=0.82, min_col_width=40, min_block_height=60):
    img = Image.open(png_path).convert('L')
    arr = np.array(img, dtype=float) / 255.0  # 0=black(text), 1=white(background)
    h, w = arr.shape

    # Smooth column projection — fraction of white pixels per x column
    # Median-filter along x to reduce noise from individual dark pixels
    col_white = arr.mean(axis=0)
    window = max(3, w // 300)
    col_smooth = np.convolve(col_white, np.ones(window) / window, mode='same')

    # Gutter = columns where smoothed brightness exceeds threshold (mostly white)
    is_gutter = col_smooth >= gutter_thresh

    # Merge narrow gutter gaps (< 5px) to avoid splitting columns on isolated text
    for i in range(1, len(is_gutter) - 1):
        if not is_gutter[i] and is_gutter[i-1] and is_gutter[i+1]:
            is_gutter[i] = True

    # Find contiguous text-column spans
    col_spans = []
    in_text = False
    start = 0
    for x in range(w):
        if not is_gutter[x] and not in_text:
            in_text = True; start = x
        elif is_gutter[x] and in_text:
            in_text = False
            if x - start >= min_col_width:
                col_spans.append((start, x))
    if in_text and w - start >= min_col_width:
        col_spans.append((start, w))

    if not col_spans:
        return []

    # For each column span, find vertical text extent
    blocks = []
    for x1, x2 in col_spans:
        strip = arr[:, x1:x2]
        row_white = strip.mean(axis=1)
        text_rows = np.where(row_white < gutter_thresh)[0]
        if len(text_rows) < 2:
            continue
        y1, y2 = int(text_rows[0]), int(text_rows[-1])
        if y2 - y1 < min_block_height:
            continue
        blocks.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2})

    return blocks

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps([]))
        sys.exit(0)
    png_path = sys.argv[1]
    thresh = float(sys.argv[2]) if len(sys.argv) > 2 else 0.82
    min_w  = int(sys.argv[3])   if len(sys.argv) > 3 else 40
    result = detect_columns(png_path, gutter_thresh=thresh, min_col_width=min_w)
    print(json.dumps(result))
