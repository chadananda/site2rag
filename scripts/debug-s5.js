const fs = require('fs');
const path = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = fs.readFileSync(path, 'utf8');

const oldCheck = "  if (ctx.config.s5Mode === 'haiku' && ctx.config.apiKey) {";
const newCheck = "  console.log('[s5-debug] s5Mode=' + ctx.config.s5Mode + ' hasApiKey=' + !!ctx.config.apiKey);\n  if (ctx.config.s5Mode === 'haiku' && ctx.config.apiKey) {";
if (src.includes(oldCheck)) {
  src = src.replace(oldCheck, newCheck);
  fs.writeFileSync(path, src);
  console.log('Added debug log');
} else if (src.includes('[s5-debug]')) {
  console.log('Debug log already present');
} else {
  // Show what is near the haiku check
  const idx = src.indexOf('s5Mode');
  console.log('Context around s5Mode:', JSON.stringify(src.slice(idx - 10, idx + 100)));
}
