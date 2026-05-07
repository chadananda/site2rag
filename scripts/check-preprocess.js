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

// Step 2: unpaper (non-fatal — falls back to raw if output missing)
console.log('[2] Running unpaper...');
try {
  execFileSync('unpaper', [rawPpm, cleanPpm], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch (e) {
  console.warn('  unpaper warning:', e.message.split('\n')[0]);
}

// Step 3: try multiple enhancement strategies, pick best via vision
console.log('[3] Applying preprocessing variants...');
// Fall back to raw ppm if unpaper produced no output
const srcPpm = existsSync(cleanPpm) ? cleanPpm : rawPpm;
if (srcPpm === rawPpm) console.log('  WARNING: unpaper output missing, using raw ppm for variants');
const variants = {
  mild:      join(base, 'v-mild.jpg'),
  contrast:  join(base, 'v-contrast.jpg'),
  binarize:  join(base, 'v-binarize.jpg'),
  adaptive:  join(base, 'v-adaptive.jpg'),
};
// mild: normalize only
execFileSync('convert', [srcPpm, '-normalize', '-sharpen', '0x0.5', '-resize', '1400x>', '-quality', '85', variants.mild]);
// contrast: aggressive stretch + sharpen
execFileSync('convert', [srcPpm, '-normalize', '-contrast-stretch', '5%x2%', '-sharpen', '0x1.5', '-resize', '1400x>', '-quality', '85', variants.contrast]);
// binarize: Otsu threshold for yellowed paper
execFileSync('convert', [srcPpm, '-colorspace', 'Gray', '-normalize', '-threshold', '45%', '-resize', '1400x>', '-quality', '85', variants.binarize]);
// adaptive: local adaptive threshold — IM6 uses hyphenated form
execFileSync('convert', [srcPpm, '-colorspace', 'Gray', '-normalize', '-adaptive-threshold', '21x21+5%', '-resize', '1400x>', '-quality', '85', variants.adaptive]);
// raw for comparison
const rawApiPng = join(base, 'page-raw-api.jpg');
execFileSync('convert', [srcPpm, '-normalize', '-contrast-stretch', '2%x1%', '-sharpen', '0x1', cleanPng]);
execFileSync('convert', [rawPng, '-resize', '1400x>', '-quality', '85', rawApiPng]);
console.log(`  src ppm: ${srcPpm}`);

// Step 4: send both to Haiku for readability assessment
console.log('[4] Sending before/after to Haiku for readability assessment...\n');

async function assessImage(label, imgPath) {
  const data = readFileSync(imgPath).toString('base64');
  const mediaType = imgPath.endsWith('.jpg') || imgPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
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

const extractScore = (text) => {
  const m = text.match(/OCR SUITABILITY[^:]*:\s*(\d+)/i);
  return m ? parseInt(m[1]) : null;
};

const rawAssessment = await assessImage('RAW (before preprocessing)', rawApiPng);
const rawScore = extractScore(rawAssessment);

console.log('─'.repeat(60));
console.log('RAW IMAGE ASSESSMENT:');
console.log(rawAssessment);

// Assess all 4 variants
console.log('\n[5] Assessing all preprocessing variants...\n');
const variantResults = [];
for (const [name, path] of Object.entries(variants)) {
  console.log(`  Assessing variant: ${name}`);
  const assessment = await assessImage(`VARIANT:${name}`, path);
  const score = extractScore(assessment);
  variantResults.push({ name, path, assessment, score });
  console.log(`─`.repeat(60));
  console.log(`VARIANT [${name.toUpperCase()}] ASSESSMENT:`);
  console.log(assessment);
}

// Rank variants
const scored = variantResults.filter(v => v.score !== null).sort((a, b) => b.score - a.score);

console.log('\n' + '═'.repeat(60));
console.log('VARIANT RANKING:');
scored.forEach((v, i) => {
  const delta = rawScore !== null ? v.score - rawScore : null;
  const dStr = delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta} vs raw)` : '';
  console.log(`  ${i + 1}. ${v.name.padEnd(10)} score=${v.score}/10${dStr}`);
});

const best = scored[0];
if (best) {
  const delta = rawScore !== null ? best.score - rawScore : null;
  console.log(`\nBest variant: ${best.name} (score=${best.score}/10)`);
  if (best.score < 6) {
    console.log('⚠  WARNING: best variant still below threshold — more aggressive preprocessing needed');
  } else if (delta !== null && delta < 0) {
    console.log('⚠  WARNING: all variants worse than raw — review unpaper settings');
  } else {
    console.log('✓  Best variant is an improvement over raw');
  }
  console.log(`   Image path: ${best.path}`);
}

console.log(`\nAll images saved to: ${base}`);
