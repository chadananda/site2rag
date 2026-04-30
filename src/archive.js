// Archive stage -- ETag-based S3 sync for mirror files. Respects noarchive. Never rewrites local mirror.
import { readFileSync, existsSync } from 'fs';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as cheerio from 'cheerio';
/** Build S3 client from site archive config. */
const mkS3Client = (archiveCfg) => new S3Client({
  region: archiveCfg.s3_region || 'us-east-1',
  endpoint: archiveCfg.s3_endpoint || undefined,
  credentials: {
    accessKeyId: process.env[archiveCfg.s3_access_key_env || 'S3_ACCESS_KEY'] || '',
    secretAccessKey: process.env[archiveCfg.s3_secret_key_env || 'S3_SECRET_KEY'] || ''
  },
  forcePathStyle: true
});
/** Compute backup_url from template. */
const buildBackupUrl = (template, domain, urlPath) =>
  template.replace('{domain}', domain).replace('{path}', urlPath.replace(/^\//, ''));
/** Check if page has noarchive directive. */
const hasNoArchive = (page, html) => {
  if (!html) return false;
  const $ = cheerio.load(html);
  const metaRobots = $('meta[name="robots"]').attr('content') || '';
  return metaRobots.toLowerCase().includes('noarchive');
};
/** Upload a single file to S3. Returns { etag, uploaded } or { skipped }. */
const uploadFile = async (s3, bucket, key, buf, contentType) => {
  try {
    const res = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType }));
    return { etag: res.ETag?.replace(/"/g, '') || null, uploaded: true };
  } catch (err) {
    console.error(`[archive] S3 upload failed ${key}: ${err.message}`);
    return { uploaded: false, error: err.message };
  }
};
/** Rewrite asset URLs in HTML buf to backup_url equivalents (for S3 upload only). */
const rewriteAssetUrlsForS3 = (htmlBuf, db) => {
  const html = htmlBuf.toString('utf8');
  const $ = cheerio.load(html);
  $('img[src], link[href], script[src]').each((_, el) => {
    const attr = $(el).is('link') ? 'href' : 'src';
    const src = $(el).attr(attr);
    if (!src) return;
    const asset = db.prepare('SELECT backup_url FROM assets WHERE original_url=? AND backup_url IS NOT NULL').get(src);
    if (asset) $(el).attr(attr, asset.backup_url);
  });
  return Buffer.from($.html(), 'utf8');
};
/**
 * Run archive stage for a site. Pushes changed mirror files to S3.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { uploaded, skipped, failed, archive_only }
 */
export const runArchive = async (db, siteConfig) => {
  const archiveCfg = siteConfig.archive || {};
  if (!archiveCfg.enabled) return { uploaded: 0, skipped: 0, failed: 0, archive_only: 0 };
  const domain = siteConfig.domain;
  const bucket = archiveCfg.s3_bucket || 'site2rag-archive';
  const template = archiveCfg.public_url_template || '';
  const stats = { uploaded: 0, skipped: 0, failed: 0, archive_only: 0 };
  let s3;
  try { s3 = mkS3Client(archiveCfg); } catch (err) { console.error(`[archive] S3 init failed: ${err.message}`); return stats; }
  // Determine which pages to upload based on config flags
  const mimeFilters = [];
  if (archiveCfg.upload_html) mimeFilters.push("mime_type LIKE 'text/html%'");
  if (archiveCfg.upload_documents) mimeFilters.push("mime_type='application/pdf'");
  if (!mimeFilters.length) return stats;
  const pages = db.prepare(`SELECT * FROM pages WHERE gone=0 AND local_path IS NOT NULL AND (${mimeFilters.join(' OR ')})`).all();
  for (const page of pages) {
    if (!existsSync(page.local_path)) continue;
    const urlPath = new URL(page.url).pathname;
    const s3Key = `${domain}/${urlPath.replace(/^\//, '')}`;
    const buf = readFileSync(page.local_path);
    // Check noarchive
    if (archiveCfg.respect_archive_block) {
      const html = page.mime_type?.includes('text/html') ? buf.toString('utf8') : null;
      if (hasNoArchive(page, html)) { stats.skipped++; continue; }
    }
    // ETag skip -- if backup_etag matches content_hash suffix (content unchanged)
    if (page.backup_etag && page.backup_etag === page.content_hash) { stats.skipped++; continue; }
    // Rewrite asset URLs for S3 upload if configured (never modifies local file)
    const uploadBuf = (archiveCfg.rewrite_html_assets && page.mime_type?.includes('text/html'))
      ? rewriteAssetUrlsForS3(buf, db) : buf;
    const result = await uploadFile(s3, bucket, s3Key, uploadBuf, page.mime_type || 'application/octet-stream');
    if (result.uploaded) {
      const backupUrl = buildBackupUrl(template, domain, urlPath);
      const now = new Date().toISOString();
      db.prepare('UPDATE pages SET backup_url=?, backup_etag=?, backup_archived_at=? WHERE url=?').run(backupUrl, page.content_hash, now, page.url);
      stats.uploaded++;
    } else { stats.failed++; }
  }
  // Upload assets if configured
  if (archiveCfg.upload_assets) {
    const assets = db.prepare('SELECT * FROM assets WHERE backup_etag IS NULL OR backup_etag != content_hash').all().filter(a => existsSync(a.path));
    for (const asset of assets) {
      const urlPath = new URL(asset.original_url || '').pathname;
      const s3Key = `${domain}/_assets/${asset.hash.slice(0, 2)}/${asset.hash}`;
      const buf = readFileSync(asset.path);
      const result = await uploadFile(s3, bucket, s3Key, buf, asset.mime_type || 'application/octet-stream');
      if (result.uploaded) {
        const backupUrl = buildBackupUrl(template, domain, `_assets/${asset.hash.slice(0, 2)}/${asset.hash}`);
        db.prepare('UPDATE assets SET backup_url=?, backup_etag=?, backup_archived_at=? WHERE hash=?').run(backupUrl, asset.hash, new Date().toISOString(), asset.hash);
        stats.uploaded++;
      } else { stats.failed++; }
    }
  }
  return stats;
};
