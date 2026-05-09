#!/usr/bin/env node
// Standalone segmentation diagnostic. No pipeline required.
// Usage: node scripts/test-segmentation.js <pdf> [page] [dpi] [issues]
// Outputs annotated images + JSON summary to tmp/seg-test-<stem>/
//
// Images saved:
//   fullres.png          — 300dpi page raster (what OCR uses)
//   layout_orig.png      — layout-dpi raster, no enhancement
//   layout_enh.png       — layout-dpi after enhancement (if applied)
//   blocks_orig.png      — layout_orig with detected blocks drawn in red
//   blocks_enh.png       — layout_enh with detected blocks drawn in blue
//   summary.json         — block counts, sizes, enhancement result

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREPROCESS_PY = join(__dirname, '../src/pipeline/preprocess_image.py');

const pdfPath  = process.argv[2];
const pageNo   = parseInt(process.argv[3] ?? '1', 10);
const layoutDpi = parseInt(process.argv[4] ?? '150', 10);
const issues   = process.argv[5] ?? 'bleed_through,low_contrast,faded';

if (!pdfPath) {
  console.error('Usage: node test-segmentation.js <pdf> [page=1] [layout_dpi=150] [issues]');
  process.exit(1);
}

const stem = basename(pdfPath, '.pdf');
const outDir = join('/tmp', `seg-test-${stem}-p${pageNo}`);
mkdirSync(outDir, { recursive: true });
console.log(`Output: ${outDir}`);

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    return { error: e.message, stderr: e.stderr };
  }
}

// ── 1. Rasterize ──────────────────────────────────────────────────────────────
console.log(`\nRasterizing page ${pageNo} at 300dpi (fullres) + ${layoutDpi}dpi (layout)...`);
const fullresBase = join(outDir, 'fullres');
const layoutBase  = join(outDir, 'layout_orig');

run('pdftoppm', ['-png', '-r', '300', '-f', String(pageNo), '-l', String(pageNo), '-singlefile', pdfPath, fullresBase]);
run('pdftoppm', ['-png', '-r', String(layoutDpi), '-f', String(pageNo), '-l', String(pageNo), '-singlefile', pdfPath, layoutBase]);

const fullresPng = fullresBase + '.png';
const layoutOrigPng = layoutBase + '.png';
const fullresOk = existsSync(fullresPng);
const layoutOk  = existsSync(layoutOrigPng);

console.log(`  fullres.png:      ${fullresOk ? readFileSync(fullresPng).length + ' bytes' : 'MISSING'}`);
console.log(`  layout_orig.png:  ${layoutOk  ? readFileSync(layoutOrigPng).length + ' bytes' : 'MISSING'}`);

// ── 2. Enhance layout image ───────────────────────────────────────────────────
let layoutEnhPng = null;
let enhResult = null;
if (layoutOk) {
  console.log(`\nEnhancing layout image (issues: ${issues})...`);
  const layoutEnhPath = join(outDir, 'layout_enh.png');
  try {
    const out = execFileSync('python3', [
      PREPROCESS_PY, '--issues', issues, layoutOrigPng, layoutEnhPath
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    enhResult = JSON.parse(out.trim());
    if (enhResult.enhanced && existsSync(layoutEnhPath)) {
      layoutEnhPng = layoutEnhPath;
      console.log(`  Enhanced: applied=[${enhResult.applied?.join(',')}]`);
    } else {
      console.log(`  Not enhanced (${JSON.stringify(enhResult)})`);
    }
  } catch (e) {
    console.log(`  Enhancement failed: ${e.message}`);
  }
}

// ── 3. Tesseract layout pass ──────────────────────────────────────────────────
function runLayoutPass(imgPath, label) {
  console.log(`\nTesseract layout pass on ${label}...`);
  const hocrBase = join(outDir, `blocks_${label}`);
  try {
    execFileSync('tesseract', [imgPath, hocrBase, 'hocr', '--psm', '1', '-l', 'fra'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {}
  const hocrPath = hocrBase + '.hocr';
  if (!existsSync(hocrPath)) { console.log('  FAILED — no hOCR output'); return []; }

  const hocr = readFileSync(hocrPath, 'utf8');
  const allBlocks = [];
  const re = /<div[^>]+class='ocr_carea'[^>]+title='([^']*)'[^>]*>/g;
  let m;
  while ((m = re.exec(hocr)) !== null) {
    const bboxM = m[1].match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!bboxM) continue;
    const x1 = +bboxM[1], y1 = +bboxM[2], x2 = +bboxM[3], y2 = +bboxM[4];
    allBlocks.push({ x1, y1, x2, y2, w: x2-x1, h: y2-y1 });
  }

  const usable = allBlocks.filter(b => b.w >= 50 && b.h >= 40);
  const noise  = allBlocks.filter(b => b.w < 50 || b.h < 40);

  console.log(`  Raw ocr_carea: ${allBlocks.length}`);
  console.log(`  Usable (≥50×40): ${usable.length}`);
  if (noise.length) console.log(`  Noise (filtered): ${noise.length} — ${noise.slice(0,5).map(b=>`${b.w}×${b.h}`).join(', ')}`);
  if (usable.length) console.log(`  Block sizes: ${usable.map(b=>`${b.w}×${b.h}`).join(', ')}`);

  return { allBlocks, usable, noise };
}

const origBlocks = layoutOk ? runLayoutPass(layoutOrigPng, 'orig') : { allBlocks:[], usable:[], noise:[] };
const enhBlocks  = layoutEnhPng ? runLayoutPass(layoutEnhPng, 'enh') : null;

// ── 4. Annotate images with detected blocks ───────────────────────────────────
function annotate(srcImg, blocks, outPath, color) {
  if (!existsSync(srcImg) || !blocks.usable.length) return;
  const drawArgs = blocks.usable.flatMap(b =>
    ['-fill', 'none', '-stroke', color, '-strokewidth', '3',
     '-draw', `rectangle ${b.x1},${b.y1} ${b.x2},${b.y2}`]
  );
  try {
    execFileSync('convert', [srcImg, ...drawArgs, outPath]);
    console.log(`\nAnnotated: ${outPath} (${blocks.usable.length} blocks in ${color})`);
  } catch (e) {
    console.log(`  Annotation failed: ${e.message}`);
  }
}

console.log('\nAnnotating...');
if (layoutOk) annotate(layoutOrigPng, origBlocks, join(outDir, 'blocks_orig.png'), 'red');
if (layoutEnhPng && enhBlocks) annotate(layoutEnhPng, enhBlocks, join(outDir, 'blocks_enh.png'), 'blue');

// ── 5. Summary ────────────────────────────────────────────────────────────────
const summary = {
  pdf: pdfPath, page: pageNo, layoutDpi,
  fullresOk, layoutOk,
  enhancement: enhResult,
  layoutEnhApplied: !!layoutEnhPng,
  origBlocks: { raw: origBlocks.allBlocks?.length ?? 0, usable: origBlocks.usable?.length ?? 0, noise: origBlocks.noise?.length ?? 0, sizes: origBlocks.usable?.map(b=>`${b.w}×${b.h}`) ?? [] },
  enhBlocks: enhBlocks ? { raw: enhBlocks.allBlocks?.length ?? 0, usable: enhBlocks.usable?.length ?? 0, noise: enhBlocks.noise?.length ?? 0, sizes: enhBlocks.usable?.map(b=>`${b.w}×${b.h}`) ?? [] } : null,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

console.log('\n─── SUMMARY ───────────────────────────────────────');
console.log(`Layout DPI: ${layoutDpi}`);
console.log(`Enhancement applied: ${!!layoutEnhPng}`);
console.log(`Blocks (original): ${origBlocks.usable?.length ?? 0} usable / ${origBlocks.allBlocks?.length ?? 0} raw`);
if (enhBlocks) console.log(`Blocks (enhanced): ${enhBlocks.usable?.length ?? 0} usable / ${enhBlocks.allBlocks?.length ?? 0} raw`);
console.log(`\nFiles saved to: ${outDir}`);
console.log(existsSync(join(outDir,'fullres.png'))    ? '  ✓ fullres.png' : '  ✗ fullres.png MISSING');
console.log(existsSync(join(outDir,'layout_orig.png'))? '  ✓ layout_orig.png' : '  ✗ layout_orig.png MISSING');
console.log(existsSync(join(outDir,'layout_enh.png')) ? '  ✓ layout_enh.png' : '  ✗ layout_enh.png (not enhanced)');
console.log(existsSync(join(outDir,'blocks_orig.png'))? '  ✓ blocks_orig.png' : '  ✗ blocks_orig.png (no blocks found)');
console.log(existsSync(join(outDir,'blocks_enh.png')) ? '  ✓ blocks_enh.png' : '  ✗ blocks_enh.png (no blocks found)');
