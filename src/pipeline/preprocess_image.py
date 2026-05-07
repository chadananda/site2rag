#!/usr/bin/env python3
"""
Detect and fix contrast/bleed-through issues in scanned page images.
Usage: python3 preprocess_image.py <input.png> <output.png>
Outputs JSON to stdout: {"applied": [...], "contrast_score": 0.0-1.0, "bleed_detected": bool}
Exit 0 always. Output file written only if enhancement was applied.
"""
import sys, json, os
from PIL import Image, ImageEnhance, ImageOps, ImageFilter

def analyze(img):
    """Return contrast score (0=flat/bad, 1=full range) and bleed score."""
    gray = img.convert('L')
    hist = gray.histogram()  # 256 buckets
    total = sum(hist)
    if total == 0:
        return 0.0, 0.0

    # Find 1st/99th percentile pixel values
    cum, lo, hi = 0, 0, 255
    for i, h in enumerate(hist):
        cum += h
        if cum / total < 0.01:
            lo = i
        if cum / total < 0.99:
            hi = i

    contrast_range = (hi - lo) / 255.0  # 0=flat, 1=full dynamic range

    # Bleed-through: high mean with narrow range in light half.
    # Bleed shows up as mid-gray "noise" (values 150-220) coexisting with dark text (<80).
    light_pixels = sum(hist[150:220])
    dark_pixels = sum(hist[0:80])
    bleed_score = light_pixels / max(dark_pixels + light_pixels, 1)

    return contrast_range, bleed_score

def enhance_contrast(img):
    """Apply contrast stretch + optional bleed suppression. Returns list of variants."""
    variants = []

    # 1. Autocontrast — stretches histogram to full 0-255 range
    auto = ImageOps.autocontrast(img.convert('L'), cutoff=2).convert('RGB')
    variants.append(('autocontrast', auto))

    # 2. Autocontrast + moderate contrast boost (good for faded text)
    boosted = ImageEnhance.Contrast(auto).enhance(1.5)
    variants.append(('autocontrast+boost', boosted))

    # 3. Adaptive threshold variant — converts to pure B&W via Otsu-like approach.
    # Good for bleed-through: makes light mid-gray (bleed) white, keeps dark ink black.
    gray = img.convert('L')
    hist = gray.histogram()
    total = sum(hist)
    # Find Otsu threshold (maximize inter-class variance)
    best_thresh, best_var = 128, -1
    cum_n, cum_sum = 0, 0
    total_sum = sum(i * h for i, h in enumerate(hist))
    for t in range(256):
        cum_n += hist[t]
        cum_sum += t * hist[t]
        if cum_n == 0 or cum_n == total:
            continue
        w0, w1 = cum_n / total, (total - cum_n) / total
        mu0 = cum_sum / cum_n
        mu1 = (total_sum - cum_sum) / (total - cum_n)
        var = w0 * w1 * (mu0 - mu1) ** 2
        if var > best_var:
            best_var, best_thresh = var, t
    # Apply threshold with slight bias toward keeping more text (lower threshold = keep more ink)
    thresh = max(50, best_thresh - 15)
    bw = gray.point(lambda p: 0 if p < thresh else 255).convert('RGB')
    variants.append(('otsu_threshold', bw))

    return variants

def score_variant(label, img_path):
    """Quick quality proxy: mean pixel value of grayscale (higher=lighter=more white space=less noise)."""
    # We can't run Tesseract here, so use image statistics as proxy:
    # A good scan has mostly white background + crisp dark text → high mean + high stddev.
    img = Image.open(img_path).convert('L')
    hist = img.histogram()
    total = sum(hist)
    mean = sum(i * h for i, h in enumerate(hist)) / total
    # Variance
    var = sum((i - mean) ** 2 * h for i, h in enumerate(hist)) / total
    stddev = var ** 0.5
    # Score: want high mean (white background) + high stddev (sharp contrast)
    # Normalize: mean/255 * stddev/128 → 0 to ~1
    return (mean / 255.0) * min(stddev / 80.0, 1.0)

def main():
    args = sys.argv[1:]
    force = '--force' in args
    args = [a for a in args if a != '--force']
    method = None
    if '--method' in args:
        idx = args.index('--method')
        method = args[idx+1] if idx+1 < len(args) else None
        args = args[:idx] + args[idx+2:]

    if len(args) < 2:
        print(json.dumps({"error": "usage: preprocess_image.py [--force] [--method otsu|autocontrast] input.png output.png"}))
        sys.exit(1)

    in_path, out_path = args[0], args[1]
    if not os.path.exists(in_path):
        print(json.dumps({"error": f"input not found: {in_path}"}))
        sys.exit(0)

    try:
        img = Image.open(in_path).convert('RGB')
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(0)

    contrast_range, bleed_score = analyze(img)
    needs_contrast = contrast_range < 0.6
    needs_bleed_fix = bleed_score > 0.3

    result = {
        "contrast_range": round(contrast_range, 3),
        "bleed_score": round(bleed_score, 3),
        "bleed_detected": needs_bleed_fix,
        "applied": [],
        "enhanced": False,
    }

    if not force and not needs_contrast and not needs_bleed_fix:
        # Image is fine — no output file written
        print(json.dumps(result))
        return

    # Generate enhancement variants and pick the best by image score
    all_variants = enhance_contrast(img)
    # Filter to requested method if specified
    if method:
        variants = [(l, v) for l, v in all_variants if method in l] or all_variants
    else:
        variants = all_variants
    best_label, best_img, best_score = None, None, -1

    for label, v_img in variants:
        tmp_path = out_path + f".{label}.tmp.png"
        try:
            v_img.save(tmp_path, 'PNG')
            s = score_variant(label, tmp_path)
            if s > best_score:
                best_score, best_label, best_img = s, label, v_img
        except Exception:
            pass
        finally:
            try: os.unlink(tmp_path)
            except: pass

    # Also score original for comparison
    orig_score = score_variant('original', in_path)

    if best_img is not None and best_score > orig_score * 1.05:
        # Enhancement is meaningfully better (>5% improvement)
        best_img.save(out_path, 'PNG')
        result["applied"] = [best_label]
        result["enhanced"] = True
        result["score_improvement"] = round(best_score - orig_score, 3)
    else:
        result["applied"] = []
        result["enhanced"] = False

    print(json.dumps(result))

if __name__ == '__main__':
    main()
