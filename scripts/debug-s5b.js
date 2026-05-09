const fs = require('fs');
const path = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = fs.readFileSync(path, 'utf8');

// Add debug log inside the haiku loop to show page._pngPath and existsSync result
const oldLoop = "        const pngBuf = await getPagePng(page, ctx).catch(() => null);";
const newLoop = `        console.log('[s5-debug2] page=' + page.pageNo + ' _pngPath=' + page._pngPath + ' exists=' + (page._pngPath ? require('fs').existsSync(page._pngPath) : 'N/A'));
        const pngBuf = await getPagePng(page, ctx).catch((e) => { console.log('[s5-debug2] getPagePng ERROR:', e.message); return null; });
        console.log('[s5-debug2] pngBuf=' + (pngBuf ? pngBuf.length + 'bytes' : 'null'));`;

if (src.includes(oldLoop)) {
  src = src.replace(oldLoop, newLoop);
  fs.writeFileSync(path, src);
  console.log('Added page-level debug logs');
} else {
  console.log('Target line not found. Looking for context...');
  const idx = src.indexOf('getPagePng(page, ctx).catch');
  console.log('Context:', JSON.stringify(src.slice(Math.max(0, idx-50), idx+100)));
}
