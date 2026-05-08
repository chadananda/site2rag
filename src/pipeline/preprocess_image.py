#!/usr/bin/env python3
"""
Detect and fix contrast/bleed-through issues in scanned page images.
Usage: python3 preprocess_image.py [--force] [--issues bleed_through,low_contrast] [--method otsu|autocontrast] <input.png> <output.png>
Outputs JSON to stdout: {"applied": [...], "contrast_score": 0.0-1.0, "bleed_detected": bool}
Exit 0 always. Output file written only if enhancement was applied.
"""
import sys, json, os
from PIL import Image, ImageEnhance, ImageOps, ImageFilter

def analyze(img):
    """Return contrast score (0=flat/bad, 1=full range) and bleed score."""
    gray = img.convert('L')
    hist = gray.histogram()
    total = sum(hist)
    if total == 0:
        return 0.0, 0.0

    cum, lo, hi = 0, 0, 255
    for i, h in enumerate(hist):
        cum += h
        if cum / total < 0.01:
            lo = i
        if cum / total < 0.99:
            hi = i

    contrast_range = (hi - lo) / 255.0

    # Bleed-through: mid-gray noise (150-220) coexisting with dark text (<80)
    light_pixels = sum(hist[150:220])
    dark_pixels = sum(hist[0:80])
    bleed_score = light_pixels / max(dark_pixels + light_pixels, 1)

    return contrast_range, bleed_score

def enhance_contrast(img, issues=None):
    """Apply contrast enhancement variants. Returns list of (label, image) tuples."""
    issues = issues or []
    variants = []

    # 1. Autocontrast — stretches histogram to full 0-255 range
    auto = ImageOps.autocontrast(img.convert('L'), cutoff=2).convert('RGB')
    variants.append(('autocontrast', auto))

    # 2. Autocontrast + moderate contrast boost (good for faded text)
    boosted = ImageEnhance.Contrast(auto).enhance(1.5)
    variants.append(('autocontrast+boost', boosted))

    # 3. Otsu threshold — converts to B&W via inter-class variance maximization.
    gray = img.convert('L')
    hist = gray.histogram()
    total = sum(hist)
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
    thresh = max(50, best_thresh - 15)
    bw = gray.point(lambda p: 0 if p < thresh else 255).convert('RGB')
    variants.append(('otsu_threshold', bw))

    # 4. Bleed-through suppression — for reverse-side bleed on old newspaper/book scans.
    # Bleed pixels live in the 130-220 mid-gray range; real text is below 100.
    # Strategy: whiten the bleed zone, then autocontrast what remains.
    if 'bleed_through' in issues:
        gray2 = img.convert('L')
        # First pass: median filter to estimate local background (captures bleed, blurs text)
        bg = gray2.filter(ImageFilter.MedianFilter(size=9))
        # Whiten pixels that are lighter than a bleed threshold
        bleed_thresh = 135
        cleaned = gray2.point(lambda p: 255 if p > bleed_thresh else p)
        # Normalize remaining ink
        suppressed = ImageOps.autocontrast(cleaned.convert('RGB'), cutoff=1)
        variants.append(('bleed_suppression', suppressed))

        # Also try a two-stage approach: median-based background subtraction then threshold
        # Use PIL ImageChops to compute difference between original and blurred background
        from PIL import ImageChops
        bg_rgb = bg.convert('RGB')
        orig_rgb = gray2.convert('RGB')
        # Difference = foreground (text) without background
        diff = ImageChops.difference(orig_rgb, bg_rgb)
        # Invert (text should be dark on white)
        inv = ImageOps.invert(diff)
        auto_inv = ImageOps.autocontrast(inv, cutoff=1)
        variants.append(('bg_subtract', auto_inv))

    # 5. Faded text: aggressive contrast + brightness push
    if 'faded' in issues or 'low_contrast' in issues:
        gray3 = img.convert('L')
        stretched = ImageOps.autocontrast(gray3, cutoff=5).convert('RGB')
        pushed = ImageEnhance.Contrast(stretched).enhance(2.0)
        variants.append(('faded_boost', pushed))

    return variants

def score_variant(label, img_path):
    """Quality proxy: high mean (white bg) + high stddev (sharp contrast) = good scan."""
    img = Image.open(img_path).convert('L')
    hist = img.histogram()
    total = sum(hist)
    mean = sum(i * h for i, h in enumerate(hist)) / total
    var = sum((i - mean) ** 2 * h for i, h in enumerate(hist)) / total
    stddev = var ** 0.5
    return (mean / 255.0) * min(stddev / 80.0, 1.0)

def main():
    args = sys.argv[1:]
    force = '--force' in args
    args = [a for a in args if a != '--force']

    issues = []
    if '--issues' in args:
        idx = args.index('--issues')
        if idx + 1 < len(args):
            issues = [s.strip() for s in args[idx+1].split(',') if s.strip()]
        args = args[:idx] + args[idx+2:]

    method = None
    if '--method' in args:
        idx = args.index('--method')
        method = args[idx+1] if idx+1 < len(args) else None
        args = args[:idx] + args[idx+2:]

    if len(args) < 2:
        print(json.dumps({"error": "usage: preprocess_image.py [--force] [--issues i1,i2] [--method M] input.png output.png"}))
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
    needs_bleed_fix = bleed_score > 0.3 or 'bleed_through' in issues

    result = {
        "contrast_range": round(contrast_range, 3),
        "bleed_score": round(bleed_score, 3),
        "bleed_detected": bleed_score > 0.3,
        "applied": [],
        "enhanced": False,
    }

    if not force and not needs_contrast and not needs_bleed_fix:
        print(json.dumps(result))
        return

    all_variants = enhance_contrast(img, issues)
    if method:
        variants = [(l, v) for l, v in all_variants if method in l] or all_variants
    elif 'bleed_through' in issues:
        # Prioritize bleed-suppression variants when bleed is flagged
        bleed_variants = [(l, v) for l, v in all_variants if 'bleed' in l or 'bg_sub' in l]
        variants = bleed_variants or all_variants
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

    orig_score = score_variant('original', in_path)

    if best_img is not None and best_score > orig_score * 1.05:
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
