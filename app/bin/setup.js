#!/usr/bin/env node
// Postinstall hook -- idempotent PM2 registration. Safe to run multiple times; exits 0 on all non-fatal conditions.
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
const APP_DIR = resolve(import.meta.dirname, '..');
const pm2Available = () => { try { execSync('pm2 --version', { stdio: 'ignore' }); return true; } catch { return false; } };
const isRegistered = (name) => {
  try {
    const list = JSON.parse(execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }) || '[]');
    return list.some(p => p.name === name);
  } catch { return false; }
};
if (!pm2Available()) {
  console.log('[setup] pm2 not found -- install with: npm install -g pm2. Skipping PM2 registration.');
  process.exit(0);
}
if (!existsSync(resolve(APP_DIR, '.env'))) {
  console.warn('[setup] .env not found -- copy .env.example to .env and fill in secrets.');
}
if (isRegistered('site2rag')) {
  console.log('[setup] site2rag already registered with PM2, skipping. Run "pm2 startOrReload ecosystem.config.cjs" to pick up config changes.');
  process.exit(0);
}
try {
  execSync(`pm2 start ${resolve(APP_DIR, 'ecosystem.config.cjs')} && pm2 save`, { cwd: APP_DIR, stdio: 'inherit' });
  console.log('[setup] PM2 apps registered and saved.');
  console.log('[setup] Run "pm2 startup" (with sudo) once to enable autostart on reboot.');
} catch (err) {
  console.error(`[setup] PM2 registration failed: ${err.message}`);
  process.exit(0); // non-fatal -- don't break npm install
}
