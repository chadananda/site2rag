#!/usr/bin/env python3
"""
GPU-accelerated image preprocessing for OCR.
Usage: python3 preprocess_image.py [--force] [--issues i1,i2] [--method LABEL] [--api-key KEY] <input.png> <output.png>
Output JSON: {"applied": [...], "contrast_range": 0-1, "bleed_score": 0-1, "bleed_detected": bool, "enhanced": bool}
Tries 90+ enhancement variants via GPU batch tensor ops + CPU thread pool running in parallel.
GPU path (torch+CUDA/ROCm): all variants scored in one GPU pass, ~5-10x faster than CPU.
"""
import sys, json, os, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor
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
    try:
        import torch
        if torch.cuda.is_available():
            print(f'ok gpu={torch.cuda.get_device_name(0)}')
        else:
            print('missing: ' + ', '.join(missing) if missing else 'ok cpu-only')
    except ImportError:
        print('missing: ' + ', '.join(missing) if missing else 'ok cpu-only')
    sys.exit(0)

# ── GPU detection — subprocess probe catches SIGABRT on unsupported GPU archs ──
# ROCm gfx1151 (Strix Halo) crashes on tensor ops with ROCm <7.3 even when
# torch.cuda.is_available() returns True. Probe via subprocess; result cached
# in /tmp/.slp_gpu_probe for 1h to avoid per-call overhead.

_DEVICE = None
_torch  = None
_F      = None

def _probe_gpu():
    import subprocess, time
    cache = '/tmp/.slp_gpu_probe'
    try:
        if time.time() - os.path.getmtime(cache) < 3600:
            return open(cache).read().strip() == 'ok'
    except OSError:
        pass
    env = {**os.environ, 'HSA_OVERRIDE_GFX_VERSION': os.environ.get('HSA_OVERRIDE_GFX_VERSION', '11.0.0')}
    try:
        r = subprocess.run(
            [sys.executable, '-c',
             'import torch; t=torch.ones(8,8,device="cuda"); print("ok") if (t+t).sum().item()==128 else print("fail")'],
            capture_output=True, timeout=15, env=env)
        ok = r.returncode == 0 and r.stdout.strip() == b'ok'
    except Exception:
        ok = False
    try: open(cache, 'w').write('ok' if ok else 'fail')
    except OSError: pass
    return ok

try:
    import torch as _torch_mod
    import torch.nn.functional as _F_mod
    if _torch_mod.cuda.is_available() and _probe_gpu():
        os.environ.setdefault('HSA_OVERRIDE_GFX_VERSION', '11.0.0')
        _DEVICE = _torch_mod.device('cuda')
        _torch  = _torch_mod
        _F      = _F_mod
except ImportError:
    pass

def _has_gpu():
    return _DEVICE is not None

# ── GPU tensor utilities ──────────────────────────────────────────────────────

def _to_gpu(pil_img):
    """PIL (any mode) → [1,1,H,W] float32 grayscale tensor on GPU, values [0,255]."""
    import numpy as np
    gray = np.array(pil_img.convert('L'), dtype=np.float32)
    return _torch.from_numpy(gray).to(_DEVICE).unsqueeze(0).unsqueeze(0)

def _to_pil(t):
    """[1,1,H,W] float32 tensor → PIL RGB image."""
    import numpy as np
    arr = t.squeeze().cpu().numpy().clip(0, 255).astype('uint8')
    return Image.fromarray(arr).convert('RGB')

def _gauss_kernel(sigma, device):
    """1-D Gaussian kernel → [1,1,ks,ks] separable 2-D kernel."""
    ks = max(3, int(sigma * 4) | 1)
    ax = _torch.arange(ks, device=device, dtype=_torch.float32) - ks // 2
    g  = _torch.exp(-ax ** 2 / (2 * sigma ** 2))
    g  = g / g.sum()
    return (g.unsqueeze(1) @ g.unsqueeze(0)).view(1, 1, ks, ks), ks

def _gauss_blur(t, sigma):
    """Gaussian blur on GPU tensor [1,1,H,W]."""
    kernel, ks = _gauss_kernel(sigma, _DEVICE)
    return _F.conv2d(_F.pad(t, [ks//2]*4, mode='reflect'), kernel)

def _autocontrast(t, cutoff_pct=2.0):
    """Percentile-based stretch to [0,255]."""
    flat = t.flatten()
    lo   = _torch.quantile(flat, cutoff_pct / 100.0)
    hi   = _torch.quantile(flat, 1.0 - cutoff_pct / 100.0)
    if hi <= lo:
        return t.clamp(0, 255)
    return ((t - lo) / (hi - lo) * 255.0).clamp(0, 255)

def _otsu(t):
    """Otsu threshold value on GPU. Returns scalar float tensor."""
    flat = t.flatten().clamp(0, 255).long()
    hist = _torch.zeros(256, device=_DEVICE)
    hist.scatter_add_(0, flat, _torch.ones_like(flat, dtype=_torch.float32))
    total   = hist.sum()
    cum_n   = hist.cumsum(0)
    cum_s   = (hist * _torch.arange(256, device=_DEVICE, dtype=_torch.float32)).cumsum(0)
    total_s = cum_s[-1]
    w0      = cum_n / total
    w1      = 1.0 - w0
    mu0     = cum_s / cum_n.clamp(min=1)
    mu1     = (total_s - cum_s) / (total - cum_n).clamp(min=1)
    between = w0 * w1 * (mu0 - mu1) ** 2
    return between.argmax().float()

def _pool_dilate(t, ksize):
    """Morphological dilation via max pooling with reflection padding."""
    pad = ksize // 2
    return _F.max_pool2d(_F.pad(t, [pad]*4, mode='reflect'), ksize, stride=1, padding=0)

def _pool_erode(t, ksize):
    """Morphological erosion via -max_pool(-x)."""
    pad = ksize // 2
    return -_F.max_pool2d(_F.pad(-t, [pad]*4, mode='reflect'), ksize, stride=1, padding=0)

# ── GPU variant computation ───────────────────────────────────────────────────

def _gpu_variants(img, issues):
    """
    Compute all differentiable variants as GPU tensor ops.
    Returns [(label, tensor[1,1,H,W])]. Runs entirely on GPU — no CPU round-trips.
    """
    t = _to_gpu(img)
    variants = []

    # ── Autocontrast family
    auto = _autocontrast(t, cutoff_pct=2.0)
    variants.append(('autocontrast',        auto))
    variants.append(('autocontrast+boost',  (auto - 128).mul(1.5).add(128).clamp(0, 255)))
    variants.append(('autocontrast+boost2', (auto - 128).mul(2.0).add(128).clamp(0, 255)))

    # ── Sharpening (unsharp mask)
    for sigma, amount in [(1.0, 2.0), (1.0, 3.0), (2.0, 1.5)]:
        blur   = _gauss_blur(t, sigma)
        sharp  = (t + (t - blur) * amount).clamp(0, 255)
        variants.append((f'unsharp_s{sigma}_a{int(amount*10)}', sharp))

    # ── Gaussian blur + autocontrast/Otsu
    for sigma in [1.0, 1.5]:
        g = _gauss_blur(t, sigma)
        variants.append((f'gauss_s{sigma}+autocontrast', _autocontrast(g)))
        variants.append((f'gauss_s{sigma}+otsu',         (_torch.ones_like(g) * 255.0 * (g > _otsu(g)))))

    # ── Sauvola binarization — all 9 variants in GPU tensor ops
    # Sliding window mean/std via avg_pool2d (same operation as boxFilter).
    # Computing 3 different window sizes requires 3 avg_pool passes, but all k values
    # for the same window share the mean/std — computed once per window.
    for window in [15, 25, 35]:
        pad    = window // 2
        tp     = _F.pad(t, [pad]*4, mode='reflect')
        mean   = _F.avg_pool2d(tp,      window, stride=1, padding=0)
        sq_m   = _F.avg_pool2d(tp ** 2, window, stride=1, padding=0)
        std    = (sq_m - mean ** 2).clamp(min=0).sqrt()
        for k100 in [15, 20, 30]:
            k         = k100 / 100.0
            threshold = mean * (1.0 + k * (std / 128.0 - 1.0))
            binary    = (t > threshold).float() * 255.0
            variants.append((f'sauvola_w{window}k{k100}', binary))

    # ── Adaptive mean threshold (local mean - C) — covers adapt_mean_* family
    for window in [15, 25]:
        pad       = window // 2
        tp        = _F.pad(t, [pad]*4, mode='reflect')
        local_mean = _F.avg_pool2d(tp, window, stride=1, padding=0)
        for c in [5, 8, 12]:
            bw = (t > (local_mean - c)).float() * 255.0
            variants.append((f'adapt_mean_b{window}c{c}', bw))

    # ── Morphological ops
    for ksize in [2, 3]:
        dilated = _pool_dilate(t,        ksize).clamp(0, 255)
        closed  = _pool_erode(dilated,   ksize).clamp(0, 255)
        variants.append((f'dilate_k{ksize}+autocontrast', _autocontrast(dilated)))
        variants.append((f'close_k{ksize}+autocontrast',  _autocontrast(closed)))

    # ── Bleed-through suppression (set mid-gray halos → white, keep dark ink)
    if 'bleed_through' in issues:
        for thresh_val in [120, 130, 140, 150, 155, 160, 165, 170, 180]:
            suppressed = _torch.where(t > thresh_val, _torch.tensor(255.0, device=_DEVICE), t)
            variants.append((f'bleed_sup{thresh_val}', _autocontrast(suppressed, cutoff_pct=1.0)))

        # Bleed suppress + Sauvola: eliminates haze then local-thresholds residual
        for thresh_val in [150, 160, 170]:
            sup  = _torch.where(t > thresh_val, _torch.tensor(255.0, device=_DEVICE), t)
            pad  = 12
            tp   = _F.pad(sup, [pad]*4, mode='reflect')
            mean = _F.avg_pool2d(tp,      25, stride=1, padding=0)
            sq_m = _F.avg_pool2d(tp ** 2, 25, stride=1, padding=0)
            std  = (sq_m - mean ** 2).clamp(min=0).sqrt()
            thr  = mean * (1.0 + 0.2 * (std / 128.0 - 1.0))
            variants.append((f'bleed_sup{thresh_val}+sauvola', (sup > thr).float() * 255.0))

    # ── Faded / low-contrast boost
    if 'faded' in issues or 'low_contrast' in issues:
        stretched = _autocontrast(t, cutoff_pct=5.0)
        variants.append(('faded_boost',  (stretched - 128).mul(2.0).add(128).clamp(0, 255)))
        variants.append(('faded_boost3', (stretched - 128).mul(3.0).add(128).clamp(0, 255)))

    return variants  # [(label, [1,1,H,W] tensor)]


# ── GPU batch scoring ─────────────────────────────────────────────────────────

def _score_batch_gpu(tensors):
    """
    Score all variants in one GPU pass.
    tensors: list of [1,1,H,W] float32, values [0,255].
    Returns list of float scores (same order).
    Scores in chunks to avoid OOM on very large images.
    """
    CHUNK = 64  # variants per GPU pass
    all_scores = []
    sobel_x = _torch.tensor([[[-1,0,1],[-2,0,2],[-1,0,1]]], dtype=_torch.float32,
                              device=_DEVICE).view(1,1,3,3)
    sobel_y = sobel_x.transpose(2,3).contiguous()

    for i in range(0, len(tensors), CHUNK):
        batch = _torch.cat(tensors[i:i+CHUNK], dim=0)   # [N, 1, H, W]

        means  = batch.mean(dim=[1,2,3])
        stds   = batch.std(dim=[1,2,3])
        stat   = (means / 255.0) * _torch.clamp(stds / 80.0, 0.0, 1.0)

        gx     = _F.conv2d(batch, sobel_x, padding=1)
        gy     = _F.conv2d(batch, sobel_y, padding=1)
        mag    = (gx ** 2 + gy ** 2).sqrt()
        e_dens = (mag > 25.0).float().mean(dim=[1,2,3])
        e_norm = _torch.clamp(e_dens / 0.10, 0.0, 1.0)

        scores = (0.60 * stat + 0.40 * e_norm)
        all_scores.extend(scores.tolist())

    return all_scores


# ── CPU variants (NLM, CLAHE, adaptive, bilateral — no GPU equivalent) ────────

def _cpu_cv2_variants(img, issues):
    """cv2 NLM + CLAHE + misc — CPU-only algos; run in thread pool alongside GPU."""
    try:
        import cv2, numpy as np
    except ImportError:
        return []

    variants = []
    gray_cv = cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2GRAY)

    def to_rgb(a): return Image.fromarray(a).convert('RGB')
    def auto(a):   return ImageOps.autocontrast(Image.fromarray(a), cutoff=1).convert('RGB')

    # NL-means — best for photocopy grain; no simple GPU equivalent
    for h in [8, 12, 15, 20, 25]:
        nlm = cv2.fastNlMeansDenoising(gray_cv, None, h=h, templateWindowSize=7, searchWindowSize=21)
        variants.append((f'nlm_h{h}',      auto(nlm)))
        _, bw = cv2.threshold(nlm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append((f'nlm_h{h}+otsu', to_rgb(bw)))

    nlm15 = cv2.fastNlMeansDenoising(gray_cv, None, h=15, templateWindowSize=7, searchWindowSize=21)
    for block in [21, 31]:
        for c in [5, 10]:
            at = cv2.adaptiveThreshold(nlm15, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, block, c)
            variants.append((f'nlm15+adapt_gauss_b{block}c{c}', to_rgb(at)))
    for k in [0.15, 0.2]:
        sauv = _sauvola_cpu(nlm15, window=25, k=k)
        variants.append((f'nlm15+sauvola_k{int(k*100)}', to_rgb(sauv)))

    # CLAHE — tiled equalization; complex tiling makes pure-GPU impl non-trivial
    for clip in [2.0, 3.0, 4.0]:
        clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8))
        cl    = clahe.apply(gray_cv)
        variants.append((f'clahe_c{clip:.0f}',      auto(cl)))
        _, bw = cv2.threshold(cl, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append((f'clahe_c{clip:.0f}+otsu', to_rgb(bw)))
        variants.append((f'clahe_c{clip:.0f}+nlm12',
                         auto(cv2.fastNlMeansDenoising(cl, None, h=12))))

    # Bilateral — edge-preserving smoothing
    for d, sc, ss in [(9, 75, 75), (9, 50, 50)]:
        bil = cv2.bilateralFilter(gray_cv, d, sc, ss)
        variants.append((f'bilateral_d{d}sc{sc}', auto(bil)))

    # Bleed + NLM combo
    if 'bleed_through' in issues:
        import numpy as np
        for thr in [150, 160, 170]:
            cl = np.array(Image.fromarray(gray_cv).point(lambda p, t=thr: 255 if p > t else p))
            nlm_c = cv2.fastNlMeansDenoising(cl.astype('uint8'), None, h=10)
            variants.append((f'bleed_sup{thr}+nlm10', auto(nlm_c)))

    return variants


def _cli_variants(img, issues):
    """ImageMagick / unpaper subprocess variants."""
    variants = []
    with tempfile.TemporaryDirectory() as tmp:
        in_png = os.path.join(tmp, 'in.png')
        img.save(in_png)

        if _cmd_exists('unpaper'):
            out_ppm = os.path.join(tmp, 'unpaper_single.ppm')
            try:
                subprocess.run(['unpaper', '--layout', 'single', '--overwrite', in_png, out_ppm],
                               capture_output=True, timeout=30)
                if os.path.exists(out_ppm):
                    up = Image.open(out_ppm).convert('RGB')
                    variants.append(('unpaper_single', up))
                    variants.append(('unpaper_single+autocontrast',
                                     ImageOps.autocontrast(up.convert('L'), cutoff=1).convert('RGB')))
            except Exception:
                pass

        if _cmd_exists('magick'):
            magick_ops = [
                (['despeckle', '-normalize'],              'magick_despeckle+norm'),
                (['-enhance', '-normalize'],               'magick_enhance+norm'),
                (['-lat', '25x25-5%'],                     'magick_lat25'),
                (['-lat', '15x15-5%'],                     'magick_lat15'),
                (['-morphology', 'Dilate', 'Disk:1'],      'magick_dilate1+norm'),
                (['-wavelet-denoise', '5%',  '-normalize'],'magick_wavelet5'),
                (['-wavelet-denoise', '10%', '-normalize'],'magick_wavelet10'),
                (['-wavelet-denoise', '15%', '-normalize'],'magick_wavelet15'),
            ]
            for ops, label in magick_ops:
                out_png = os.path.join(tmp, f'{label}.png')
                try:
                    r = subprocess.run(['magick', in_png] + ops + [out_png],
                                       capture_output=True, timeout=30)
                    if os.path.exists(out_png):
                        variants.append((label, Image.open(out_png).convert('RGB')))
                except Exception:
                    pass

    return variants


# ── CPU fallback variants (used when no GPU) ──────────────────────────────────

def _pil_variants_cpu(img, issues):
    """PIL-only variants for CPU path."""
    from PIL import ImageChops
    variants = []
    gray = img.convert('L')

    auto = ImageOps.autocontrast(gray, cutoff=2).convert('RGB')
    variants += [
        ('autocontrast',        auto),
        ('autocontrast+boost',  ImageEnhance.Contrast(auto).enhance(1.5)),
        ('autocontrast+boost2', ImageEnhance.Contrast(auto).enhance(2.0)),
        ('sharpen',   ImageEnhance.Sharpness(img).enhance(2.0)),
        ('sharpen3x', ImageEnhance.Sharpness(img).enhance(3.0)),
        ('unsharp_r1', img.filter(ImageFilter.UnsharpMask(1,  200, 3)).convert('RGB')),
        ('unsharp_r2', img.filter(ImageFilter.UnsharpMask(2,  150, 2)).convert('RGB')),
    ]

    hist = gray.histogram()
    total = sum(hist)
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
        thresh = max(40, best_thresh + off)
        bw = gray.point(lambda p, th=thresh: 0 if p < th else 255).convert('RGB')
        variants += [(f'otsu{off:+d}', bw), (f'otsu{off:+d}+sharpen', ImageEnhance.Sharpness(bw).enhance(2.0))]

    med = img.filter(ImageFilter.MedianFilter(3))
    variants += [
        ('despeckle+autocontrast',  ImageOps.autocontrast(med.convert('L'), cutoff=2).convert('RGB')),
        ('despeckle5+autocontrast', ImageOps.autocontrast(
            img.filter(ImageFilter.MedianFilter(5)).convert('L'), cutoff=2).convert('RGB')),
    ]

    if 'bleed_through' in issues:
        from PIL import ImageChops
        for thresh_val in [120, 130, 140, 150, 155, 160, 165, 170, 180]:
            cleaned = gray.point(lambda p, th=thresh_val: 255 if p > th else p)
            variants.append((f'bleed_sup{thresh_val}',
                             ImageOps.autocontrast(cleaned.convert('RGB'), cutoff=1)))
        bg   = gray.filter(ImageFilter.MedianFilter(15))
        diff = ImageChops.difference(gray.convert('RGB'), bg.convert('RGB'))
        variants.append(('bg_subtract', ImageOps.autocontrast(ImageOps.invert(diff), cutoff=1)))
        for thresh_val in [150, 160, 170]:
            med_g = med.convert('L').point(lambda p, th=thresh_val: 255 if p > th else p)
            variants.append((f'despeckle+bleed_sup{thresh_val}',
                             ImageOps.autocontrast(med_g.convert('RGB'), cutoff=1)))

    if 'faded' in issues or 'low_contrast' in issues:
        stretched = ImageOps.autocontrast(gray, cutoff=5).convert('RGB')
        variants += [('faded_boost',  ImageEnhance.Contrast(stretched).enhance(2.0)),
                     ('faded_boost3', ImageEnhance.Contrast(stretched).enhance(3.0))]

    return variants


# ── Analysis ──────────────────────────────────────────────────────────────────

def analyze(img):
    """(contrast_range, bleed_score). contrast_range: 0=flat, 1=full. bleed_score: 0=clean, 1=heavy."""
    gray = img.convert('L')
    hist = gray.histogram()
    total = sum(hist)
    if total == 0: return 0.0, 0.0
    cum, lo, hi = 0, 0, 255
    for i, h in enumerate(hist):
        cum += h
        if cum / total < 0.01: lo = i
        if cum / total < 0.99: hi = i
    contrast_range = (hi - lo) / 255.0
    light = sum(hist[150:220])
    dark  = sum(hist[0:80])
    bleed_score = light / max(dark + light, 1)
    return contrast_range, bleed_score

def grain_score(img):
    """Stddev of (image - gaussian_blur). >20 = noticeably grainy."""
    try:
        import numpy as np
        arr  = np.array(img.convert('L'), dtype=np.float32)
        blur = np.array(img.convert('L').filter(ImageFilter.GaussianBlur(1)), dtype=np.float32)
        return float(np.std(arr - blur))
    except ImportError:
        return 0.0

# ── CPU scoring (fallback when no GPU) ───────────────────────────────────────

def _score_cpu(pil_img):
    """CPU scoring for single PIL image."""
    try:
        import cv2, numpy as np
        gray = np.array(pil_img.convert('L'))
        hv   = np.bincount(gray.flatten(), minlength=256).astype(float)
        tot  = hv.sum()
        mean = (np.arange(256) * hv).sum() / tot
        var  = ((np.arange(256) - mean) ** 2 * hv).sum() / tot
        stat = (mean / 255.0) * min(var ** 0.5 / 80.0, 1.0)
        edges = cv2.Canny(gray, 50, 150)
        edge_n = min(float(np.count_nonzero(edges)) / edges.size / 0.10, 1.0)
        return 0.60 * stat + 0.40 * edge_n
    except ImportError:
        gray = pil_img.convert('L')
        hist = gray.histogram(); total = sum(hist)
        mean = sum(i * h for i, h in enumerate(hist)) / total
        var  = sum((i - mean) ** 2 * h for i, h in enumerate(hist)) / total
        return (mean / 255.0) * min(var ** 0.5 / 80.0, 1.0)

# ── Sauvola CPU (for NLM+Sauvola combos that start with CPU NLM output) ──────

def _sauvola_cpu(gray_cv, window=25, k=0.2):
    import numpy as np, cv2
    gray = gray_cv.astype(np.float64)
    mean    = cv2.boxFilter(gray, -1, (window, window))
    mean_sq = cv2.boxFilter(gray ** 2, -1, (window, window))
    std     = np.sqrt(np.maximum(mean_sq - mean ** 2, 0))
    threshold = mean * (1.0 + k * (std / 128.0 - 1.0))
    return ((gray > threshold) * 255).astype('uint8')

# ── Post-processing finalization ──────────────────────────────────────────────

def finalize_for_ocr(pil_img):
    """
    Morphological close(2×2) + open(2×2) — thickens thin strokes, removes specks.
    For non-binary output: mild Gaussian + Otsu re-threshold for clean edges.
    GPU when available, cv2 CPU fallback.
    """
    if _has_gpu():
        t      = _to_gpu(pil_img)
        closed = _pool_erode(_pool_dilate(t, 2), 2).clamp(0, 255)  # close
        cleaned = _pool_dilate(_pool_erode(closed, 2), 2).clamp(0, 255)  # open
        extreme = ((cleaned == 0) | (cleaned == 255)).float().mean().item()
        if extreme > 0.90:
            return _to_pil(cleaned)
        blurred = _gauss_blur(cleaned, 0.5)
        thresh  = _otsu(blurred)
        final   = (blurred > thresh).float() * 255.0
        return _to_pil(final)

    try:
        import cv2, numpy as np
        gray    = np.array(pil_img.convert('L'))
        k2      = np.ones((2, 2), np.uint8)
        closed  = cv2.morphologyEx(gray,   cv2.MORPH_CLOSE, k2)
        cleaned = cv2.morphologyEx(closed, cv2.MORPH_OPEN,  k2)
        extreme = np.sum((cleaned == 0) | (cleaned == 255)) / cleaned.size
        if extreme > 0.90:
            return Image.fromarray(cleaned).convert('RGB')
        blurred = cv2.GaussianBlur(cleaned, (3, 3), 0.5)
        _, final = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return Image.fromarray(final).convert('RGB')
    except ImportError:
        return pil_img

# ── Vision model tiebreaker ──────────────────────────────────────────────────

def vision_pick_best(candidates, api_key):
    """Send top candidate thumbnails to Claude Haiku; returns label of best pick."""
    import base64, io, urllib.request
    if not candidates or not api_key: return None
    thumb_w = 300
    content = [{"type": "text", "text":
        "These are differently preprocessed versions of a scanned document page for OCR. "
        "Evaluate each for OCR readability: clean white background, sharp dark text, "
        "no noise or bleed-through. "
        f"Images labeled {', '.join(chr(65+i) for i in range(len(candidates)))}. "
        "Reply with ONLY the letter of the most OCR-readable image."}]
    for i, (label, pil_img) in enumerate(candidates):
        w, h  = pil_img.size
        thumb = pil_img.resize((thumb_w, int(h * thumb_w / w)), Image.LANCZOS)
        buf   = io.BytesIO(); thumb.save(buf, 'PNG')
        b64   = base64.b64encode(buf.getvalue()).decode()
        content += [{"type": "text", "text": f"Image {chr(65+i)} ({label}):"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}}]
    payload = json.dumps({"model": "claude-haiku-4-5-20251001", "max_tokens": 10,
                          "messages": [{"role": "user", "content": content}]}).encode()
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages", data=payload,
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        letter = data["content"][0]["text"].strip().upper()[0]
        idx = ord(letter) - 65
        if 0 <= idx < len(candidates): return candidates[idx][0]
    except Exception:
        pass
    return None

# ── Helpers ──────────────────────────────────────────────────────────────────

def _cmd_exists(cmd):
    import shutil; return shutil.which(cmd) is not None

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    args    = sys.argv[1:]
    force   = '--force'   in args; args = [a for a in args if a != '--force']
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
        if idx+1 < len(args): api_key = args[idx+1]
        args = args[:idx] + args[idx+2:]

    if len(args) < 2:
        print(json.dumps({"error": "usage: preprocess_image.py [--force] [--issues i1,i2] <input.png> <output.png>"}))
        sys.exit(1)

    in_path, out_path = args[0], args[1]
    if not os.path.exists(in_path):
        print(json.dumps({"error": f"input not found: {in_path}"})); sys.exit(0)

    try:
        img = Image.open(in_path).convert('RGB')
    except Exception as e:
        print(json.dumps({"error": str(e)})); sys.exit(0)

    contrast_range, bleed_score = analyze(img)
    g_score       = grain_score(img)
    needs_contrast = contrast_range < 0.6
    needs_bleed    = bleed_score > 0.3 or 'bleed_through' in issues
    needs_denoise  = g_score > 15.0  or 'grainy'        in issues

    if needs_bleed   and 'bleed_through' not in issues: issues = list(issues) + ['bleed_through']
    if (needs_contrast or needs_denoise) and 'low_contrast' not in issues and contrast_range < 0.7:
        issues = list(issues) + ['low_contrast']

    result = {
        "contrast_range": round(contrast_range, 3),
        "bleed_score":    round(bleed_score,    3),
        "grain_score":    round(g_score,        1),
        "bleed_detected": bleed_score > 0.3,
        "gpu":            _has_gpu(),
        "applied": [],
        "enhanced": False,
    }

    if not force and not needs_contrast and not needs_bleed and not needs_denoise:
        print(json.dumps(result)); return

    if _has_gpu():
        # ── GPU path: tensor variants + CPU variants in parallel ──────────────
        # Launch CPU-only ops (NLM, CLAHE, CLI) in a thread while GPU computes.
        with ThreadPoolExecutor(max_workers=2) as pool:
            cpu_cv2_fut = pool.submit(_cpu_cv2_variants, img, issues)
            cli_fut     = pool.submit(_cli_variants,     img, issues)
            gpu_vars    = _gpu_variants(img, issues)      # runs while threads work
            cpu_cv2_vars = cpu_cv2_fut.result()
            cli_vars     = cli_fut.result()

        if method:
            gpu_vars    = [(l, t) for l, t in gpu_vars    if method in l] or gpu_vars
            cpu_cv2_vars = [(l, v) for l, v in cpu_cv2_vars if method in l] or cpu_cv2_vars
            cli_vars    = [(l, v) for l, v in cli_vars    if method in l] or cli_vars

        # Convert all CPU PIL variants to GPU tensors for unified batch scoring
        cpu_all = cpu_cv2_vars + cli_vars
        cpu_tensors = [_to_gpu(v) for _, v in cpu_all]

        all_labels  = [l for l, _ in gpu_vars]   + [l for l, _ in cpu_all]
        all_tensors = [t for _, t in gpu_vars]   + cpu_tensors

        if not all_tensors:
            print(json.dumps(result)); return

        scores = _score_batch_gpu(all_tensors)

        # orig score on GPU too
        orig_t     = _to_gpu(img)
        orig_score = _score_batch_gpu([orig_t])[0]

        if verbose:
            ranked = sorted(zip(scores, all_labels), reverse=True)
            for s, lbl in ranked[:10]:
                print(f'  {s:.4f}  {lbl}', file=sys.stderr)

        best_idx   = max(range(len(scores)), key=lambda i: scores[i])
        best_score = scores[best_idx]
        best_label = all_labels[best_idx]

        # Vision tiebreaker
        if api_key and len(scores) >= 2:
            top = scores[best_idx]
            finalist_idxs = [i for i, s in enumerate(scores) if s >= top * 0.97][:5]
            if len(finalist_idxs) > 1:
                finalists = [(all_labels[i], _to_pil(all_tensors[i])) for i in finalist_idxs]
                picked = vision_pick_best(finalists, api_key)
                if picked:
                    for i, lbl in enumerate(all_labels):
                        if lbl == picked: best_idx, best_score, best_label = i, scores[i], lbl; break
                    result["vision_pick"] = picked

        if best_score > orig_score * 1.05:
            best_pil   = _to_pil(all_tensors[best_idx])
            final_img  = finalize_for_ocr(best_pil)
            final_img.save(out_path, 'PNG')
            result["applied"]           = [best_label]
            result["enhanced"]          = True
            result["score_improvement"] = round(best_score - orig_score, 3)
            result["orig_score"]        = round(orig_score, 4)
            result["best_score"]        = round(best_score, 4)
        # else: no improvement, don't write output

    else:
        # ── CPU path: PIL variants in main thread + cv2/CLI in parallel threads
        with ThreadPoolExecutor(max_workers=2) as pool:
            cv2_fut = pool.submit(_cpu_cv2_variants, img, issues)
            cli_fut = pool.submit(_cli_variants,     img, issues)
            pil_vars = _pil_variants_cpu(img, issues)    # runs while threads work
            cv2_vars = cv2_fut.result()
            cli_vars = cli_fut.result()
        all_vars = pil_vars + cv2_vars + cli_vars
        if method:
            all_vars = [(l, v) for l, v in all_vars if method in l] or all_vars

        scored = []
        for label, v_img in all_vars:
            try: scored.append((_score_cpu(v_img), label, v_img))
            except Exception: pass

        if not scored:
            print(json.dumps(result)); return

        scored.sort(key=lambda x: -x[0])
        orig_score = _score_cpu(img)

        if verbose:
            for s, lbl, _ in scored[:10]:
                print(f'  {s:.4f}  {lbl}', file=sys.stderr)

        best_score, best_label, best_img = scored[0]

        if api_key and len(scored) >= 2:
            top       = scored[0][0]
            finalists = [(l, v) for s, l, v in scored if s >= top * 0.97][:5]
            if len(finalists) > 1:
                picked = vision_pick_best(finalists, api_key)
                if picked:
                    for s, l, v in scored:
                        if l == picked: best_score, best_label, best_img = s, l, v; break
                    result["vision_pick"] = picked

        if best_score > orig_score * 1.05:
            final_img = finalize_for_ocr(best_img)
            final_img.save(out_path, 'PNG')
            result["applied"]           = [best_label]
            result["enhanced"]          = True
            result["score_improvement"] = round(best_score - orig_score, 3)
            result["orig_score"]        = round(orig_score,   4)
            result["best_score"]        = round(best_score,   4)

    print(json.dumps(result))

if __name__ == '__main__':
    main()
