// Pipeline config defaults, thresholds, escalation gates, LLM cost model.
// Exports: DEFAULT_CONFIG, mergeConfig, shouldRun, stagesForImportance, withinBudget, llmCost, MODEL_RATES, pLimit
//   DEFAULT_CONFIG                            — all defaults (stages,thresholds,escalation,implementations)
//   mergeConfig(overrides) → config           — deep-merge over defaults; caller values win
//   shouldRun(stage, ctx) → bool              — checks skip list + importance gates
//   stagesForImportance(importance, cfg) → [] — filtered stage list
//   withinBudget(ctx, additionalTokens?) → bool
//   llmCost(model, tokensIn, tokensOut) → usd — uses MODEL_RATES
//   MODEL_RATES = {model:[$/M_in, $/M_out]}

/** Canonical pricing table: $/million tokens [input, output]. Update when Anthropic reprices. */
export const MODEL_RATES = {
  'claude-haiku-4-5-20251001':  [0.80,  4.00],
  'claude-haiku-3-5-20241022':  [0.80,  4.00],
  'claude-sonnet-4-6':          [3.00, 15.00],
  'claude-sonnet-4-5-20251001': [3.00, 15.00],
  'claude-opus-4-7':            [15.00, 75.00],
  'mistral-ocr-latest':         [1.00,  1.00],
};

/** Compute API cost in USD from model name and token counts. */
export const llmCost = (model, tokensIn, tokensOut) => {
  const [inRate, outRate] = MODEL_RATES[model] ?? [3.00, 15.00];
  return (tokensIn || 0) / 1e6 * inRate + (tokensOut || 0) / 1e6 * outRate;
};

export const DEFAULT_CONFIG = {
  // Which stages to run (remove entries to skip permanently; use ctx.config.skip for per-run skips)
  stages: ['s0', 's1', 's2', 's3', 's4', 's5', 's7', 's8'],

  // Per-run skip list (set dynamically, e.g. by s0 for already-good docs)
  skip: [],

  // Quality thresholds — tune these based on historical receipt data
  thresholds: {
    goodDoc: 0.75,        // composite score: skip heavy stages if already above this
    cleanPage: 0.90,      // tesseract word confidence: above = no correction needed
    fuzzyWord: 0.60,      // tesseract confidence: [fuzzyWord, cleanPage) = spell-fix candidate
    dirtyWord: 0.40,      // tesseract confidence: below = vision escalation candidate
    spellFixMin: 0.45,    // don't spell-fix if baseline composite < this (too broken for cheap fix)
    visionMin: 0.10,      // don't vision-escalate if composite > this (not degraded enough to justify cost)
  },

  // Escalation gates: minimum importance level to unlock each capability
  // importance 0=trash, 1=low, 2=normal, 3=important, 4=critical, 5=archival
  escalation: {
    preprocessing: 0,     // always try preprocessing
    regionClassify: 1,    // classify regions from importance 1+
    paddleocr: 1,         // PaddleOCR for Arabic/Persian
    localVision: 1,       // boss vision model
    suryaVision: 2,       // surya OCR service (free, good for Arabic/CJK)
    cloudVision: 99,      // Cloud vision disabled by default — treat as failure, not fallback
    multiModel: 4,        // run all models + consensus
    domainRag: 3,         // match against known corpus
    humanReview: 5,       // flag for Transkribus / human HTR
  },

  // Implementation choices per capability — first available wins.
  // Swap entries to A/B test new approaches; receipts record which was used.
  implementations: {
    binarization: ['sauvola', 'otsu'],
    arabicOcr: ['paddleocr', 'tesseract-ara'],
    persianOcr: ['paddleocr', 'tesseract-fas'],
    spellfix: ['claude-haiku-4-5-20251001'],
    regionClassify: ['haiku'],
    vision: ['boss', 'surya', 'azure', 'google', 'claude-opus-4-7'],
    deskew: ['imagemagick', 'opencv'],
  },

  // Vision quality gate: run s5 multi-engine synthesis on all pages below this confidence.
  // 1.0 = run on any page with even one word below 100% confidence (effectively all scanned pages).
  // This is our core value: cheap Haiku synthesis of multiple OCR engines beats any single engine.
  visionQualityGate: 1.0,

  // Token budget: null = unlimited; set to a number to hard-cap LLM spend
  maxTokenBudget: null,

  // If true, stop pipeline on first stage error; if false, log and continue
  failFast: false,

  // API keys (injected at runtime, not stored here)
  apiKey: null,        // Anthropic API key
  azureKey: null,      // Azure Document Intelligence key
  azureEndpoint: null, // e.g. https://my-resource.cognitiveservices.azure.com
  googleKey: null,     // Google Cloud Vision API key

  // External service URLs
  bossUrl: process.env.LOCAL_LLM ?? 'http://boss.taile945b3.ts.net:49800/v1',
  markerUrl: process.env.MARKER_URL ?? 'http://localhost:7842',

  // Worker pool registry — pipeline-server URL for /workers endpoint
  registryUrl: process.env.PIPELINE_URL ?? 'http://localhost:49900',

  // Tool routing: 'workerPool' picks least-loaded worker via /tools/run API; falls back to local.
  // Workers expose all tools through their HTTP API — paths must be reachable (NFS or same host).
  toolBackends: {
    // Slow CPU tools — distribute page-by-page across all NFS-accessible workers
    tesseract:    { type: 'workerPool' }, // OCR — main bottleneck; split every page call
    // GPU tools — route to machines with GPU acceleration
    surya_ocr:    { type: 'local' },      // local: passes directory paths that workers can't access remotely
    easyocr_ocr:  { type: 'workerPool' }, // GPU batch engine
    paddle_ocr:   { type: 'workerPool' }, // GPU batch engine (boss CUDA preferred)
    doctr_ocr:    { type: 'workerPool' }, // GPU batch engine
    kraken_ocr:   { type: 'workerPool' }, // CPU/GPU batch engine
    // pdftoppm, gs, unpaper intentionally omitted — fast enough locally, no benefit distributing
  },
};

/**
 * Deep-merge caller config over defaults. Caller values win except for arrays
 * (skip, implementations) which are replaced entirely if provided.
 */
export const mergeConfig = (overrides = {}) => {
  const cfg = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds },
    escalation: { ...DEFAULT_CONFIG.escalation },
    implementations: { ...DEFAULT_CONFIG.implementations } };
  if (overrides.thresholds) Object.assign(cfg.thresholds, overrides.thresholds);
  if (overrides.escalation) Object.assign(cfg.escalation, overrides.escalation);
  if (overrides.implementations) Object.assign(cfg.implementations, overrides.implementations);
  const { thresholds, escalation, implementations, ...rest } = overrides;
  return { ...cfg, ...rest };
};

/** Return the stage list filtered to what's appropriate for this importance level. */
export const stagesForImportance = (importance, config = DEFAULT_CONFIG) => {
  const base = (config.stages ?? DEFAULT_CONFIG.stages).filter(s => !(config.skip ?? []).includes(s));
  if (importance < config.escalation.regionClassify) return base.filter(s => s !== 's2');
  return base;
};

/** Should this pipeline run this stage? Checks skip list + importance gates. */
export const shouldRun = (stage, ctx) => {
  if ((ctx.config.skip ?? []).includes(stage)) return false;
  const minImportance = {
    s2: ctx.config.escalation?.regionClassify,
    s4: ctx.config.escalation?.preprocessing,
    s5: ctx.config.escalation?.localVision,
  }[stage];
  if (minImportance !== undefined && ctx.importance < minImportance) return false;
  return true;
};

/** Check if LLM token budget would be exceeded by adding more tokens. */
export const withinBudget = (ctx, additionalTokens = 0) => {
  if (!ctx.config.maxTokenBudget) return true;
  const used = ctx.metrics.stages.reduce((s, x) => s + (x.tokens_in ?? 0) + (x.tokens_out ?? 0), 0);
  return used + additionalTokens <= ctx.config.maxTokenBudget;
};

/** Concurrency limiter. Usage: const lim = pLimit(8); await Promise.all(items.map(x => lim(() => fn(x)))) */
export function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const tick = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(v => { active--; resolve(v); tick(); }, e => { active--; reject(e); tick(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); tick(); });
}
