// Retain stage -- 90-day grace deletion, degradation freeze, tombstone management. Local + S3 atomic.
import { unlinkSync, existsSync } from 'fs';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getMeta, setMeta } from './db.js';
/** Build S3 client from archive config. */
const mkS3Client = (archiveCfg) => new S3Client({
  region: archiveCfg?.s3_region || 'us-east-1',
  endpoint: archiveCfg?.s3_endpoint || undefined,
  credentials: {
    accessKeyId: process.env[archiveCfg?.s3_access_key_env || 'S3_ACCESS_KEY'] || '',
    secretAccessKey: process.env[archiveCfg?.s3_secret_key_env || 'S3_SECRET_KEY'] || ''
  },
  forcePathStyle: true
});
/** Compute net_loss over window_days. */
const computeNetLoss = (db, windowDays) => {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const gone = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE gone=1 AND gone_since >= ?').get(since)?.cnt || 0;
  const added = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE first_seen_at >= ? AND gone=0').get(since)?.cnt || 0;
  return gone - added;
};
/** Check if degradation freeze should trigger. */
const shouldFreeze = (db, retentionCfg) => {
  if (retentionCfg.preserve_always) return true;
  const freezeCfg = retentionCfg.freeze_on_degradation;
  if (!freezeCfg?.enabled) return false;
  const windowDays = freezeCfg.window_days ?? 30;
  const netLoss = computeNetLoss(db, windowDays);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM pages WHERE gone=0').get()?.cnt || 0;
  const threshold = Math.max(freezeCfg.net_loss_threshold_pct / 100 * total, freezeCfg.net_loss_min_pages ?? 50);
  return netLoss > threshold;
};
/** Delete a file safely, ignoring missing-file errors. */
const safeDelete = (path) => { try { if (existsSync(path)) unlinkSync(path); } catch {} };
/** Delete S3 object. */
const deleteS3Object = async (s3, bucket, key) => {
  try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (err) { console.error(`[retain] S3 delete failed ${key}: ${err.message}`); return false; }
};
/**
 * Run retain stage for a site. Evaluates freeze, deletes expired gone pages and assets.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @param {string} domain - Domain name
 * @returns {object} Stats: { frozen, gc_deleted, tombstones_pruned }
 */
export const runRetain = async (db, siteConfig, domain) => {
  const retentionCfg = siteConfig.retention || {};
  const archiveCfg = siteConfig.archive || {};
  const graceDays = retentionCfg.gone_grace_days ?? 90;
  const stats = { frozen: false, gc_deleted: 0, tombstones_pruned: 0 };
  // Evaluate freeze
  const freeze = shouldFreeze(db, retentionCfg);
  if (freeze) {
    const reason = retentionCfg.preserve_always ? 'preserve_always' : 'net_loss_threshold';
    if (!getMeta(db, 'frozen_since')) setMeta(db, 'frozen_since', new Date().toISOString());
    setMeta(db, 'freeze_reason', reason);
    setMeta(db, 'freeze_last_eval', new Date().toISOString());
    db.prepare('UPDATE runs SET retention_frozen=1 WHERE id=(SELECT MAX(id) FROM runs)').run();
    stats.frozen = true;
    return stats;
  }
  // Clear freeze state if it was previously set
  if (getMeta(db, 'frozen_since')) {
    setMeta(db, 'frozen_since', '');
    setMeta(db, 'freeze_reason', '');
  }
  setMeta(db, 'freeze_last_eval', new Date().toISOString());
  // S3 client (optional)
  const s3 = archiveCfg.enabled ? mkS3Client(archiveCfg) : null;
  const bucket = archiveCfg.s3_bucket || 'site2rag-archive';
  // Delete expired gone pages
  const graceCutoff = new Date(Date.now() - graceDays * 86400000).toISOString();
  const expiredPages = db.prepare('SELECT * FROM pages WHERE gone=1 AND gone_since < ? AND archive_only=0').all(graceCutoff);
  for (const page of expiredPages) {
    // Write tombstone first (safe-fail semantics)
    db.prepare('UPDATE pages SET local_path=NULL, archive_only=1 WHERE url=?').run(page.url);
    // Delete local mirror file
    if (page.local_path) safeDelete(page.local_path);
    // Delete corresponding MD export
    const exp = db.prepare('SELECT md_path FROM exports WHERE url=?').get(page.url);
    if (exp?.md_path) safeDelete(exp.md_path);
    // Delete S3 object (creates delete marker; versioning preserves history)
    if (s3 && page.backup_url) {
      const urlPath = new URL(page.url).pathname;
      await deleteS3Object(s3, bucket, `${domain}/${urlPath.replace(/^\//, '')}`);
    }
    stats.gc_deleted++;
  }
  // Delete expired unreferenced assets
  const expiredAssets = db.prepare("SELECT * FROM assets WHERE ref_count=0 AND gone_since < ? AND path != ''").all(graceCutoff);
  for (const asset of expiredAssets) {
    if (asset.path) safeDelete(asset.path);
    if (s3 && asset.backup_url) await deleteS3Object(s3, bucket, `${domain}/_assets/${asset.hash.slice(0, 2)}/${asset.hash}`);
    db.prepare('DELETE FROM asset_refs WHERE asset_hash=?').run(asset.hash);
    db.prepare('DELETE FROM assets WHERE hash=?').run(asset.hash);
    stats.gc_deleted++;
  }
  // Prune tombstone rows older than 1 year
  const yearCutoff = new Date(Date.now() - 365 * 86400000).toISOString();
  const pruned = db.prepare('DELETE FROM pages WHERE archive_only=1 AND gone_since < ?').run(yearCutoff).changes;
  stats.tombstones_pruned = pruned;
  return stats;
};
