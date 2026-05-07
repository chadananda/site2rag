#!/usr/bin/env node
// Inspect unpaper+convert output quality using Haiku vision.
// Rasterizes page 1 of a PDF, runs the full s1 preprocessing chain,
// sends before/after images to Haiku and reports readability assessment.
// Usage: ANTHROPIC_API_KEY=... node scripts/check-preprocess.js <pdf-path>

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const pdfPath = process.argv[2];
if (!pdfPath || !existsSync(pdfPath)) {
  console.error('Usage: ANTHROPIC_API_KEY=... node scripts/check-preprocess.js <pdf-path>');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const SURYA_PATH = process.env.SURYA_PATH ?? 'surya_ocr';
const client = new Anthropic();
const hash = createHash('sha1').update(pdfPath).digest('hex').slice(0, 12);
const base = join(tmpdir(), `s1-check-${hash}`);
mkdirSync(base, { recursive: true });

const rawPpm  = join(base, 'page-raw.ppm');
const rawPng  = join(base, 'page-raw.png');
const cleanPpm = join(base, 'page-clean.ppm');
const cleanPng = join(base, 'page-clean.png');

console.log(`\nPreprocessing check: ${pdfPath}`);
console.log(`Temp dir: ${base}\n`);

// Step 1: rasterize at 300dpi
console.log('[1] Rasterizing page 1 at 300dpi...');
try {
  execFileSync('pdftoppm', ['-r', '300', '-f', '1', '-l', '1', '-singlefile', pdfPath, join(base, 'page-raw')]);
} catch (e) {
  console.error('pdftoppm failed:', e.message);
  process.exit(1);
}
if (!existsSync(rawPpm)) { console.error('No ppm output'); process.exit(1); }
execFileSync('convert', [rawPpm, rawPng]);
console.log(`  raw PNG: ${rawPng}`);

// Step 2: unpaper
console.log('[2] Running unpaper...');
try {
  execFileSync('unpaper', [rawPpm, cleanPpm]);
} catch (e) {
  console.error('unpaper failed:', e.message);
  process.exit(1);
}

// Step 3: contrast + sharpen
console.log('[3] Applying contrast normalization + sharpening...');
execFileSync('convert', [cleanPpm, '-normalize', '-contrast-stretch', '2%x1%', '-sharpen', '0x1', cleanPng]);
console.log(`  clean PNG: ${cleanPng}`);

// Step 4: send both to Haiku for readability assessment
console.log('[4] Sending before/after to Haiku for readability assessment...\n');

async function assessImage(label, imgPath) {
  const data = readFileSync(imgPath).toString('base64');
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data },
        },
        {
          type: 'text',
          text: `You are evaluating OCR preprocessing quality. Assess this ${label} scan image:
1. TEXT READABILITY (0-10): How clearly can individual characters be distinguished?
2. CONTRAST (0-10): Is there sufficient contrast between text and background?
3. SKEW: Is the text straight or tilted?
4. NOISE: Describe any speckles, stains, or artifacts interfering with text.
5. COLUMN STRUCTURE: Are text columns clearly separated?
6. OVERALL OCR SUITABILITY (0-10): How well would Tesseract/Surya OCR perform on this?
7. SPECIFIC ISSUES: List any problems that would harm OCR accuracy.

Be concise. One line per point.`,
        },
      ],
    }],
  });
  return resp.content[0].text;
}

const rawAssessment   = await assessImage('RAW (before preprocessing)', rawPng);
const cleanAssessment = await assessImage('CLEANED (after unpaper+contrast)', cleanPng);

console.log('─'.repeat(60));
console.log('RAW IMAGE ASSESSMENT:');
console.log(rawAssessment);
console.log('\n' + '─'.repeat(60));
console.log('CLEANED IMAGE ASSESSMENT:');
console.log(cleanAssessment);
console.log('\n' + '─'.repeat(60));

// Compare scores
const extractScore = (text) => {
  const m = text.match(/OCR SUITABILITY[^:]*:\s*(\d+)/i);
  return m ? parseInt(m[1]) : null;
};
const rawScore   = extractScore(rawAssessment);
const cleanScore = extractScore(cleanAssessment);
if (rawScore !== null && cleanScore !== null) {
  const delta = cleanScore - rawScore;
  console.log(`\nOCR suitability: raw=${rawScore}/10  clean=${cleanScore}/10  delta=${delta >= 0 ? '+' : ''}${delta}`);
  if (cleanScore < 6) {
    console.log('⚠  WARNING: cleaned image still below threshold — further preprocessing tuning needed');
  } else if (delta < 0) {
    console.log('⚠  WARNING: preprocessing made things worse — review unpaper settings');
  } else {
    console.log('✓  Preprocessing improved readability');
  }
}

console.log(`\nImages saved to: ${base}`);
