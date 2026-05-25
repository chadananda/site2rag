#!/usr/bin/env node
// Stamps build time + incremented version into sw.js + version.json, deploys to CF Pages, restores sw.js.
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

// Read version.json (bump-version.js already ran as predeploy:backend, or caller bumped)
const versionJson = JSON.parse(readFileSync('public/version.json', 'utf8'));
const v = versionJson.v;
const build = versionJson.build;
const swPath = 'public/sw.js';
const origSw = readFileSync(swPath, 'utf8');

writeFileSync('public/version.json', JSON.stringify({ build, v }));
writeFileSync(swPath, origSw.replace('__BUILD_TIME__', build.replace(/[:.]/g, '-')));

try {
  execSync('npm run build:css', { stdio: 'inherit' });
  // Commit built CSS so backend git pull gets the same file CF Pages receives
  execSync('git add public/tailwind.css', { stdio: 'inherit' });
  try { execSync('git commit -m "chore: rebuild tailwind css"', { stdio: 'inherit' }); } catch {}
  // Push to git FIRST so tower-nas always gets updates even if CF deploy fails
  execSync(`git push`, { stdio: 'inherit' });
  execSync('wrangler pages deploy public/ --project-name=site2rag-report', { stdio: 'inherit' });
  console.log(`\n✓ Deployed site2rag v${v} (${build})`);
} finally {
  writeFileSync(swPath, origSw); // restore sw.js template
}
