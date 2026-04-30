import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const testRoot = join(tmpdir(), `site2rag-retain-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;
import { openDb, upsertPage } from '../src/db.js';
import { runRetain } from '../src/retain.js';
const DOMAIN = 'retain.example.com';
describe('runRetain', () => {
  let db;
  beforeEach(() => {
    db = openDb(DOMAIN);
  });
  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });
  it('does not delete pages within grace period', async () => {
    // Page gone yesterday -- within 90-day grace
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, local_path, gone, gone_since, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)').run('https://retain.example.com/old', 'old', '/tmp/old.html', 1, yesterday, yesterday, yesterday);
    const stats = await runRetain(db, { domain: DOMAIN, retention: { gone_grace_days: 90, freeze_on_degradation: { enabled: false } } }, DOMAIN);
    expect(stats.gc_deleted).toBe(0);
  });
  it('deletes pages beyond grace period', async () => {
    // Create a temp file to delete
    const tmpFile = join(testRoot, 'test-delete.html');
    writeFileSync(tmpFile, '<html>old</html>');
    const oldDate = new Date(Date.now() - 91 * 86400000).toISOString();
    db.prepare('INSERT INTO pages (url, path_slug, local_path, gone, gone_since, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)').run('https://retain.example.com/expired', 'expired', tmpFile, 1, oldDate, oldDate, oldDate);
    const stats = await runRetain(db, { domain: DOMAIN, retention: { gone_grace_days: 90, freeze_on_degradation: { enabled: false } } }, DOMAIN);
    expect(stats.gc_deleted).toBeGreaterThan(0);
    expect(existsSync(tmpFile)).toBe(false);
    // Verify tombstone created
    const row = db.prepare('SELECT * FROM pages WHERE url=?').get('https://retain.example.com/expired');
    expect(row.archive_only).toBe(1);
    expect(row.local_path).toBeNull();
  });
  it('freezes when preserve_always is true', async () => {
    const stats = await runRetain(db, { domain: DOMAIN, retention: { preserve_always: true, gone_grace_days: 90 } }, DOMAIN);
    expect(stats.frozen).toBe(true);
    expect(stats.gc_deleted).toBe(0);
  });
  it('triggers freeze on net_loss above threshold', async () => {
    // Add 60 gone pages to exceed threshold (min 50)
    for (let i = 0; i < 60; i++) {
      const oldDate = new Date(Date.now() - 5 * 86400000).toISOString();
      db.prepare('INSERT OR IGNORE INTO pages (url, path_slug, gone, gone_since, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)').run(`https://retain.example.com/gone${i}`, `gone${i}`, 1, oldDate, oldDate, oldDate);
    }
    const stats = await runRetain(db, { domain: DOMAIN, retention: { gone_grace_days: 90, freeze_on_degradation: { enabled: true, net_loss_threshold_pct: 10, net_loss_min_pages: 50, window_days: 30 } } }, DOMAIN);
    expect(stats.frozen).toBe(true);
  });
});
