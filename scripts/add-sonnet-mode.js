const fs = require('fs');
const path = '/tank/site2rag/app/src/pipeline/stages/s5-vision.js';
let src = fs.readFileSync(path, 'utf8');

// 1. Add model parameter to synthesizeViaHaiku
const oldSig = 'async function synthesizeViaHaiku(pngBuf, pageWords, apiKey, domain, lang) {';
const newSig = 'async function synthesizeViaHaiku(pngBuf, pageWords, apiKey, domain, lang, model) {';
if (src.includes(newSig)) {
  console.log('model param already in signature');
} else if (src.includes(oldSig)) {
  src = src.replace(oldSig, newSig);
  console.log('Added model param to signature');
} else {
  console.log('WARNING: signature not found');
}

// 2. Replace hardcoded MODEL constant with param
const oldModel = "  const MODEL = 'claude-haiku-4-5-20251001';";
const newModel = "  const MODEL = model ?? 'claude-haiku-4-5-20251001';";
if (src.includes(oldModel)) {
  src = src.replace(oldModel, newModel);
  console.log('Made MODEL configurable via param');
} else if (src.includes(newModel)) {
  console.log('MODEL already configurable');
} else {
  console.log('WARNING: MODEL constant not found');
}

// 3. In the haiku mode branch, determine model from config and pass lang from meta if not set by s3
const oldEntry = "      for (const page of ctx.pages) {\n        if (!withinBudget(ctx, 2000)) break;\n        const pngBuf = await getPagePngForHaiku(page, ctx).catch(() => null);\n        if (!pngBuf) continue;\n        const result = await synthesizeViaHaiku(pngBuf, page.words, ctx.config.apiKey, ctx.domain, page._lang);";

const newEntry = `      const synthModel = ctx.config.s5Mode === 'sonnet'
        ? 'claude-sonnet-4-6'
        : 'claude-haiku-4-5-20251001';
      // Resolve lang from meta if s3 didn't run (no-OCR mode)
      const metaLang = ctx.meta?.language;
      const fallbackLang = (metaLang === 'ar' || metaLang === 'ara') ? 'ara'
        : (metaLang === 'fa' || metaLang === 'fas') ? 'fas'
        : (metaLang === 'fr' || metaLang === 'fra') ? 'fra' : 'eng';

      for (const page of ctx.pages) {
        if (!withinBudget(ctx, 2000)) break;
        const pngBuf = await getPagePngForHaiku(page, ctx).catch(() => null);
        if (!pngBuf) continue;
        const pageLang = page._lang ?? fallbackLang;
        const result = await synthesizeViaHaiku(pngBuf, page.words, ctx.config.apiKey, ctx.domain, pageLang, synthModel);`;

if (src.includes(oldEntry)) {
  src = src.replace(oldEntry, newEntry);
  console.log('Added model selection and fallbackLang in haiku branch');
} else {
  // Try the simpler approach - just find and update the call site
  const oldCall = 'const result = await synthesizeViaHaiku(pngBuf, page.words, ctx.config.apiKey, ctx.domain, page._lang);';
  const newCall = 'const pageLang = page._lang ?? fallbackLang;\n        const result = await synthesizeViaHaiku(pngBuf, page.words, ctx.config.apiKey, ctx.domain, pageLang, synthModel);';
  if (src.includes(oldCall)) {
    // Need to also add the model/lang setup before the loop
    const oldLoop = 'for (const page of ctx.pages) {\n        if (!withinBudget(ctx, 2000)) break;\n        const pngBuf = await getPagePngForHaiku(page, ctx).catch(() => null);\n        if (!pngBuf) continue;';
    const newLoop = `const synthModel = ctx.config.s5Mode === 'sonnet'
        ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
      const metaLang = ctx.meta?.language;
      const fallbackLang = (metaLang === 'ar' || metaLang === 'ara') ? 'ara'
        : (metaLang === 'fa' || metaLang === 'fas') ? 'fas'
        : (metaLang === 'fr' || metaLang === 'fra') ? 'fra' : 'eng';
      for (const page of ctx.pages) {
        if (!withinBudget(ctx, 2000)) break;
        const pngBuf = await getPagePngForHaiku(page, ctx).catch(() => null);
        if (!pngBuf) continue;`;
    src = src.replace(oldLoop, newLoop);
    src = src.replace(oldCall, newCall);
    console.log('Added model selection and fallbackLang via split approach');
  } else {
    // Show context
    const idx = src.indexOf('synthesizeViaHaiku(pngBuf');
    console.log('Cannot find call site. Context:', JSON.stringify(src.slice(Math.max(0,idx-100), idx+200)));
  }
}

// 4. Update the condition to also enter haiku branch for s5Mode='sonnet'
const oldCond = "  if (ctx.config.s5Mode === 'haiku' && ctx.config.apiKey) {";
const newCond = "  if ((ctx.config.s5Mode === 'haiku' || ctx.config.s5Mode === 'sonnet') && ctx.config.apiKey) {";
if (src.includes(oldCond)) {
  src = src.replace(oldCond, newCond);
  console.log('Updated condition to also accept s5Mode=sonnet');
} else if (src.includes(newCond)) {
  console.log('Condition already updated');
} else {
  console.log('WARNING: condition not found');
}

fs.writeFileSync(path, src);

// Verify syntax
const { execSync } = require('child_process');
try {
  execSync('node --check ' + path);
  console.log('Syntax OK');
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
}

console.log('Done.');
