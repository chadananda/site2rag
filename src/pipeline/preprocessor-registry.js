// Image preprocessor registrations. Thin wrapper over service-registry.js. For new preprocessors: registerService({type:'preprocess', ...})
// Deps: service-registry.js, ocr-server-pool.js (preprocess_server.py via callPersistentServer)
// All preprocessors are throwawayOnly: true — applied to throwaway copies, never originals.
// Pool support: set PREPROCESS_ENDPOINTS (plural, comma-separated) to distribute across nodes.
// PREPROCESS_ENDPOINT (singular) allows routing to a single remote preprocess_server.py node.

import { callPersistentServer } from './ocr-server-pool.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerService, getServices } from './service-registry.js';

const PREPROC_PYTHON = process.env.PREPROC_PYTHON ?? '/tank/site2rag/ocr-venv/bin/python3';
const PREPROC_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'engines', 'preprocess_server.py');

// Determine endpoint(s): plural env var takes precedence over singular
const _preprocEndpointsList = process.env.PREPROCESS_ENDPOINTS?.split(',').filter(Boolean) ?? null;
const _preprocEndpoint = process.env.PREPROCESS_ENDPOINT ?? 'local';
// Pool props spread into each registerService call
const _preprocEndpointProps = _preprocEndpointsList
  ? { endpoints: _preprocEndpointsList, poolStrategy: 'least-busy' }
  : { endpoint: _preprocEndpoint };

async function callPreproc(op, pngPath, opts = {}) {
  const res = await callPersistentServer('preprocess', PREPROC_PYTHON, PREPROC_SCRIPT, { op, path: pngPath, ...opts });
  if (res.error) throw new Error(`preprocess ${op}: ${res.error}`);
  return res.out_path;
}

// --- Register all preprocessors ---

registerService({
  id: 'deskew',
  type: 'preprocess',
  description: 'Correct page rotation and skew',
  ..._preprocEndpointProps,
  fixes: ['skew', 'rotation'],
  hurts: [],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('deskew', pngPath, opts),
});

registerService({
  id: 'despeckle',
  type: 'preprocess',
  description: 'Remove noise and speckle artifacts',
  ..._preprocEndpointProps,
  fixes: ['noise', 'speckle'],
  hurts: ['fine_detail'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('despeckle', pngPath, opts),
});

registerService({
  id: 'adaptive_threshold',
  type: 'preprocess',
  description: 'Adaptive binarization for uneven lighting and bleed-through',
  ..._preprocEndpointProps,
  fixes: ['low_contrast', 'uneven_lighting', 'bleed_through'],
  hurts: ['clean_images'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('adaptive_threshold', pngPath, opts),
});

registerService({
  id: 'normalize_contrast',
  type: 'preprocess',
  description: 'Normalize contrast for faded or low-contrast pages',
  ..._preprocEndpointProps,
  fixes: ['low_contrast', 'faded'],
  hurts: ['overexposed'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('normalize_contrast', pngPath, opts),
});

registerService({
  id: 'denoise_nlmeans',
  type: 'preprocess',
  description: 'Non-local means denoising for heavy noise',
  ..._preprocEndpointProps,
  fixes: ['heavy_noise'],
  hurts: [],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('denoise_nlmeans', pngPath, opts),
});

registerService({
  id: 'sharpen',
  type: 'preprocess',
  description: 'Unsharp mask sharpening for blurry or soft-focus pages',
  ..._preprocEndpointProps,
  fixes: ['blur', 'soft_focus'],
  hurts: ['noisy_images'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('sharpen', pngPath, opts),
});

registerService({
  id: 'binarize_sauvola',
  type: 'preprocess',
  description: 'Sauvola local binarization for shadow and uneven lighting',
  ..._preprocEndpointProps,
  fixes: ['uneven_lighting', 'shadow'],
  hurts: ['already_binary'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('binarize_sauvola', pngPath, opts),
});

registerService({
  id: 'remove_background',
  type: 'preprocess',
  description: 'Remove colored or textured background',
  ..._preprocEndpointProps,
  fixes: ['colored_background', 'texture'],
  hurts: [],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('remove_background', pngPath, opts),
});

registerService({
  id: 'invert',
  type: 'preprocess',
  description: 'Invert colors for inverted scans (white text on black)',
  ..._preprocEndpointProps,
  fixes: ['inverted_scan'],
  hurts: [],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('invert', pngPath, opts),
});

registerService({
  id: 'upscale_2x',
  type: 'preprocess',
  description: 'Cubic upscale 2x for low-resolution pages',
  ..._preprocEndpointProps,
  fixes: ['low_resolution'],
  hurts: ['already_high_res'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('upscale_2x', pngPath, opts),
});

registerService({
  id: 'extreme_binarize',
  type: 'preprocess',
  description: 'Aggressive global binarization — maximizes text/background separation. Destroys halftones.',
  ..._preprocEndpointProps,
  fixes: ['very_low_contrast', 'heavy_background_texture'],
  hurts: ['photos', 'halftone_images'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('extreme_binarize', pngPath, opts),
});

registerService({
  id: 'aggressive_denoise',
  type: 'preprocess',
  description: 'Heavy multi-pass noise removal. May blur fine strokes — throwaway copies only.',
  ..._preprocEndpointProps,
  fixes: ['heavy_noise', 'scanner_artifacts', 'film_grain'],
  hurts: ['fine_detail', 'thin_strokes'],
  throwawayOnly: true,
  cost: { tier: 0, label: 'deterministic_cpu', usdPer1000pages: 0, gpu: false },
  call: async (pngPath, op, opts) => callPreproc('aggressive_denoise', pngPath, opts),
});

// --- Legacy wrapper exports (callers of preprocessor-registry.js don't break) ---

export function registerPreprocessor(entry) {
  registerService({ ...entry, type: 'preprocess', ..._preprocEndpointProps,
    call: entry.call ?? (async (pngPath, op, opts) => callPreproc(entry.id, pngPath, opts)) });
}

export function getPreprocessor(id) { return getServices({ type: 'preprocess' }).find(s => s.id === id) ?? null; }

export function listPreprocessors() { return getServices({ type: 'preprocess' }); }

/** Return preprocessors that address any of the given defect tags, sorted by cost.tier. */
export function getPreprocessorsFor(defects = []) {
  return getServices({ type: 'preprocess' })
    .filter(p => defects.some(d => p.fixes?.includes(d)));
}
