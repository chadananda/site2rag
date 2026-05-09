// Snippet to inject into s5-vision.js before the s5Vision export.
// Multi-engine correction synthesis: numbered Tesseract words + alt texts → corrections JSON.

async function synthesizeWithCorrections(pngBuf, pageWords, altTexts, apiKey, domain, lang, model) {
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
      '- If Tesseract output is too garbled to fix word-by-word, return: {"full": "complete transcription in Arabic/Persian"}',
      '- If only some words need fixing: {"3": "corrected", "7": "corrected"}',
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
      'Example: {"3": "seven", "5": "ago"} — include only words that need changing.',
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
      if (typeof parsed.full === 'string') {
        fullText = parsed.full;
      } else {
        corrections = parsed;
      }
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
