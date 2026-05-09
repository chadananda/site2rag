// Vision analysis of low-quality OCR pages. Sends page PNG + OCR text to Haiku Vision.
// Exports: analyzePageQuality, synthesizeInsights
// Deps: Anthropic SDK, pipeline tmp dir

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';

const client = new Anthropic();

const ANALYSIS_PROMPT = `You are an expert in document scanning, OCR, and image processing.

I'll show you a scanned document page and its OCR text output. The OCR quality was poor (score below 60%).

Analyze what went wrong and suggest specific improvements. Consider:
1. Image quality issues (contrast, brightness, bleed-through from opposite side, noise, skew)
2. OCR engine configuration (resolution, language, preprocessing flags)
3. Document characteristics (handwritten vs printed, historical typeface, column layout)
4. What preprocessing would help most (contrast stretch, binarization, despeckling, deskewing)

Respond in JSON with exactly this structure:
{
  "primary_issue": "one sentence describing the main problem",
  "image_issues": ["list", "of", "image", "quality", "problems"],
  "suggestions": ["specific", "actionable", "improvements"],
  "escalate_to_vision": true/false,
  "estimated_improvement": "low/medium/high if suggestions are applied"
}`;

/** Send a page PNG + its OCR words to Haiku Vision for analysis. Returns parsed JSON or null. */
export async function analyzePageQuality(pngPath, ocrWords, pageNo, apiKey) {
  if (!existsSync(pngPath)) return null;

  try {
    const imageData = readFileSync(pngPath).toString('base64');
    const ocrSample = ocrWords
      .slice(0, 100)
      .map(w => `${w.text}(${w.conf}%)`)
      .join(' ');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          { type: 'text', text: `Page ${pageNo} OCR output (first 100 words with confidence):\n${ocrSample || '(no words detected)'}\n\n${ANALYSIS_PROMPT}` }
        ]
      }]
    });

    const text = response.content[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { primary_issue: text.slice(0, 200), suggestions: [], escalate_to_vision: false };
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { primary_issue: `Analysis failed: ${e.message}`, suggestions: [], escalate_to_vision: false };
  }
}

/** Use Haiku to synthesize patterns across multiple page analyses into strategy insights. */
export async function synthesizeInsights(analyses, category, language) {
  if (!analyses.length) return [];
  const summary = analyses.map((a, i) =>
    `Run ${i+1} (${a.variant_id}, score=${a.page_score?.toFixed(2)}): ${a.vision_analysis}`
  ).join('\n\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `I ran multiple OCR pipeline variants on ${language} ${category} documents and got these vision analyses:\n\n${summary}\n\nSynthesize the key patterns into 3-5 specific, actionable pipeline improvement rules. Format as JSON array of strings.`
      }]
    });

    const text = response.content[0]?.text ?? '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return [text.slice(0, 400)];
  } catch {
    return [];
  }
}
