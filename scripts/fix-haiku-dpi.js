const fs = require('fs');
const path = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = fs.readFileSync(path, 'utf8');

// Add getPagePngForHaiku function that uses 150 DPI (keeps under Anthropic's 5MB limit)
// The existing getPagePng uses page._pngPath which is 300 DPI from s3 (~7.6MB — too large)
const newFn = `
// Rasterize at 150 DPI for Haiku synthesis — keeps image under Anthropic's 5MB API limit.
// 300 DPI images from s3 are typically 5-10MB and get rejected by the API.
async function getPagePngForHaiku(page, ctx) {
  const docHash = sha256(ctx.docId).slice(0, 16);
  const dir = join(tmpdir(), 'site2rag-haiku-' + docHash);
  mkdirSync(dir, { recursive: true });
  const outBase = join(dir, 'page-' + page.pageNo);
  const pngPath = outBase + '.png';
  if (!existsSync(pngPath)) {
    await execFileAsync('pdftoppm', ['-png', '-r', '150', '-f', String(page.pageNo),
      '-l', String(page.pageNo), '-singlefile', ctx.sourcePath, outBase],
      { timeout: 30000 });
  }
  return readFileSync(pngPath);
}

`;

if (src.includes('getPagePngForHaiku')) {
  console.log('getPagePngForHaiku already exists');
} else {
  // Insert before the haiku synthesis function
  src = src.replace('async function synthesizeViaHaiku(', newFn + 'async function synthesizeViaHaiku(');
  console.log('Added getPagePngForHaiku');
}

// Replace the getPagePng call in the haiku loop with getPagePngForHaiku
const oldCall = 'const pngBuf = await getPagePng(page, ctx).catch((e) => { console.log(\'[s5-png] page=\' + page.pageNo + \' _pngPath=\' + (page._pngPath ?? \'MISSING\') + \' ERROR:\' + e.message.slice(0,80)); return null; });\n        if (pngBuf) console.log(\'[s5-png] page=\' + page.pageNo + \' ok=\' + pngBuf.length + \'b\');';
const newCall = 'const pngBuf = await getPagePngForHaiku(page, ctx).catch(() => null);';

if (src.includes(oldCall)) {
  src = src.replace(oldCall, newCall);
  console.log('Replaced getPagePng with getPagePngForHaiku in haiku loop');
} else {
  // Fallback: look for the simpler original
  const alt = "const pngBuf = await getPagePng(page, ctx).catch(() => null);";
  if (src.includes(alt)) {
    src = src.replace(alt, newCall);
    console.log('Replaced original getPagePng with getPagePngForHaiku');
  } else {
    // Show context
    const idx = src.indexOf('getPagePng(page, ctx)');
    console.log('WARNING: call site not found. Context:', JSON.stringify(src.slice(Math.max(0, idx-30), idx+120)));
  }
}

// Also remove the first s5-debug log (it fires for EVERY job now, clutter)
src = src.replace("  console.log('[s5-debug] s5Mode=' + ctx.config.s5Mode + ' hasApiKey=' + !!ctx.config.apiKey);\n", '');
console.log('Removed s5-debug log');

fs.writeFileSync(path, src);
console.log('Done.');
