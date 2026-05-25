// Scores and selects/merges OCR results. Synthesis is correction, not just selection.
// Exports: judgeResults, scoreOutput
// Deps: config.js (llmCost), @anthropic-ai/sdk (for synthesis call)

import Anthropic from '@anthropic-ai/sdk';
import { llmCost } from './config.js';

const SYNTHESIS_MODEL = 'claude-haiku-4-5-20251001';

// Arabic/Persian unicode block ranges
const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/**
 * Score OCR output quality 0-1.
 * text: string output; words: word objects with conf (or null); lang: language code
 */
export function scoreOutput(text, words, lang) {
  if (!text || text.trim().length === 0) return 0;
  const trimmed = text.trim();
  const isArabicLang = ['ar', 'fa', 'ara', 'fas', 'he'].includes(lang);
  // Script validity: Arabic/Persian char ratio
  let scriptScore = 0.5;
  if (isArabicLang) {
    const arabicChars = (trimmed.match(ARABIC_RANGE) ?? []).length;
    const totalAlpha = (trimmed.match(/\S/g) ?? []).length;
    scriptScore = totalAlpha > 0 ? Math.min(1, arabicChars / totalAlpha * 1.5) : 0;
  } else {
    // For latin: penalize high ratio of non-latin chars (OCR garbage)
    const nonLatin = (trimmed.match(/[^\u0000-\u024F\s\d\p{P}]/gu) ?? []).length;
    const total = (trimmed.match(/\S/g) ?? []).length;
    scriptScore = total > 0 ? Math.max(0, 1 - (nonLatin / total) * 2) : 0;
  }
  // Word confidence average (if available from engines with conf scores)
  let confScore = 0.6; // neutral if no word-level confidence
  if (words && words.length > 0 && words[0].conf !== undefined) {
    const avgConf = words.reduce((s, w) => s + (w.conf ?? 0), 0) / words.length;
    confScore = avgConf / 100;
  }
  // Word count plausibility: penalize empty or suspiciously short
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const countScore = wordCount < 3 ? wordCount / 3 * 0.5 : wordCount > 5 ? 1 : 0.7;
  // Consistency: does script match language?
  const consistencyScore = scriptScore;
  return (scriptScore * 0.35 + confScore * 0.30 + countScore * 0.20 + consistencyScore * 0.15);
}

/**
 * Build synthesis prompt for multi-engine correction via image ground truth.
 */
function buildSynthesisPrompt(engineOutputs) {
  const lines = engineOutputs.map(e => `${e.engine.toUpperCase()}: ${e.text || '(empty)'}`).join('\n');
  return `You are an expert OCR editor. Multiple OCR engines read this page and produced these outputs:\n${lines}\n\nLook at the page image. Using the image as ground truth:\n- Where engines agree and the image confirms: keep as-is\n- Where engines disagree: check the image and write the correct text\n- Where OCR artifacts are obvious (VVhy→Why, 0→O, l→1 etc.): correct them\n- Do not add or remove content not visible in the image\n\nReturn ONLY the corrected text. No commentary.`;
}

/**
 * Judge all branch results, select or synthesize the best output.
 * branchResults: [{ branchId, engineOutputs: [{engine, text, words}] }]
 * lang: language code
 * pngBuf: Buffer of page image (for synthesis vision call)
 * apiKey: Anthropic API key (null = no synthesis)
 * ctx: pipeline context for logging
 */
export async function judgeResults(branchResults, lang, pngBuf, apiKey, ctx) {
  if (!branchResults || branchResults.length === 0)
    return { text: '', words: null, score: 0, source: 'none', rationale: 'no branches' };
  // Score each branch's best engine output
  const scored = branchResults.map(branch => {
    const outputs = branch.engineOutputs ?? [];
    const best = outputs.reduce((top, eo) => {
      const s = scoreOutput(eo.text, eo.words, lang);
      return s > top.score ? { ...eo, score: s } : top;
    }, { score: -1, text: '', words: null, engine: 'none' });
    return { branchId: branch.branchId, best, allOutputs: outputs };
  });
  scored.sort((a, b) => b.best.score - a.best.score);
  const top = scored[0];
  const topScore = top.best.score;
  // Log decision
  const decisionKey = `judge_p${ctx?.pageNo ?? 0}`;
  if (ctx?.metrics?.decisions) {
    ctx.metrics.decisions[decisionKey] = {
      topBranch: top.branchId, topScore,
      allScores: scored.map(s => ({ branch: s.branchId, score: s.best.score, engine: s.best.engine })),
    };
  }
  // Fast accept: clear winner
  if (topScore > 0.7) {
    return { text: top.best.text, words: top.best.words, score: topScore,
             source: `${top.branchId}/${top.best.engine}`, rationale: `clear winner score=${topScore.toFixed(2)}`, winningBranch: top.branchId };
  }
  // Synthesis: multiple branches close in score — use vision + all outputs
  const second = scored[1];
  const shouldSynthesize = second && Math.abs(topScore - second.best.score) < 0.1 && apiKey && pngBuf;
  if (shouldSynthesize) {
    try {
      const allOutputs = scored.flatMap(s => s.allOutputs).filter(o => o.text);
      const client = new Anthropic({ apiKey });
      const pngB64 = pngBuf.toString('base64');
      const msg = await client.messages.create({
        model: SYNTHESIS_MODEL,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
            { type: 'text', text: buildSynthesisPrompt(allOutputs) },
          ],
        }],
      });
      const synthesized = msg.content?.[0]?.text ?? top.best.text;
      const synthScore = scoreOutput(synthesized, null, lang);
      const cost = llmCost(SYNTHESIS_MODEL, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
      if (ctx?.metrics?.decisions) ctx.metrics.decisions[`${decisionKey}_synthesis`] = { cost, synthScore };
      return { text: synthesized, words: null, score: synthScore, source: 'synthesis',
               rationale: `synthesized from ${allOutputs.length} engines; cost=$${cost.toFixed(4)}`, winningBranch: top.branchId };
    } catch (e) {
      process.stderr.write(`[judge] synthesis failed: ${e.message}\n`);
    }
  }
  // Escalation flag: score too low
  const escalationThreshold = ctx?.strategy?.escalationThreshold ?? 0.55;
  const needsEscalation = topScore < escalationThreshold;
  if (ctx?.metrics?.decisions) ctx.metrics.decisions[`${decisionKey}_escalation`] = needsEscalation;
  return { text: top.best.text, words: top.best.words, score: topScore,
           source: `${top.branchId}/${top.best.engine}`,
           rationale: `best available score=${topScore.toFixed(2)}${needsEscalation ? ' [ESCALATE]' : ''}`,
           winningBranch: top.branchId, needsEscalation };
}
