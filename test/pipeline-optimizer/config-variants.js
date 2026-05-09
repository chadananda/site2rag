// Pipeline config variants to test. Each variant overrides the default pipeline config.
// The harness runs every doc through every variant and scores the result.
// Exports: VARIANTS (array), BASELINE_ID

export const BASELINE_ID = 'baseline';

export const VARIANTS = [
  {
    id: 'baseline',
    label: 'Baseline (300dpi, auto-contrast)',
    config: {},  // use pipeline defaults
  },
  {
    id: 'high_res',
    label: '600dpi rasterization',
    config: { rasterDpi: 600 },
  },
  {
    id: 'contrast_forced',
    label: 'Force contrast enhancement',
    config: { preprocessing: { forceContrast: true, bleedThreshold: 0.0, contrastThreshold: 1.0 } },
  },
  {
    id: 'otsu_only',
    label: 'Otsu binarization (bleed-through documents)',
    config: { preprocessing: { method: 'otsu', forceContrast: true } },
  },
  {
    id: 'low_escalate',
    label: 'Aggressive vision escalation (30% dirty threshold)',
    config: { thresholds: { dirtyPage: 0.30 } },
  },
  {
    id: 'high_res_contrast',
    label: '600dpi + forced contrast (combined)',
    config: { rasterDpi: 600, preprocessing: { forceContrast: true } },
  },
];
