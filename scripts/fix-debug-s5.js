const fs = require('fs');
const path = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = fs.readFileSync(path, 'utf8');

// Remove all debug additions and get back to clean state
// Then add ESM-compatible debug logging

// 1. Remove broken require('fs') debug line
const badLine = `        console.log('[s5-debug2] page=' + page.pageNo + ' _pngPath=' + page._pngPath + ' exists=' + (page._pngPath ? require('fs').existsSync(page._pngPath) : 'N/A'));\n`;
src = src.replace(badLine, '');

// 2. Replace error-catching getPagePng with ESM-compatible version
const oldGetPage = `        const pngBuf = await getPagePng(page, ctx).catch((e) => { console.log('[s5-debug2] getPagePng ERROR:', e.message); return null; });
        console.log('[s5-debug2] pngBuf=' + (pngBuf ? pngBuf.length + 'bytes' : 'null'));`;
const newGetPage = `        const pngBuf = await getPagePng(page, ctx).catch((e) => { console.log('[s5-png] page=' + page.pageNo + ' _pngPath=' + (page._pngPath ?? 'MISSING') + ' ERROR:' + e.message.slice(0,80)); return null; });
        if (pngBuf) console.log('[s5-png] page=' + page.pageNo + ' ok=' + pngBuf.length + 'b');`;
src = src.replace(oldGetPage, newGetPage);

// Check if the bad line was actually removed
if (src.includes("require('fs')")) {
  console.log('WARNING: require(fs) still present!');
} else {
  console.log('Debug2 cleaned up OK');
}

fs.writeFileSync(path, src);
console.log('Done.');
