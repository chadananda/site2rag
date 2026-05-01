#!/usr/bin/env node
// Stamps build time into sw.js + version.json, deploys to CF Pages, then restores sw.js.
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const build = new Date().toISOString();
const swPath = 'public/sw.js';
const origSw = readFileSync(swPath, 'utf8');

writeFileSync('public/version.json', JSON.stringify({ build }));
writeFileSync(swPath, origSw.replace('__BUILD_TIME__', build.replace(/[:.]/g, '-')));

try {
  execSync('npm run build:css', { stdio: 'inherit' });
  execSync('npx wrangler pages deploy public/ --project-name=site2rag-report', { stdio: 'inherit' });
  console.log(`\n✓ Deployed build ${build}`);
} finally {
  writeFileSync(swPath, origSw); // restore template
}
