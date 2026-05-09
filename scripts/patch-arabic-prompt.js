#!/usr/bin/env node
// Patch s5-vision.js: improve Arabic/Persian manuscript prompt.
// Current prompt doesn't explicitly forbid English fallback —
// Haiku sometimes produces English descriptions instead of Arabic transcription,
// causing near-zero Arabic Unicode ratio on those pages.
//
// Run: node patch-arabic-prompt.js (on the server as root or chad)

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const PATH = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = readFileSync(PATH, 'utf8');

const oldPrompt = `  const isArabicScript = lang === 'ara' || lang === 'fas';
  const basePrompt = isArabicScript
    ? 'You are an expert in Arabic and Persian manuscript transcription. Carefully transcribe all handwritten and printed Arabic/Persian text from this document page. Preserve paragraph breaks. Mark truly illegible words as [illegible]. Output only the transcribed text in clean Markdown. No commentary.'
    : 'You are an expert OCR correction model. Look at the page image carefully. Correct any OCR errors. Preserve document structure. If the OCR missed text visible in the image, add it. If OCR hallucinated text not in the image, remove it. Output ONLY the corrected text in clean Markdown. No commentary.';`;

const newPrompt = `  const isArabicScript = lang === 'ara' || lang === 'fas';
  const arabicPrompt = [
    'You are an expert in historical Arabic and Persian manuscript transcription, specializing in 19th–20th century calligraphy.',
    'This page is from a handwritten manuscript. Transcribe ALL visible text in Arabic/Persian script (right-to-left).',
    '',
    'CRITICAL RULES:',
    '1. Always output in Arabic/Persian script (Unicode). NEVER transliterate to Latin letters or write English words.',
    '2. If a word is partially legible, write your best reading in Arabic script — do not skip it.',
    '3. Only use [illegible] for full words/lines that are completely unreadable.',
    '4. Include all text visible: main body, titles, marginal notes, annotations, numbers.',
    '5. Output ONLY the transcribed Arabic/Persian text. Zero English commentary or explanations.',
  ].join('\\n');
  const basePrompt = isArabicScript
    ? arabicPrompt
    : 'You are an expert OCR correction model. Look at the page image carefully. Correct any OCR errors. Preserve document structure. If the OCR missed text visible in the image, add it. If OCR hallucinated text not in the image, remove it. Output ONLY the corrected text in clean Markdown. No commentary.';`;

if (src.includes(oldPrompt)) {
  src = src.replace(oldPrompt, newPrompt);
  console.log('Updated Arabic manuscript prompt');
} else {
  console.log('ERROR: old prompt not found — may already be patched or code changed');
  process.exit(1);
}

writeFileSync(PATH, src);

try {
  execFileSync('node', ['--check', PATH]);
  console.log('Syntax OK');
} catch (e) {
  console.error('SYNTAX ERROR:', e.message);
  process.exit(1);
}

console.log('Done. Restart pipeline-server to pick up changes.');
