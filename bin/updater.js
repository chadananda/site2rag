#!/usr/bin/env node
// PM2-supervised auto-update watchdog. Polls GitHub, fast-forward pulls, restarts on update.
import { execSync, spawnSync } from 'child_process';
import { resolve } from 'path';
const APP_DIR = resolve(import.meta.dirname, '..');
const INTERVAL_MIN = parseInt(process.env.UPDATE_CHECK_INTERVAL_MIN || '60', 10);
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const ENABLED = process.env.UPDATE_ENABLED !== 'false';
const LOG_TAG = '[updater]';
const log = (msg) => console.log(`${new Date().toISOString()} ${LOG_TAG} ${msg}`);
const run = (cmd, opts = {}) => execSync(cmd, { cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const runInherited = (cmd) => execSync(cmd, { cwd: APP_DIR, stdio: 'inherit' });
const check = () => {
  if (!ENABLED) { log('UPDATE_ENABLED=false, skipping check.'); return; }
  log(`checking ${BRANCH}...`);
  // 1. Fetch
  try { run(`git fetch --quiet origin ${BRANCH}`); } catch (err) {
    log(`git fetch failed (network?): ${err.message}. Skipping cycle.`); return;
  }
  // 2. Compare HEAD to remote
  let localHead, remoteHead;
  try {
    localHead = run('git rev-parse HEAD').trim();
    remoteHead = run(`git rev-parse origin/${BRANCH}`).trim();
  } catch (err) { log(`rev-parse failed: ${err.message}`); return; }
  if (localHead === remoteHead) { log('up to date.'); return; }
  log(`update available: ${localHead.slice(0, 8)} -> ${remoteHead.slice(0, 8)}`);
  // 3. Check if package.json changed
  let needs_install = false;
  try {
    const changed = run(`git diff --name-only HEAD origin/${BRANCH}`);
    needs_install = /package(-lock)?\.json/.test(changed);
  } catch {}
  // 4. Fast-forward pull only
  try { run(`git pull --ff-only origin ${BRANCH}`); }
  catch (err) {
    log(`git pull failed (non-fast-forward?): ${err.message}. Aborting -- manual cleanup required.`); return;
  }
  // 5. npm install if package.json changed
  if (needs_install) {
    log('package.json changed, running npm install...');
    try { runInherited('npm install'); }
    catch (err) { log(`npm install failed: ${err.message}. Aborting restart.`); return; }
  }
  // 6. Reload PM2 (detached -- updater itself may be restarted)
  log('reloading PM2...');
  const result = spawnSync('pm2', ['startOrReload', resolve(APP_DIR, 'ecosystem.config.cjs'), '--update-env'], { cwd: APP_DIR, stdio: 'inherit', detached: false });
  if (result.status !== 0) { log('pm2 startOrReload failed. Code on disk is new but processes may be stale. Will retry next cycle.'); return; }
  try { run('pm2 save'); } catch {}
  log('update applied successfully.');
};
log(`starting -- interval: ${INTERVAL_MIN}m, branch: ${BRANCH}, enabled: ${ENABLED}`);
check();
setInterval(check, INTERVAL_MIN * 60 * 1000);
