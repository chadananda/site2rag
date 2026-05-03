// Assets stage: downloads images and documents from mirrored HTML pages; sha256 dedup. Exports: runAssets. Deps: undici, cheerio, config, db, constants
import { fetch } from 'undici';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import * as cheerio from 'cheerio';
import { assetsDir, mirrorDir } from './config.js';
import { upsertAsset, addAssetRef } from './db.js';
import { DOC_EXTS, DOC_MIMES, IMAGE_MIMES } from './constants.js';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Resolve URL relative to page URL. */
const resolveUrl = (href, pageUrl) => { try { return new URL(href, pageUrl).toString().split('#')[0]; } catch { return null; } };
/** Return asset type based on URL and MIME. */
const classifyAsset = (url, mime = '') => {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (IMAGE_MIMES.has(mime) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'].includes(ext)) return 'image';
  if (DOC_MIMES.has(mime) || DOC_EXTS.has(ext)) return 'document';
  return null;
};
/** Compute asset storage path: _assets/<sha[0:2]>/<sha>.<ext> */
const assetPath = (domain, hash, ext) => join(assetsDir(domain), hash.slice(0, 2), `${hash}${ext}`);
/** Write asset at its original URL path in the mirror so lnker-server can serve it by path. */
const writeMirrorPath = (domain, assetUrl, buf) => {
  try {
    const pathname = new URL(assetUrl).pathname;
    const mirrorPath = join(mirrorDir(domain), pathname);
    if (!existsSync(mirrorPath)) {
      mkdirSync(join(mirrorPath, '..'), { recursive: true });
      writeFileSync(mirrorPath, buf);
    }
  } catch {}
};
/**
 * Run assets stage for a site. Scans mirrored HTML, downloads assets, deduplicates.
 * @param {object} db - SQLite db for domain
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { total, new_assets, skipped, bytes }
 */
export const runAssets = async (db, siteConfig) => {
  const domain = siteConfig.domain;
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const assetsCfg = siteConfig.assets || {};
  const types = assetsCfg.types || ['image', 'document'];
  const imageMaxBytes = assetsCfg.image_max_bytes ?? 10485760;
  const stats = { total: 0, new_assets: 0, skipped: 0, bytes: 0 };
  // Process all HTML pages in DB
  const pages = db.prepare("SELECT url, local_path FROM pages WHERE gone=0 AND mime_type LIKE 'text/html%' AND local_path IS NOT NULL").all();
  for (const page of pages) {
    if (!existsSync(page.local_path)) continue;
    const html = readFileSync(page.local_path, 'utf8');
    const $ = cheerio.load(html);
    const assetUrls = [];
    // Images
    if (types.includes('image')) {
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        const resolved = resolveUrl(src, page.url);
        if (resolved) assetUrls.push({ url: resolved, type: 'image' });
      });
    }
    // Documents via <a href>
    if (types.includes('document')) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const resolved = resolveUrl(href, page.url);
        if (!resolved) return;
        const ext = extname(new URL(resolved).pathname).toLowerCase();
        if (DOC_EXTS.has(ext)) assetUrls.push({ url: resolved, type: 'document' });
      });
    }
    for (const { url: assetUrl, type } of assetUrls) {
      stats.total++;
      // Check if already downloaded (by original_url)
      const existing = db.prepare('SELECT * FROM assets WHERE original_url=?').get(assetUrl);
      if (existing) {
        // Ensure mirror path exists even if asset was downloaded before this feature was added
        if (existing.path && existsSync(existing.path)) {
          writeMirrorPath(domain, assetUrl, readFileSync(existing.path));
        }
        addAssetRef(db, existing.hash, page.url);
        continue;
      }
      let res;
      try {
        res = await fetch(assetUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
        if (!res.ok) { stats.skipped++; continue; }
      } catch { stats.skipped++; continue; }
      let buf;
      try { buf = Buffer.from(await res.arrayBuffer()); } catch { stats.skipped++; continue; }
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
      // Size cap for images
      if (type === 'image' && buf.length > imageMaxBytes) {
        db.prepare('INSERT OR IGNORE INTO assets (hash, path, original_url, mime_type, bytes, first_seen_at, last_seen_at, ref_count, skipped_reason) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(`oversize:${assetUrl}`, '', assetUrl, mime, buf.length, new Date().toISOString(), new Date().toISOString(), 0, 'oversize');
        stats.skipped++;
        continue;
      }
      const hash = sha256(buf);
      const ext = extname(new URL(assetUrl).pathname).toLowerCase() || `.${mime.split('/')[1] || 'bin'}`;
      const storagePath = assetPath(domain, hash, ext);
      mkdirSync(join(assetsDir(domain), hash.slice(0, 2)), { recursive: true });
      if (!existsSync(storagePath)) writeFileSync(storagePath, buf);
      writeMirrorPath(domain, assetUrl, buf);
      upsertAsset(db, { hash, path: storagePath, original_url: assetUrl, mime_type: mime, bytes: buf.length });
      addAssetRef(db, hash, page.url);
      stats.new_assets++;
      stats.bytes += buf.length;
    }
  }
  return stats;
};
