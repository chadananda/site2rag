// OCR reconciler -- confidence-aware merge, Levenshtein agreement, Claude reconciler calls.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { logLlmCall, llmCost } from '../db.js';
/** Normalized Levenshtein distance between two strings (0=identical, 1=completely different). */
const levenshtein = (a, b) => {
  const la = a.length, lb = b.length;
  if (!la) return lb ? 1 : 0;
  if (!lb) return 1;
  const dp = Array.from({ length: la + 1 }, (_, i) => [i, ...Array(lb).fill(0)]);
  for (let j = 1; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[la][lb] / Math.max(la, lb);
};
/** Compute normalized agreement score between two markdown strings (1=identical). */
const agreementScore = (a, b) => {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return 1 - levenshtein(norm(a), norm(b));
};
/** Compute pairwise agreement across all engine results. Returns min agreement. */
export const computeAgreement = (results) => {
  if (results.length < 2) return 1;
  let minAgreement = 1;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const score = agreementScore(results[i].text_md, results[j].text_md);
      if (score < minAgreement) minAgreement = score;
    }
  }
  return minAgreement;
};
/** Pick highest-confidence engine result. */
const pickBestEngine = (results) => results.reduce((best, r) => r.confidence > best.confidence ? r : best, results[0]);
/** Build reconciler prompt. */
const buildReconcilerPrompt = (engineResults, passBboxes) => {
  const transcripts = engineResults.map(r => ({
    name: r.engine,
    transcript: r.text_md,
    confidence: r.confidence,
    ...(passBboxes && r.bboxes_json ? { bboxes: JSON.parse(r.bboxes_json || '[]') } : {})
  }));
  return `You are reconciling OCR transcripts from multiple engines for a single document page.
Engine results: ${JSON.stringify(transcripts)}
Task: Produce canonical Markdown for this page. Preserve headings, lists, tables, and paragraph order. Weight engines by confidence. Verify against the image. Wrap unresolvable spans in <!-- unresolved: ... -->.
Return strict JSON: {"markdown": "...", "agreement_score": 0.0-1.0, "unresolved_spans": ["..."]}`;
};
/**
 * Reconcile multiple OCR engine results for a page. Applies short-circuit logic.
 * Returns { text_md, agreement_score, conversion_method, unresolved_spans }.
 * @param {object} db - Site SQLite db
 * @param {string} docUrl - Source document URL
 * @param {number} pageNo - 1-based page number
 * @param {string} pngPath - Path to page PNG
 * @param {Array} engineResults - Array of { engine, text_md, confidence, bboxes_json }
 * @param {object} ocrConfig - OCR config from siteConfig
 * @param {object} llmProviders - LLM providers config
 */
export const reconcilePage = async (db, docUrl, pageNo, pngPath, engineResults, ocrConfig, llmProviders = {}) => {
  const valid = engineResults.filter(r => r.text_md && r.text_md.length > 0);
  if (!valid.length) return { text_md: '', agreement_score: 0, conversion_method: 'ocr+no-results', unresolved_spans: [] };
  if (valid.length === 1) return { text_md: valid[0].text_md, agreement_score: 1, conversion_method: `ocr+single:${valid[0].engine}`, unresolved_spans: [] };
  const agreement = computeAgreement(valid);
  const maxConfidence = Math.max(...valid.map(r => r.confidence));
  const agreementThreshold = ocrConfig.agreement_skip_threshold ?? 0.97;
  const confidenceThreshold = ocrConfig.confidence_skip_threshold ?? 0.92;
  // Short-circuit: skip reconciler when agreement and confidence both above threshold
  if (agreement >= agreementThreshold && maxConfidence >= confidenceThreshold) {
    const best = pickBestEngine(valid);
    return { text_md: best.text_md, agreement_score: agreement, conversion_method: 'ocr+confidence-merge', unresolved_spans: [] };
  }
  // Vote mode: skip reconciler
  if (ocrConfig.mode === 'vote') {
    const best = pickBestEngine(valid);
    return { text_md: best.text_md, agreement_score: agreement, conversion_method: 'ocr+vote', unresolved_spans: [] };
  }
  // Call reconciler (Claude by default)
  const reconcilerName = ocrConfig.reconciler || 'claude';
  const reconcilerCfg = llmProviders[reconcilerName];
  const apiKey = process.env[reconcilerCfg?.api_key_env || 'ANTHROPIC_API_KEY'];
  if (!apiKey) {
    const best = pickBestEngine(valid);
    return { text_md: best.text_md, agreement_score: agreement, conversion_method: 'ocr+vote-fallback', unresolved_spans: [] };
  }
  const client = new Anthropic({ apiKey });
  const model = reconcilerCfg?.models?.vision || 'claude-opus-4-7';
  const prompt = buildReconcilerPrompt(valid, ocrConfig.pass_bounding_boxes ?? true);
  const imgBase64 = readFileSync(pngPath).toString('base64');
  let result, ok = 1, tokens_in = 0, tokens_out = 0;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgBase64 } }, { type: 'text', text: prompt }] }]
    });
    tokens_in = msg.usage.input_tokens;
    tokens_out = msg.usage.output_tokens;
    const raw = msg.content.find(b => b.type === 'text')?.text || '{}';
    result = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, ''));
  } catch (err) {
    ok = 0;
    console.error(`[reconcile] page ${pageNo} reconciler failed: ${err.message}`);
    const best = pickBestEngine(valid);
    return { text_md: best.text_md, agreement_score: agreement, conversion_method: 'ocr+vote-fallback', unresolved_spans: [] };
  }
  logLlmCall(db, { stage: 'ocr_reconcile', url: docUrl, page_no: pageNo, provider: reconcilerName, model, tokens_in, tokens_out, cost_usd: llmCost(model, tokens_in, tokens_out), ok });
  return {
    text_md: result.markdown || '',
    agreement_score: result.agreement_score ?? agreement,
    conversion_method: 'ocr+reconcile',
    unresolved_spans: result.unresolved_spans || []
  };
};
