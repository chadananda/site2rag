// Haiku/Sonnet synthesis: page image + OCR words → corrected text. Two modes:
//   synthesizeViaHaiku: image + tesseract words → corrected markdown
//   synthesizeWithCorrections: image + tesseract words + alt-engine texts → corrections JSON → merged text
// Exports: computeSynthesisQuality, synthesizeViaHaiku, synthesizeWithCorrections
// Deps: config.js (llmCost), @anthropic-ai/sdk

import { llmCost } from '../config.js';

// Score Haiku synthesis output: script-aware, not dependent on poor OCR prior.
export function computeSynthesisQuality(visionMd, lang) {
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

export async function synthesizeViaHaiku(pngBuf, pageWords, apiKey, domain, lang, model) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const MODEL = model ?? 'claude-haiku-4-5-20251001';
  const ocrText = (pageWords ?? []).map(w => w.text).join(' ').trim();
  const domainCtx = domain?.prompt_context ? '\nDocument context: ' + domain.prompt_context : '';
  const ocrBlock = ocrText || '(no text detected)';
  const isArabicScript = lang === 'ara' || lang === 'fas';
  const arabicPrompt = [
    'You are an expert in historical Arabic and Persian manuscript transcription, specializing in 19th-20th century calligraphy.',
    'This page is from a handwritten manuscript. Transcribe ALL visible text in Arabic/Persian script (right-to-left).',
    '',
    'CRITICAL RULES:',
    '1. Always output in Arabic/Persian script (Unicode). NEVER transliterate to Latin letters or write English words.',
    '2. If a word is partially legible, write your best reading in Arabic script — do not skip it.',
    '3. Only use [illegible] for full words/lines that are completely unreadable.',
    '4. Include all text visible: main body, titles, marginal notes, annotations, numbers.',
    '5. Output ONLY the transcribed Arabic/Persian text. Zero English commentary or explanations.',
  ].join('\n');
  const basePrompt = isArabicScript
    ? arabicPrompt
    : 'You are an expert OCR correction model. Look at the page image carefully. Correct any OCR errors. Preserve document structure. If the OCR missed text visible in the image, add it. If OCR hallucinated text not in the image, remove it. Output ONLY the corrected text in clean Markdown. No commentary.';
  const prompt = basePrompt + domainCtx + (ocrText ? '\n\nOCR output for reference (may contain errors):\n<ocr_output>\n' + ocrBlock + '\n</ocr_output>' : '');
  const b64 = pngBuf.toString('base64');
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 2048,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const text = msg.content.map(b => b.type === 'text' ? b.text : '').join('');
  const cost = llmCost(MODEL, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
  return { text, tokens_in: msg.usage?.input_tokens ?? 0, tokens_out: msg.usage?.output_tokens ?? 0, cost };
}

// Multi-engine correction synthesis.
// Sends numbered primary-OCR words + alt-engine text blobs to Haiku.
// Haiku returns only corrections: {wordId: correctedText}.
// For Arabic/Persian, also accepts full-transcription response {full: ...}.
export async function synthesizeWithCorrections(pngBuf, pageWords, altTexts, apiKey, domain, lang, model) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const MODEL = model ?? 'claude-haiku-4-5-20251001';
  const isArabicScript = lang === 'ara' || lang === 'fas';
  // Build numbered word dict from primary OCR (Tesseract)
  const wordDict = {};
  (pageWords ?? []).forEach((w, i) => { wordDict[i + 1] = w.text; });
  const wordJson = JSON.stringify(wordDict);
  const domainCtx = domain?.prompt_context ? ('\nDocument context: ' + domain.prompt_context) : '';
  // Build alt text block from secondary engines
  const altLines = Object.entries(altTexts ?? {})
    .filter(([, t]) => t && t.trim())
    .map(([engine, text]) => engine.toUpperCase() + ': ' + text.slice(0, 800));
  const altBlock = altLines.length > 0
    ? ('\n\nAlternative OCR readings:\n' + altLines.join('\n'))
    : '';
  let prompt;
  if (isArabicScript) {
    prompt = [
      'You are an expert in Arabic and Persian manuscript transcription (19th-20th century calligraphy).',
      'CRITICAL: Always output in Arabic/Persian Unicode script. NEVER use Latin letters.',
      '',
      'Primary OCR numbered fragments (may be garbled by Tesseract):',
      wordJson,
      altBlock,
      domainCtx,
      '',
      'Look at the page image carefully. Return a JSON object:',
      '- If Tesseract output is too garbled to fix word-by-word, return: {full: complete transcription in Arabic/Persian}',
      '- If only some words need fixing: {3: corrected, 7: corrected}',
      '- If nothing needs fixing: {}',
      'OUTPUT ONLY valid JSON. No other text.',
    ].join('\n');
  } else {
    prompt = [
      'You are an expert OCR correction model.',
      'Primary OCR produced these numbered words:',
      wordJson,
      altBlock,
      domainCtx,
      '',
      'Look at the page image and alternative readings. Return ONLY corrections as a JSON object.',
      'Example: {3: seven, 5: ago} — include only words that need changing.',
      'No corrections needed: return {}',
      'OUTPUT ONLY valid JSON. No other text.',
    ].join('\n');
  }
  const b64 = pngBuf.toString('base64');
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const rawText = msg.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  const cost = llmCost(MODEL, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
  // Parse the corrections JSON
  let corrections = {};
  let fullText = null;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.full === 'string') fullText = parsed.full;
      else corrections = parsed;
    }
  } catch { /* treat as no corrections */ }
  // Apply corrections to build result text
  let resultText;
  if (fullText) {
    resultText = fullText.trim();
  } else {
    const corrected = Object.assign({}, wordDict);
    for (const [id, text] of Object.entries(corrections)) {
      if (corrected[id] !== undefined) corrected[id] = text;
    }
    resultText = Object.values(corrected).join(' ').trim();
  }
  return {
    text: resultText,
    tokens_in: msg.usage?.input_tokens ?? 0,
    tokens_out: msg.usage?.output_tokens ?? 0,
    cost,
    corrections_applied: fullText ? 'full_transcription' : Object.keys(corrections).length,
  };
}
