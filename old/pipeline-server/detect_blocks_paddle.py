#!/usr/bin/env python3
"""PaddleOCR text region detection — detection pass only, no recognition.
Runs on the preprocessed/enhanced image. Groups detected text lines into
column blocks by vertical proximity.
Returns JSON: [{x1,y1,x2,y2}, ...]
Usage: python3 detect_blocks_paddle.py <image.png> [--check]
"""
import sys, json

def detect_blocks(png_path, merge_gap=20, min_width=40, min_height=20):
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang='en', show_log=False, use_gpu=False)
    result = ocr.ocr(png_path, det=True, rec=False, cls=False)

    if not result or not result[0]:
        return []

    # result[0]: list of quads [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
    lines = []
    for quad in result[0]:
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        x1, y1, x2, y2 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
        if x2 - x1 >= 10 and y2 - y1 >= 5:
            lines.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2})

    if not lines:
        return []

    # Merge vertically proximate lines into blocks
    lines.sort(key=lambda b: b['y1'])
    blocks, current = [], dict(lines[0])
    for line in lines[1:]:
        if line['y1'] <= current['y2'] + merge_gap:
            current['x1'] = min(current['x1'], line['x1'])
            current['y1'] = min(current['y1'], line['y1'])
            current['x2'] = max(current['x2'], line['x2'])
            current['y2'] = max(current['y2'], line['y2'])
        else:
            if current['x2'] - current['x1'] >= min_width and current['y2'] - current['y1'] >= min_height:
                blocks.append(current)
            current = dict(line)
    if current['x2'] - current['x1'] >= min_width and current['y2'] - current['y1'] >= min_height:
        blocks.append(current)

    return blocks

if __name__ == '__main__':
    if '--check' in sys.argv:
        try:
            from paddleocr import PaddleOCR
            print(json.dumps({'ok': True}))
        except ImportError as e:
            print(json.dumps({'ok': False, 'error': str(e)}))
            sys.exit(1)
        sys.exit(0)
    if len(sys.argv) < 2:
        print('[]')
        sys.exit(0)
    print(json.dumps(detect_blocks(sys.argv[1])))
