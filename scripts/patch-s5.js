#!/usr/bin/env node
// Patch s5-vision.js: fix quality recording and improve Arabic synthesis prompt
const fs = require('fs');
const path = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = fs.readFileSync(path, 'utf8');

// 1. Add computeSynthesisQuality function before synthesizeViaHaiku
const qualityFn = `
// Score Haiku synthesis output: script-aware, not dependent on poor OCR prior.
function computeSynthesisQuality(visionMd, lang) {
  if (!visionMd || !visionMd.trim()) return 0.30;
  const words = visionMd.trim().split(/\s+/).filter(Boolean).length;
  // Arabic/Persian: check for script presence as proxy for successful transcription
  if (lang === 'ara' || lang === 'fas') {
    const arabicChars = (visionMd.match(/[\u0600-\u06FF]/g) ?? []).length;
    const totalChars = visionMd.replace(/\s/g, '').length;
    if (totalChars > 0) {
      const arabicRatio = arabicChars / totalChars;
      if (arabicRatio > 0.4) return 0.72;
      if (arabicChars > 20) return 0.55;
    }
    return 0.35; // Haiku produced wrong-language output
  }
  if (words > 100) return 0.75;
  if (words > 30) return 0.65;
  if (words > 10) return 0.50;
  return 0.38;
}

`;

if (src.includes('function computeSynthesisQuality')) {
  console.log('computeSynthesisQuality already present — skipping insertion');
} else {
  src = src.replace('async function synthesizeViaHaiku(', qualityFn + 'async function synthesizeViaHaiku(');
  console.log('Inserted computeSynthesisQuality');
}

// 2. Improve synthesizeViaHaiku: domain-aware + Arabic handwriting prompt
const oldSig = 'async function synthesizeViaHaiku(pngBuf, pageWords, apiKey, domain) {';
const newSig = 'async function synthesizeViaHaiku(pngBuf, pageWords, apiKey, domain, lang) {';
if (src.includes(newSig)) {
  console.log('synthesizeViaHaiku already updated — skipping sig update');
} else {
  src = src.replace(oldSig, newSig);
  console.log('Updated synthesizeViaHaiku signature to include lang');
}

// Replace the prompt line with a conditional one
const arabicPromptBlock = `  const isArabicScript = lang === 'ara' || lang === 'fas';
  const basePrompt = isArabicScript
    ? 'You are an expert in Arabic and Persian manuscript transcription. Carefully transcribe all handwritten and printed Arabic/Persian text from this document page. Preserve paragraph breaks. Mark truly illegible words as [illegible]. Output only the transcribed text in clean Markdown. No commentary.'
    : 'You are an expert OCR correction model. Look at the page image carefully. Correct any OCR errors. Preserve document structure. If the OCR missed text visible in the image, add it. If OCR hallucinated text not in the image, remove it. Output ONLY the corrected text in clean Markdown. No commentary.';
  const prompt = basePrompt + domainCtx + (ocrText ? '\\n\\nOCR output for reference (may contain errors):\\n<ocr_output>\\n' + ocrBlock + '\\n</ocr_output>' : '');`;

const oldPromptRe = /  const prompt = 'You are an expert OCR correction model\.'.*?;/s;
if (src.match(oldPromptRe)) {
  src = src.replace(oldPromptRe, arabicPromptBlock);
  console.log('Replaced prompt with conditional Arabic/Latin version');
} else {
  console.log('WARNING: old prompt line not found — check manually');
}

// 3. Update call sites to pass lang
const oldCall1 = 'const result = await synthesizeViaHaiku(pngBuf, page.words, ctx.config.apiKey, ctx.domain);';
const newCall1 = 'const result = await synthesizeViaHaiku(pngBuf, page.words, ctx.config.apiKey, ctx.domain, page._lang);';
if (src.includes(oldCall1)) {
  src = src.replace(oldCall1, newCall1);
  console.log('Updated call site to pass lang');
} else if (src.includes(newCall1)) {
  console.log('Call site already updated');
} else {
  console.log('WARNING: call site not found — check manually');
}

// 4. Replace prior + 0.15 with computeSynthesisQuality
const oldQuality = `      if (pagesAffected > 0) {
        const prior = ctx.quality.baseline?.composite_score ?? 0;
        ctx.recordStageQuality('s5', Math.min(1, prior + 0.15));
      }`;
const newQuality = `      if (pagesAffected > 0) {
        // Compute quality from actual synthesis output (per-page, take average)
        let totalQ = 0, qCount = 0;
        for (const page of ctx.pages) {
          if (page.visionMd) { totalQ += computeSynthesisQuality(page.visionMd, page._lang); qCount++; }
        }
        const synthQuality = qCount > 0 ? totalQ / qCount : 0.40;
        ctx.recordStageQuality('s5', synthQuality);
      }`;
if (src.includes(oldQuality)) {
  src = src.replace(oldQuality, newQuality);
  console.log('Replaced prior+0.15 with computeSynthesisQuality');
} else if (src.includes('computeSynthesisQuality(page.visionMd')) {
  console.log('Quality recording already updated');
} else {
  console.log('WARNING: old quality recording block not found — check manually');
}

fs.writeFileSync(path, src);
console.log('Done. Wrote', path);
