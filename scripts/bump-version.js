// Bump patch version in public/version.json and commit if there are staged or unstaged changes.
// Run as predeploy:backend so every deploy always ships a new version number.
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const vPath = 'public/version.json';
const v = JSON.parse(readFileSync(vPath, 'utf8'));
const parts = v.v.split('.');
parts[2] = String(parseInt(parts[2]) + 1);
v.v = parts.join('.');
v.build = new Date().toISOString();
writeFileSync(vPath, JSON.stringify(v));
console.log(`[bump-version] ${v.v}`);

// Stage and commit — if nothing else is staged this just commits the version bump
execSync(`git add ${vPath}`, { stdio: 'inherit' });
try {
  execSync(`git commit -m "chore: bump to v${v.v}"`, { stdio: 'inherit' });
} catch {
  // Nothing to commit (version already bumped this run) — that's fine
}
