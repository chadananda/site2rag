#!/tank/site2rag/ocr-venv/bin/python3
"""Image preprocessing server. One JSON request in → one JSON response out.
Ops: deskew, despeckle, adaptive_threshold, normalize_contrast, denoise_nlmeans,
     sharpen, binarize_sauvola, remove_background, invert, upscale_2x
"""
import sys, json, os, traceback
import numpy as np

sys.stderr.write('preprocess_server: loading deps...\n')
sys.stderr.flush()

try:
    import cv2
    from PIL import Image
    from skimage import filters, transform, feature, restoration, morphology, util
    sys.stderr.write('preprocess_server: ready\n')
    sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'preprocess_server: FATAL load error: {e}\n')
    sys.stderr.flush()
    sys.exit(1)

def out_path(path, op):
    base = path[:-4] if path.endswith('.png') else path
    return f'{base}_{op}.png'

def load_cv2(path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f'Cannot load image: {path}')
    return img

def save_cv2(img, path):
    cv2.imwrite(path, img)
    return path

def op_deskew(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f'Cannot load: {path}')
    edges = feature.canny(img.astype(np.float32) / 255.0, sigma=2.0)
    h, theta, d = transform.hough_line(edges)
    angles = []
    _, angles_peak, _ = transform.hough_line_peaks(h, theta, d, num_peaks=20, threshold=0.3 * h.max())
    for angle in angles_peak:
        deg = np.degrees(angle)
        if abs(deg) < 45:
            angles.append(deg)
        elif deg > 45:
            angles.append(deg - 90)
        else:
            angles.append(deg + 90)
    if not angles:
        import shutil; shutil.copy(path, out_path(path, 'deskew')); return out_path(path, 'deskew')
    median_angle = float(np.median(angles))
    rotated = transform.rotate(img.astype(np.float32) / 255.0, median_angle, resize=True, cval=1.0)
    result = (rotated * 255).astype(np.uint8)
    op = 'deskew'
    dest = out_path(path, op)
    cv2.imwrite(dest, result)
    return dest

def op_despeckle(path):
    img = load_cv2(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    opened = cv2.morphologyEx(gray, cv2.MORPH_OPEN, kernel)
    dest = out_path(path, 'despeckle')
    cv2.imwrite(dest, opened)
    return dest

def op_adaptive_threshold(path):
    img = load_cv2(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    result = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 10)
    dest = out_path(path, 'adaptive_threshold')
    cv2.imwrite(dest, result)
    return dest

def op_normalize_contrast(path):
    img = load_cv2(path)
    if len(img.shape) == 3:
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l_eq = clahe.apply(l)
        result = cv2.cvtColor(cv2.merge([l_eq, a, b]), cv2.COLOR_LAB2BGR)
    else:
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        result = clahe.apply(img)
    dest = out_path(path, 'normalize_contrast')
    cv2.imwrite(dest, result)
    return dest

def op_denoise_nlmeans(path):
    img = load_cv2(path)
    if len(img.shape) == 3:
        result = cv2.fastNlMeansDenoisingColored(img, None, h=10, hColor=10, templateWindowSize=7, searchWindowSize=21)
    else:
        result = cv2.fastNlMeansDenoising(img, None, h=10, templateWindowSize=7, searchWindowSize=21)
    dest = out_path(path, 'denoise_nlmeans')
    cv2.imwrite(dest, result)
    return dest

def op_sharpen(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f'Cannot load: {path}')
    arr = img.astype(np.float32) / 255.0
    from skimage.filters import unsharp_mask
    sharpened = unsharp_mask(arr, radius=1.5, amount=1.5)
    result = (np.clip(sharpened, 0, 1) * 255).astype(np.uint8)
    dest = out_path(path, 'sharpen')
    cv2.imwrite(dest, result)
    return dest

def op_binarize_sauvola(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f'Cannot load: {path}')
    arr = img.astype(np.float32) / 255.0
    thresh = filters.threshold_sauvola(arr, window_size=25)
    binary = (arr > thresh).astype(np.uint8) * 255
    dest = out_path(path, 'binarize_sauvola')
    cv2.imwrite(dest, binary)
    return dest

def op_remove_background(path):
    img = load_cv2(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    cleaned = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, kernel, iterations=2)
    dest = out_path(path, 'remove_background')
    cv2.imwrite(dest, cleaned)
    return dest

def op_invert(path):
    img = load_cv2(path)
    result = cv2.bitwise_not(img)
    dest = out_path(path, 'invert')
    cv2.imwrite(dest, result)
    return dest

def op_upscale_2x(path):
    img = load_cv2(path)
    h, w = img.shape[:2]
    result = cv2.resize(img, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)
    dest = out_path(path, 'upscale_2x')
    cv2.imwrite(dest, result)
    return dest

def op_extreme_binarize(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f'Cannot load: {path}')
    _, result = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dest = out_path(path, 'extreme_binarize')
    cv2.imwrite(dest, result)
    return dest

def op_aggressive_denoise(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f'Cannot load: {path}')
    denoised = cv2.fastNlMeansDenoising(img, None, h=20, templateWindowSize=7, searchWindowSize=21)
    result = cv2.medianBlur(denoised, 3)
    dest = out_path(path, 'aggressive_denoise')
    cv2.imwrite(dest, result)
    return dest

OPS = {
    'deskew': op_deskew,
    'despeckle': op_despeckle,
    'adaptive_threshold': op_adaptive_threshold,
    'normalize_contrast': op_normalize_contrast,
    'denoise_nlmeans': op_denoise_nlmeans,
    'sharpen': op_sharpen,
    'binarize_sauvola': op_binarize_sauvola,
    'remove_background': op_remove_background,
    'invert': op_invert,
    'upscale_2x': op_upscale_2x,
    'extreme_binarize': op_extreme_binarize,
    'aggressive_denoise': op_aggressive_denoise,
}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        op = req.get('op', '')
        path = req.get('path', '')
        if not os.path.exists(path):
            print(json.dumps({'error': f'file not found: {path}'}), flush=True)
            continue
        if op not in OPS:
            print(json.dumps({'error': f'unknown op: {op}'}), flush=True)
            continue
        out = OPS[op](path)
        print(json.dumps({'out_path': out}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)


