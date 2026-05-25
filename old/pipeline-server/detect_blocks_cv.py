#!/usr/bin/env python3
"""Detect text blocks via OpenCV morphological operations. Fast, CPU-only.
Works on images where Tesseract layout fails (unusual columns, degraded scans).
Runs on the preprocessed/enhanced image for best results.
Returns JSON: [{x1,y1,x2,y2}, ...]
Usage: python3 detect_blocks_cv.py <image.png> [--check]
"""
import sys, json
import numpy as np
import cv2

def detect_blocks(png_path, min_width=40, min_height=30):
    img = cv2.imread(png_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []
    h_img, w_img = img.shape

    # Binarize via Otsu — handles varying illumination across the scan
    _, binary = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Dilate horizontally: merge characters → words → lines
    kw = max(10, w_img // 40)
    dilated = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 1)))

    # Dilate vertically: merge lines → text blocks
    kh = max(3, h_img // 100)
    dilated = cv2.dilate(dilated, cv2.getStructuringElement(cv2.MORPH_RECT, (1, kh)))

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    blocks = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if w >= min_width and h >= min_height:
            blocks.append({'x1': x, 'y1': y, 'x2': x + w, 'y2': y + h})

    blocks.sort(key=lambda b: (b['y1'] // 50, b['x1']))
    return blocks

if __name__ == '__main__':
    if '--check' in sys.argv:
        print(json.dumps({'ok': True}))
        sys.exit(0)
    if len(sys.argv) < 2:
        print('[]')
        sys.exit(0)
    print(json.dumps(detect_blocks(sys.argv[1])))
