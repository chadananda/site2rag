#!/usr/bin/env node
// Stamps build time + incremented version into sw.js + version.json, deploys to CF Pages, restores sw.js.
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

// Version bump is handled by bump-version.js (also used by predeploy:backend)
const { execSync: bumpExec } = await import('child_process');
bumpExec('node scripts/bump-version.js', { stdio: 'inherit' });

const versionJson = JSON.parse(readFileSync('public/version.json', 'utf8'));
const v = versionJson.v;
const build = versionJson.build;
const swPath = 'public/sw.js';
const origSw = readFileSync(swPath, 'utf8');

writeFileSync('public/version.json', JSON.stringify({ build, v }));
writeFileSync(swPath, origSw.replace('__BUILD_TIME__', build.replace(/[:.]/g, '-')));

try {
  execSync('npm run build:css', { stdio: 'inherit' });
  execSync('wrangler pages deploy public/ --project-name=site2rag-report', { stdio: 'inherit' });
  console.log(`\n✓ Deployed site2rag v${v} (${build})`);
  execSync(`git push`, { stdio: 'inherit' });
} finally {
  writeFileSync(swPath, origSw); // restore sw.js template
}
