// OCR strategy planner. Given page diagnostics + history, returns strategy JSON.
// CPU-first: cpuBranches run always in parallel; gpuBranches gated behind cpuAcceptThreshold.
// Exports: planStrategy, updatePageHistory
// Deps: engine-registry.js, preprocessor-registry.js
// Tier 2 (Haiku) synthesis is the floor for every block; Tier 3 escalates only post-synthesis failures.

import { getEnginesFor, getCpuEngines, getGpuEngines } from './engine-registry.js';
import { getPreprocessorsFor } from './preprocessor-registry.js';

// Normalize script-tag lang codes to ISO 639-1 for engine lookup
const LANG_NORM = { ara: 'ar', fas: 'fa', heb: 'he', zho: 'zh', jpn: 'ja', kor: 'ko', deu: 'de', fra: 'fr' };

/**
 * Plan OCR strategy for a page given diagnostics and document history.
 * diagnostics: { lang, skewAngle, blurScore, contrastMean, contrastStd, noiseLevel,
 *                scriptDetected, blockTypes, pageNo }
 * history: [{ pageNo, strategy, winningBranch, score, delta }]
 * availableEngines: string[] of engine ids to filter by (null = all)
 * budget: number (usd budget) or 'tight' | 'normal' | 'full'
 */
export function planStrategy(diagnostics, history = [], availableEngines = null, budget = 'normal') {
  const { lang: rawLang = 'en', skewAngle = 0, blurScore = 0, contrastMean = 0.5,
          contrastStd = 0.2, noiseLevel = 0, scriptDetected = 'latin',
          blockTypes = ['printed'], pageNo = 0 } = diagnostics;
  const lang = LANG_NORM[rawLang] ?? rawLang;
  const reasons = [];
  // --- Preprocessor selection ---
  const defects = [];
  if (Math.abs(skewAngle) > 1.5) { defects.push('skew'); reasons.push(`skew ${skewAngle.toFixed(1)}°`); }
  if (blurScore > 0.7) { defects.push('blur'); reasons.push(`blur ${blurScore.toFixed(2)}`); }
  if (contrastMean < 0.3) { defects.push('low_contrast', 'faded'); reasons.push(`low contrast ${contrastMean.toFixed(2)}`); }
  else if (contrastMean < 0.4) { defects.push('low_contrast', 'uneven_lighting'); reasons.push(`contrast ${contrastMean.toFixed(2)}`); }
  if (noiseLevel > 0.5) { defects.push('heavy_noise'); reasons.push(`noise ${noiseLevel.toFixed(2)}`); }
  const preprocessors = getPreprocessorsFor(defects).map(p => p.id);
  // Always deskew if any skew detected, as first step
  if (Math.abs(skewAngle) > 1.5 && !preprocessors.includes('deskew'))
    preprocessors.unshift('deskew');
  // --- Engine pools: filter by availability, then split by GPU ---
  const isArabicScript = ['ar', 'fa', 'he', 'ara', 'fas'].includes(rawLang) || scriptDetected === 'arabic' || scriptDetected === 'rtl';
  const primaryBlockType = blockTypes[0] ?? 'printed';
  const ranked = getEnginesFor(lang, primaryBlockType)
    .filter(e => e.tier <= 1)  // only local engines for branch planning
    .filter(e => !availableEngines || availableEngines.includes(e.id));
  const rankedCpuIds = ranked.filter(e => e.cost.gpu === false || e.tier === 0).map(e => e.id);
  const rankedGpuIds = ranked.filter(e => e.tier === 1 && e.cost.gpu === true).map(e => e.id);
  // --- Within-document learning: check consistent winner ---
  const recentHistory = history.slice(-10);
  const winnerCounts = {};
  for (const h of recentHistory) { winnerCounts[h.winningBranch] = (winnerCounts[h.winningBranch] ?? 0) + 1; }
  const dominantWinner = Object.entries(winnerCounts).find(([, cnt]) => cnt >= 3);
  // --- Difficulty assessment: drives synthModel selection ---
  const difficultyScore = (
    (Math.abs(skewAngle) > 3 ? 0.2 : 0) +
    (blurScore > 0.7 ? 0.2 : 0) +
    (contrastMean < 0.3 ? 0.2 : 0) +
    (noiseLevel > 0.5 ? 0.15 : 0) +
    (isArabicScript ? 0.1 : 0) +
    (blockTypes.includes('handwritten') ? 0.15 : 0)
  );
  const veryDifficult = difficultyScore > 0.7;
  const synthModel = veryDifficult ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  if (veryDifficult) reasons.push(`very difficult (score ${difficultyScore.toFixed(2)}) → sonnet synthesis`);
  const isTight = budget === "tight" || (typeof budget === "number" && budget < 1);
  // --- CPU/GPU branch construction ---
  let cpuBranches;
  let gpuBranches = [];
  if (isTight) {
    // Single CPU branch only, no GPU
    const engines = rankedCpuIds.slice(0, 1).length ? rankedCpuIds.slice(0, 1) : ['tesseract'];
    cpuBranches = [{ id: 'cpu_primary', engines: engines.filter(Boolean), label: 'primary' }];
    reasons.push('budget tight → single cpu branch, no gpu');
  } else if (dominantWinner) {
    // Collapse to winning branch
    const [winner] = dominantWinner;
    const lastWinStrat = [...recentHistory].reverse().find(h => h.winningBranch === winner);
    const engines = lastWinStrat?.strategy?.cpuBranches?.find(b => b.id === winner)?.engines
      ?? lastWinStrat?.strategy?.branches?.find(b => b.id === winner)?.engines
      ?? [rankedCpuIds[0] ?? 'tesseract'];
    cpuBranches = [{ id: 'cpu_primary', engines, label: `proven_${winner}` }];
    reasons.push(`consistent winner: ${winner} (${dominantWinner[1]} pages)`);
  } else if (isArabicScript) {
    // Arabic/Persian: tesseract + easyocr on CPU (both CPU-only); surya in GPU branch (gpu:true, arabic-capable)
    const cpuEngines = rankedCpuIds.slice(0, 2).length >= 1
      ? rankedCpuIds.slice(0, 2)
      : ['tesseract', 'easyocr'].filter(id => !availableEngines || availableEngines.includes(id));
    cpuBranches = [{ id: 'cpu_primary', engines: cpuEngines.filter(Boolean), label: 'cpu_arabic' }];
    // GPU: only Arabic-capable gpu engines (surya handles Arabic; doctr has limited Arabic)
    const arabicGpuEngines = rankedGpuIds.filter(id => {
      const e = ranked.find(r => r.id === id);
      return e && (e.strengths.includes('arabic_script') || e.strengths.includes('non_latin'));
    });
    if (arabicGpuEngines.length)
      gpuBranches = [{ id: 'gpu_arabic', engines: arabicGpuEngines, label: 'gpu_arabic' }];
    reasons.push(`Arabic/Persian script (${rawLang}): cpu=[${cpuEngines.join(',')}] gpu=[${arabicGpuEngines.join(',')}]`);
  } else {
    // Standard latin/mixed: all available CPU engines; all available GPU engines
    const cpuEngines = rankedCpuIds.slice(0, 3).length ? rankedCpuIds.slice(0, 3) : ['tesseract', 'easyocr', 'paddleocr'];
    cpuBranches = [{ id: 'cpu_primary', engines: cpuEngines, label: 'cpu_primary' }];
    if (rankedGpuIds.length)
      gpuBranches = [{ id: 'gpu_layout', engines: rankedGpuIds.slice(0, 2), label: 'gpu_layout' }];
    reasons.push(`standard latin/mixed: cpu=[${cpuEngines.join(',')}] gpu=[${rankedGpuIds.slice(0, 2).join(',')}]`);
  }
  const escalationThreshold = isArabicScript ? 0.45 : 0.55;
  return {
    preprocessors,
    cpuBranches,
    gpuBranches,
    cpuAcceptThreshold: 0.65,
    synthesize: true,
    synthModel,
    escalationThreshold,
    reasoning: reasons.join('; ') || 'default strategy',
  };
}

/**
 * Append a page result to history. Keeps last 10 entries.
 * Returns new history array.
 */
export function updatePageHistory(history = [], pageNo, strategy, winningBranch, score) {
  const delta = history.length > 0 ? score - (history[history.length - 1]?.score ?? 0) : 0;
  return [...history, { pageNo, strategy, winningBranch, score, delta }].slice(-10);
}
