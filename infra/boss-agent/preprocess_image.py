#!/usr/bin/env python3
"""
Aggressive image preprocessing for OCR — images are disposable, only OCR quality matters.
Usage: python3 preprocess_image.py [--force] [--issues i1,i2] [--method LABEL] [--api-key KEY] <input.png> <output.png>
Output JSON: {"applied": [...], "contrast_range": 0-1, "bleed_score": 0-1, "bleed_detected": bool, "enhanced": bool}
Tries 40+ enhancement variants; scoring picks the best. Vision model used as tiebreaker when API key provided.
"""
import sys, json, os, subprocess, tempfile
from PIL import Image, ImageEnhance, ImageOps, ImageFilter

if '--check' in sys.argv:
    missing = []
    try: from PIL import Image
    except ImportError: missing.append('pillow')
    try: import cv2
    except ImportError: missing.append('cv2')
    import shutil
    if not shutil.which('unpaper'): missing.append('unpaper')
    if not shutil.which('magick'):  missing.append('magick')
    print('missing: ' + ', '.join(missing) if missing else 'ok')
    sys.exit(0)

# ── Analysis ────────────────────────────────────────────────────────────────

def analyze(img):
    """Return (contrast_range, bleed_score). contrast_range: 0=flat, 1=full. bleed_score: 0=clean, 1=heavy bleed."""
    gray = img.convert('L')
    hist = gray.histogram()
    total = sum(hist)
    if total == 0:
        return 0.0, 0.0
    cum, lo, hi = 0, 0, 255
    for i, h in enumerate(hist):
        cum += h
        if cum / total < 0.01: lo = i
        if cum / total < 0.99: hi = i
    contrast_range = (hi - lo) / 255.0
    # Bleed-through: mid-gray haze (150-220) coexisting with dark ink (<80)
    light = sum(hist[150:220])
    dark  = sum(hist[0:80])
    bleed_score = light / max(dark + light, 1)
    return contrast_range, bleed_score

def grain_score(img):
    """High-frequency noise level — stddev of (image - gaussian_blur). >20 = noticeably grainy."""
    try:
        import numpy as np
        arr = np.array(img.convert('L'), dtype=np.float32)
        blurred = np.array(img.convert('L').filter(ImageFilter.GaussianBlur(radius=1)), dtype=np.float32)
        return float(np.std(arr - blurred))
    except ImportError:
        return 0.0

# ── Scoring ─────────────────────────────────────────────────────────────────

def score_image(pil_img):
    """
    Combined OCR quality proxy:
      60% statistical  — high mean (white bg) × high stddev (ink contrast)
      40% edge density — Canny edge pixel ratio (more edges = more readable text)
    Both components normalized to 0-1.
    """
    try:
        import cv2, numpy as np
        gray = np.array(pil_img.convert('L'))
        hist_vals = np.bincount(gray.flatten(), minlength=256).astype(float)
        total = hist_vals.sum()
        mean  = (np.arange(256) * hist_vals).sum() / total
        var   = ((np.arange(256) - mean) ** 2 * hist_vals).sum() / total
        stat  = (mean / 255.0) * min(var ** 0.5 / 80.0, 1.0)
        edges = cv2.Canny(gray, 50, 150)
        edge_d = float(np.count_nonzero(edges)) / edges.size
        # Typical clean scan: edge_density ~0.05-0.12; normalize at 0.10
        edge_norm = min(edge_d / 0.10, 1.0)
        return 0.60 * stat + 0.40 * edge_norm
    except ImportError:
        # PIL-only fallback
        gray = pil_img.convert('L')
        hist = gray.histogram()
        total = sum(hist)
        mean = sum(i * h for i, h in enumerate(hist)) / total
        var  = sum((i - mean) ** 2 * h for i, h in enumerate(hist)) / total
        return (mean / 255.0) * min(var ** 0.5 / 80.0, 1.0)

def score_path(path):
    return score_image(Image.open(path))

# ── Sauvola binarization (numpy+cv2, no scipy needed) ───────────────────────

def sauvola_binarize(gray_cv, window=25, k=0.2):
    """Sauvola local threshold — gold standard for uneven illumination and bleed-through."""
    import numpy as np, cv2
    gray = gray_cv.astype(np.float64)
    mean    = cv2.boxFilter(gray, -1, (window, window))
    mean_sq = cv2.boxFilter(gray ** 2, -1, (window, window))
    std     = np.sqrt(np.maximum(mean_sq - mean ** 2, 0))
    # k=0.2: standard Sauvola. Higher k → more aggressive (whiter background).
    threshold = mean * (1.0 + k * (std / 128.0 - 1.0))
    return ((gray > threshold) * 255).astype('uint8')

# ── Variant generators ───────────────────────────────────────────────────────

def pil_variants(img, issues):
    """Fast PIL-only variants — no subprocess overhead."""
    from PIL import ImageChops
    variants = []
    gray = img.convert('L')

    # Histogram stretching family
    auto = ImageOps.autocontrast(gray, cutoff=2).convert('RGB')
    variants.append(('autocontrast',       auto))
    variants.append(('autocontrast+boost', ImageEnhance.Contrast(auto).enhance(1.5)))
    variants.append(('autocontrast+boost2',ImageEnhance.Contrast(auto).enhance(2.0)))

    # Sharpening family
    variants.append(('sharpen',     ImageEnhance.Sharpness(img).enhance(2.0)))
    variants.append(('sharpen3x',   ImageEnhance.Sharpness(img).enhance(3.0)))
    variants.append(('unsharp_r1',  img.filter(ImageFilter.UnsharpMask(radius=1, percent=200, threshold=3)).convert('RGB')))
    variants.append(('unsharp_r2',  img.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=2)).convert('RGB')))

    # Global Otsu binarization
    hist   = gray.histogram()
    total  = sum(hist)
    best_thresh, best_var, cum_n, cum_sum = 128, -1, 0, 0
    total_sum = sum(i * h for i, h in enumerate(hist))
    for t in range(256):
        cum_n += hist[t]; cum_sum += t * hist[t]
        if cum_n == 0 or cum_n == total: continue
        w0, w1 = cum_n / total, (total - cum_n) / total
        mu0 = cum_sum / cum_n
        mu1 = (total_sum - cum_sum) / (total - cum_n)
        var = w0 * w1 * (mu0 - mu1) ** 2
        if var > best_var: best_var, best_thresh = var, t
    for off in [-20, -10, 0]:
        t = max(40, best_thresh + off)
        bw = gray.point(lambda p, th=t: 0 if p < th else 255).convert('RGB')
        variants.append((f'otsu{off:+d}', bw))
        variants.append((f'otsu{off:+d}+sharpen', ImageEnhance.Sharpness(bw).enhance(2.0)))

    # Median despeckle
    med = img.filter(ImageFilter.MedianFilter(size=3))
    variants.append(('despeckle+autocontrast', ImageOps.autocontrast(med.convert('L'), cutoff=2).convert('RGB')))
    med5 = img.filter(ImageFilter.MedianFilter(size=5))
    variants.append(('despeckle5+autocontrast', ImageOps.autocontrast(med5.convert('L'), cutoff=2).convert('RGB')))

    # Bleed-through threshold sweep — wide range; scoring picks optimal per image
    if 'bleed_through' in issues:
        for t in [120, 130, 140, 150, 155, 160, 165, 170, 180]:
            cleaned = gray.point(lambda p, th=t: 255 if p > th else p)
            variants.append((f'bleed_sup{t}', ImageOps.autocontrast(cleaned.convert('RGB'), cutoff=1)))
        # Background subtraction via large median blur
        bg   = gray.filter(ImageFilter.MedianFilter(size=15))
        diff = ImageChops.difference(gray.convert('RGB'), bg.convert('RGB'))
        variants.append(('bg_subtract', ImageOps.autocontrast(ImageOps.invert(diff), cutoff=1)))
        # Despeckle then bleed suppress — handles noisy bleed simultaneously
        for t in [150, 160, 170]:
            med_g = med.convert('L').point(lambda p, th=t: 255 if p > th else p)
            variants.append((f'despeckle+bleed_sup{t}', ImageOps.autocontrast(med_g.convert('RGB'), cutoff=1)))

    # Faded / low contrast boost
    if 'faded' in issues or 'low_contrast' in issues:
        stretched = ImageOps.autocontrast(gray, cutoff=5).convert('RGB')
        variants.append(('faded_boost',  ImageEnhance.Contrast(stretched).enhance(2.0)))
        variants.append(('faded_boost3', ImageEnhance.Contrast(stretched).enhance(3.0)))

    return variants


def cv2_variants(img, issues):
    """OpenCV variants — CLAHE, NLM, adaptive threshold, Sauvola, morphological, bilateral."""
    try:
        import cv2, numpy as np
    except ImportError:
        return []

    variants = []
    gray_cv = cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2GRAY)

    def to_rgb(arr):
        return Image.fromarray(arr).convert('RGB')

    def auto(arr):
        return ImageOps.autocontrast(Image.fromarray(arr), cutoff=1).convert('RGB')

    # NL-means denoising — best for photocopy grain; preserves edges unlike Gaussian
    for h in [8, 12, 15, 20, 25]:
        nlm = cv2.fastNlMeansDenoising(gray_cv, None, h=h, templateWindowSize=7, searchWindowSize=21)
        variants.append((f'nlm_h{h}',       auto(nlm)))
        # NLM + Otsu: denoise then hard binarize — best for heavy grain
        _, bw = cv2.threshold(nlm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append((f'nlm_h{h}+otsu',  to_rgb(bw)))

    # NLM + adaptive threshold (Gaussian weighted) — handles uneven page illumination
    nlm15 = cv2.fastNlMeansDenoising(gray_cv, None, h=15, templateWindowSize=7, searchWindowSize=21)
    for block in [21, 31]:
        for c in [5, 10]:
            at = cv2.adaptiveThreshold(nlm15, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, c)
            variants.append((f'nlm15+adapt_gauss_b{block}c{c}', to_rgb(at)))

    # CLAHE — contrast limited adaptive histogram equalization; superb for uneven illumination
    for clip in [2.0, 3.0, 4.0]:
        clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8))
        cl = clahe.apply(gray_cv)
        variants.append((f'clahe_c{clip:.0f}',         auto(cl)))
        _, bw = cv2.threshold(cl, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append((f'clahe_c{clip:.0f}+otsu',    to_rgb(bw)))
        # CLAHE + NLM: fix illumination then denoise
        nlm_cl = cv2.fastNlMeansDenoising(cl, None, h=12)
        variants.append((f'clahe_c{clip:.0f}+nlm12',   auto(nlm_cl)))

    # Sauvola local threshold — gold standard for bleed-through + uneven illumination
    for window in [15, 25, 35]:
        for k in [0.15, 0.2, 0.3]:
            sauv = sauvola_binarize(gray_cv, window=window, k=k)
            variants.append((f'sauvola_w{window}k{int(k*100)}', to_rgb(sauv)))
    # NLM + Sauvola: denoise first, then local threshold
    for k in [0.15, 0.2]:
        sauv = sauvola_binarize(nlm15, window=25, k=k)
        variants.append((f'nlm15+sauvola_k{int(k*100)}', to_rgb(sauv)))

    # Adaptive threshold alone — mean and Gaussian weighted
    for method, mname in [(cv2.ADAPTIVE_THRESH_MEAN_C, 'mean'), (cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 'gauss')]:
        for block in [15, 25]:
            for c in [5, 8, 12]:
                at = cv2.adaptiveThreshold(gray_cv, 255, method, cv2.THRESH_BINARY, block, c)
                variants.append((f'adapt_{mname}_b{block}c{c}', to_rgb(at)))

    # Bilateral filter — edge-preserving smooth; good for uniform noise without blurring text
    for d, sc, ss in [(9, 75, 75), (9, 50, 50)]:
        bil = cv2.bilateralFilter(gray_cv, d, sc, ss)
        variants.append((f'bilateral_d{d}sc{sc}', auto(bil)))

    # Gaussian blur + threshold — fast, catches mild uniform grain
    for sigma in [1, 1.5]:
        k = int(sigma * 4) | 1  # ensure odd
        gauss = cv2.GaussianBlur(gray_cv, (k, k), sigma)
        variants.append((f'gauss_s{sigma}+autocontrast', auto(gauss)))
        _, bw = cv2.threshold(gauss, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append((f'gauss_s{sigma}+otsu', to_rgb(bw)))

    # Morphological operations — thicken thin strokes (dilation) or fill gaps (closing)
    for ksize in [2, 3]:
        kernel = np.ones((ksize, ksize), np.uint8)
        dilated = cv2.dilate(gray_cv, kernel, iterations=1)
        variants.append((f'dilate_k{ksize}+autocontrast', auto(dilated)))
        closed  = cv2.morphologyEx(gray_cv, cv2.MORPH_CLOSE, kernel)
        variants.append((f'close_k{ksize}+autocontrast',  auto(closed)))

    # Bleed + NLM combo — suppress bleed first then denoise residual noise
    if 'bleed_through' in issues:
        for t in [150, 160, 170]:
            cleaned = np.array(Image.fromarray(gray_cv).point(lambda p, th=t: 255 if p > th else p))
            nlm_c = cv2.fastNlMeansDenoising(cleaned.astype('uint8'), None, h=10)
            variants.append((f'bleed_sup{t}+nlm10', auto(nlm_c)))
            sauv = sauvola_binarize(cleaned.astype('uint8'), window=25, k=0.2)
            variants.append((f'bleed_sup{t}+sauvola', to_rgb(sauv)))

    return variants


def cli_variants(img, issues, out_path):
    """unpaper and ImageMagick variants via subprocess. Returns (label, pil_img) list."""
    variants = []
    with tempfile.TemporaryDirectory() as tmp:
        in_png = os.path.join(tmp, 'in.png')
        img.save(in_png)

        # unpaper — designed specifically for book/document scan cleanup:
        # removes shadows, fixes skew, cleans borders, suppresses background noise
        if _cmd_exists('unpaper'):
            for layout in ['single']:
                out_ppm = os.path.join(tmp, f'unpaper_{layout}.ppm')
                try:
                    r = subprocess.run(
                        ['unpaper', '--layout', layout, '--overwrite', in_png, out_ppm],
                        capture_output=True, timeout=30)
                    if os.path.exists(out_ppm):
                        up = Image.open(out_ppm).convert('RGB')
                        variants.append((f'unpaper_{layout}', up))
                        # unpaper + autocontrast — unpaper output may be slightly flat
                        auto = ImageOps.autocontrast(up.convert('L'), cutoff=1).convert('RGB')
                        variants.append((f'unpaper_{layout}+autocontrast', auto))
                except Exception:
                    pass

        # ImageMagick — diverse filter library
        if _cmd_exists('magick'):
            magick_ops = [
                # -despeckle: morphological noise removal (multiple passes internally)
                (['despeckle', '-normalize'],        'magick_despeckle+norm'),
                # -enhance: multi-pass noise reduction
                (['-enhance', '-normalize'],          'magick_enhance+norm'),
                # LAT (local adaptive threshold) — similar to adaptive threshold, good for shadows
                (['-lat', '25x25-5%'],                'magick_lat25'),
                (['-lat', '15x15-5%'],                'magick_lat15'),
                # Morphological thickening — widens thin ink strokes
                (['-morphology', 'Dilate', 'Disk:1'], 'magick_dilate1+norm'),
                # Wavelet sharpen (IM7) — denoises then sharpens; very effective for photocopies
                (['-wavelet-denoise', '5%', '-normalize'], 'magick_wavelet5'),
                (['-wavelet-denoise', '10%', '-normalize'],'magick_wavelet10'),
                (['-wavelet-denoise', '15%', '-normalize'],'magick_wavelet15'),
            ]
            for ops, label in magick_ops:
                out_png = os.path.join(tmp, f'{label}.png')
                try:
                    cmd = ['magick', in_png] + ops + [out_png]
                    r = subprocess.run(cmd, capture_output=True, timeout=30)
                    if os.path.exists(out_png):
                        variants.append((label, Image.open(out_png).convert('RGB')))
                except Exception:
                    pass

    return variants


def _cmd_exists(cmd):
    import shutil
    return shutil.which(cmd) is not None

# ── Post-processing finalization ────────────────────────────────────────────

def finalize_for_ocr(pil_img):
    """
    Applied to the winning variant before saving — cleans up artifacts introduced by
    enhancement and binarization:
      1. Morphological close (2x2) — fills micro-gaps in thin/under-inked strokes
      2. Morphological open  (2x2) — removes residual isolated specks < 2px
      3. Mild Gaussian blur (sigma=0.5) + Otsu re-threshold — smooths jagged binary edges
         without changing character shapes. Skipped if image is already a clean binary.
    """
    try:
        import cv2, numpy as np
        gray = np.array(pil_img.convert('L'))

        # Detect whether image is already cleanly binarized (>90% pixels at 0 or 255)
        extreme = np.sum((gray == 0) | (gray == 255)) / gray.size
        is_binary = extreme > 0.90

        k2 = np.ones((2, 2), np.uint8)
        # Close: dilate then erode — bridges tiny stroke gaps
        closed = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, k2)
        # Open:  erode then dilate — kills isolated noise specks
        cleaned = cv2.morphologyEx(closed, cv2.MORPH_OPEN, k2)

        if is_binary:
            # Already binarized — skip blur/re-threshold to avoid double-processing
            return Image.fromarray(cleaned).convert('RGB')

        # For gray-valued images: mild blur kills sub-pixel jaggies, Otsu re-binarizes cleanly
        blurred = cv2.GaussianBlur(cleaned, (3, 3), 0.5)
        _, final = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return Image.fromarray(final).convert('RGB')
    except ImportError:
        return pil_img

# ── Vision model tiebreaker ─────────────────────────────────────────────────

def vision_pick_best(candidates, api_key):
    """
    Send top candidate images to Claude Haiku and ask which looks most OCR-readable.
    candidates: list of (label, pil_img). Returns the label of the best pick.
    """
    import base64, urllib.request, urllib.error
    if not candidates or not api_key:
        return None

    # Build a comparison grid — scale down to ~400px wide per image for cheap tokens
    thumb_w = 300
    content = [{"type": "text", "text":
        "These are differently preprocessed versions of a scanned document page for OCR text extraction. "
        "Evaluate each for OCR readability: clean white background, sharp dark text edges, "
        "absence of noise, bleed-through, and scanning artifacts. "
        f"The images are labeled {', '.join(chr(65+i) for i in range(len(candidates)))}. "
        "Reply with ONLY the letter of the most OCR-readable image."}]

    for i, (label, pil_img) in enumerate(candidates):
        w, h = pil_img.size
        scale = thumb_w / w
        thumb = pil_img.resize((thumb_w, int(h * scale)), Image.LANCZOS)
        import io
        buf = io.BytesIO()
        thumb.save(buf, 'PNG')
        b64 = base64.b64encode(buf.getvalue()).decode()
        content.append({"type": "text", "text": f"Image {chr(65+i)} ({label}):"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}})

    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 10,
        "messages": [{"role": "user", "content": content}]
    }).encode()

    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        letter = data["content"][0]["text"].strip().upper()[0]
        idx = ord(letter) - 65
        if 0 <= idx < len(candidates):
            return candidates[idx][0]
    except Exception:
        pass
    return None

# ── Main ────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    force   = '--force' in args;   args = [a for a in args if a != '--force']
    verbose = '--verbose' in args; args = [a for a in args if a != '--verbose']

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

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if '--api-key' in args:
        idx = args.index('--api-key')
        if idx + 1 < len(args):
            api_key = args[idx+1]
        args = args[:idx] + args[idx+2:]

    if len(args) < 2:
        print(json.dumps({"error": "usage: preprocess_image.py [--force] [--issues i1,i2] [--method LABEL] [--api-key KEY] input.png output.png"}))
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
    g_score  = grain_score(img)
    needs_contrast  = contrast_range < 0.6
    needs_bleed_fix = bleed_score > 0.3 or 'bleed_through' in issues
    needs_denoise   = g_score > 15.0 or 'grainy' in issues

    # Auto-wire detections to issue flags so conditional variant blocks activate
    if needs_bleed_fix and 'bleed_through' not in issues:
        issues = list(issues) + ['bleed_through']
    if (needs_contrast or needs_denoise) and 'low_contrast' not in issues and contrast_range < 0.7:
        issues = list(issues) + ['low_contrast']

    result = {
        "contrast_range": round(contrast_range, 3),
        "bleed_score":    round(bleed_score, 3),
        "grain_score":    round(g_score, 1),
        "bleed_detected": bleed_score > 0.3,
        "applied": [],
        "enhanced": False,
    }

    if not force and not needs_contrast and not needs_bleed_fix and not needs_denoise:
        print(json.dumps(result))
        return

    # Generate all variant families
    all_variants = (
        pil_variants(img, issues) +
        cv2_variants(img, issues) +
        cli_variants(img, issues, out_path)
    )

    if method:
        variants = [(l, v) for l, v in all_variants if method in l] or all_variants
    else:
        variants = all_variants

    # Score all variants, keep images in memory (no temp-file round-trip per variant)
    scored = []
    for label, v_img in variants:
        try:
            s = score_image(v_img)
            scored.append((s, label, v_img))
        except Exception:
            pass

    if not scored:
        print(json.dumps(result))
        return

    scored.sort(key=lambda x: -x[0])
    orig_score = score_path(in_path)

    if verbose:
        for s, label, _ in scored[:10]:
            print(f'  {s:.4f}  {label}', file=sys.stderr)

    best_score, best_label, best_img = scored[0]

    # Vision tiebreaker: when top candidates are within 3% of each other and API key available
    if api_key and len(scored) >= 2:
        top_score = scored[0][0]
        finalists = [(label, img) for s, label, img in scored if s >= top_score * 0.97][:5]
        if len(finalists) > 1:
            picked = vision_pick_best(finalists, api_key)
            if picked:
                for s, label, v_img in scored:
                    if label == picked:
                        best_score, best_label, best_img = s, label, v_img
                        break
                result["vision_pick"] = picked

    if best_img is not None and best_score > orig_score * 1.05:
        final_img = finalize_for_ocr(best_img)
        final_img.save(out_path, 'PNG')
        result["applied"]           = [best_label]
        result["enhanced"]          = True
        result["score_improvement"] = round(best_score - orig_score, 3)
        result["orig_score"]        = round(orig_score, 4)
        result["best_score"]        = round(best_score, 4)
    else:
        result["applied"]  = []
        result["enhanced"] = False

    print(json.dumps(result))

if __name__ == '__main__':
    main()
