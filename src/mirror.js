// Crawl orchestration: builds queue from sitemap+recheck, runs concurrent fetch loop with per-URL classify+export.
// Exports: runMirror. Re-exports crawl utils from mirror-crawl.js.
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join, extname } from 'path';
import * as cheerio from 'cheerio';                                                // link extraction from HTML
import { upsertPage, markGoneUrls } from './db.js';                               // persist crawled pages
import { compileRules, applyFollowOverride, stripQueryParams } from './rules.js'; // per-site crawl rules
import { scorePdf, saveQualityScore, maybeQueue } from './score.js';              // score PDFs inline, queue low-scorers
import { classifyPage } from './classify.js';                                     // classify page role after crawl
import { exportTextPdf, exportDocx } from './export-doc.js';                     // export docs to MD inline
import { getAdapter } from './fetch-adapters.js';                                 // pluggable HTTP/MediaWiki/WP-RSS fetch
export { urlToMirrorPath, urlPathToSlug, inScope, parseRobots, extractLinks } from './mirror-crawl.js';
import { urlToMirrorPath, urlPathToSlug, inScope, parseRobots, extractLinks } from './mirror-crawl.js'; // pure URL/path utils
import { fetch } from 'undici';                                                    // fast HTTP client

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SCORE_TIMEOUT_MS = 30000;

/**
 * Run mirror stage: crawl site, conditional GET, write files, update DB.
 * @returns {object} Stats: { checked, new_pages, changed, gone }
 */
export const runMirror = async (db, siteConfig, priorityQueue = []) => {
  const domain = siteConfig.domain;
  const seedUrl = siteConfig.url;
  const ua = siteConfig.user_agent || 'site2rag/1.0';
  const maxDepth = siteConfig.max_depth ?? 8;
  // Polite by default — spaces out request starts so we don't hammer remote hosts
  // (and keeps local CPU modest). Override per-site in websites.yaml with request_delay_ms.
  // May be raised below to honor a robots.txt Crawl-delay.
  let requestDelay = siteConfig.request_delay_ms ?? 250;
  const compiled = compileRules(siteConfig.rules);
  const seedHost = new URL(seedUrl).hostname;

  const RESUME_KEY = 'mirror_run_started_at';
  const savedStart = db.prepare('SELECT value FROM site_meta WHERE key=?').get(RESUME_KEY)?.value;
  const isResume = savedStart && (Date.now() - new Date(savedStart).getTime()) < 86400000;
  const runStartedAt = isResume ? savedStart : new Date().toISOString();
  if (!isResume) db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run(RESUME_KEY, runStartedAt);

  let disallowed = new Set();
  if (siteConfig.respect_robots_txt) {
    try {
      const robotsRes = await fetch(`${new URL(seedUrl).origin}/robots.txt`, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(5000) });
      if (robotsRes.ok) {
        const txt = await robotsRes.text();
        disallowed = parseRobots(txt, ua);
        // Honor robots.txt Crawl-delay for our UA group (or *) — be a polite guest.
        let active = false, cd = 0;
        for (const line of txt.split('\n')) {
          const l = line.trim();
          if (/^user-agent:/i.test(l)) { const a = (l.split(':')[1] || '').trim().toLowerCase(); active = a === '*' || a.includes('site2rag'); }
          else if (active && /^crawl-delay:/i.test(l)) { const n = parseFloat((l.split(':')[1] || '').trim()); if (n > 0) cd = Math.max(cd, n * 1000); }
        }
        if (cd > requestDelay) { requestDelay = cd; console.log(`[mirror] ${domain}: honoring robots Crawl-delay ${cd}ms`); }
      }
    } catch {}
  }
  const isRobotsAllowed = (url) => {
    const path = new URL(url).pathname;
    return ![...disallowed].some(d => path.startsWith(d));
  };

  const visited = new Set();
  if (isResume) {
    for (const { url } of db.prepare('SELECT url FROM pages WHERE last_seen_at >= ?').all(runStartedAt)) {
      visited.add(url);
    }
  }

  const discoverQueue = isResume ? [{ url: seedUrl, depth: 0, fromSitemap: false }] : [
    ...priorityQueue.filter(u => inScope(u, siteConfig, seedHost)).map(u => ({ url: u, depth: 0, fromSitemap: true })),
    { url: seedUrl, depth: 0, fromSitemap: false }
  ];
  const staleMs = (siteConfig.check_every_days ?? 3) * 86400000;
  const COMPLETE_KEY = 'last_complete_crawl_at';
  const lastComplete = db.prepare('SELECT value FROM site_meta WHERE key=?').get(COMPLETE_KEY)?.value;
  const staleCutoff = isResume ? runStartedAt : (lastComplete ?? runStartedAt);
  const existingPages = db.prepare('SELECT url, depth FROM pages WHERE gone=0 AND last_seen_at < ?').all(staleCutoff);
  const recheckQueue = [];
  for (const p of existingPages) {
    if (!priorityQueue.includes(p.url) && inScope(p.url, siteConfig, seedHost)) {
      recheckQueue.push({ url: p.url, depth: p.depth || 0, fromSitemap: false });
    }
  }

  const stats = { checked: 0, new_pages: 0, changed: 0, gone: 0 };
  let totalDiscovered = discoverQueue.length + recheckQueue.length;
  const upsertMeta = db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)');
  // Polite default: few parallel fetches — gentle on remote hosts and on our own CPU.
  // Override per-site in websites.yaml with crawl_concurrency.
  const concurrency = siteConfig.crawl_concurrency ?? 4;
  const inFlight = new Set();

  const adapter = await getAdapter(siteConfig);

  const fetchAndExportPage = async (canonical, depth, fromSitemap) => {
    const existing = db.prepare('SELECT * FROM pages WHERE url=?').get(canonical);
    let result;
    try {
      result = await adapter.fetch(canonical, existing);
    } catch (err) {
      console.error(`[mirror] fetch error ${canonical}: ${err.message}`);
      return;
    }
    stats.checked++;
    if (stats.checked % 10 === 0) {
      upsertMeta.run('mirror_progress', JSON.stringify({ checked: visited.size, total: totalDiscovered, new_pages: stats.new_pages, changed: stats.changed, started_at: runStartedAt }));
    }

    const { status, buf, mimeType } = result;
    if (status === 404 || status === 410) {
      if (existing) db.prepare('UPDATE pages SET gone=1, gone_since=COALESCE(gone_since, ?) WHERE url=?').run(new Date().toISOString(), canonical);
      return;
    }
    if (status === 304) {
      db.prepare('UPDATE pages SET last_seen_at=? WHERE url=?').run(new Date().toISOString(), canonical);
      if (existing?.local_path && existing.mime_type?.includes('text/html') && depth < maxDepth) {
        try {
          const cached = readFileSync(existing.local_path, 'utf8');
          const $304 = cheerio.load(cached);
          for (const link of extractLinks($304, canonical)) {
            if (!visited.has(link) && inScope(link, siteConfig, seedHost)) {
              discoverQueue.push({ url: link, depth: depth + 1, fromSitemap: false });
            }
          }
        } catch {}
      }
      return;
    }
    if (!buf) return;

    const contentHash = `sha256:${sha256(buf)}`;
    const mirrorPath = urlToMirrorPath(domain, canonical);
    const pathSlug = urlPathToSlug(new URL(canonical).pathname);
    const isNew = !existing;
    const isChanged = existing && existing.content_hash !== contentHash;
    let savedPath = mirrorPath;
    if (isNew || isChanged) {
      try {
        mkdirSync(dirname(mirrorPath), { recursive: true });
        writeFileSync(mirrorPath, buf);
        if (isNew) stats.new_pages++; else stats.changed++;
      } catch (writeErr) {
        if (writeErr.code === 'EEXIST') {
          const ext = extname(mirrorPath);
          const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
          savedPath = join(dirname(dirname(mirrorPath)), `${hash}${ext || '.html'}`);
          try {
            mkdirSync(dirname(savedPath), { recursive: true });
            writeFileSync(savedPath, buf);
            if (isNew) stats.new_pages++; else stats.changed++;
          } catch (e2) {
            console.warn(`[mirror] skipping ${canonical}: ${e2.message}`);
            return;
          }
        } else {
          console.warn(`[mirror] skipping ${canonical}: ${writeErr.message}`);
          return;
        }
      }
      if (mimeType === 'application/pdf') {
        const docxPreferred = compiled.prefer_format === 'docx' &&
          db.prepare('SELECT 1 FROM pages WHERE url=? AND gone=0').get(canonical.replace(/\.pdf$/i, '.docx'));
        if (!docxPreferred && compiled.prefer_format !== 'html') {
          try {
            const metrics = await Promise.race([
              scorePdf(savedPath),
              new Promise((_, rej) => setTimeout(() => rej(new Error('score timeout')), SCORE_TIMEOUT_MS))
            ]);
            saveQualityScore(db, canonical, contentHash, metrics);
            maybeQueue(db, canonical, contentHash, metrics.composite_score, 0.7, metrics.language);
          } catch (scoreErr) {
            console.warn(`[mirror] score failed ${canonical}: ${scoreErr.message}`);
          }
        }
      }
    }
    let page_role = null, word_count_clean = null, classify_method = null;
    if ((isNew || isChanged) && mimeType?.includes('text/html') && siteConfig.classify?.enabled !== false) {
      try {
        const wordThreshold = siteConfig.classify?.word_threshold ?? 200;
        ({ role: page_role, classify_method, word_count_clean } = classifyPage(buf.toString('utf8'), canonical, compiled, wordThreshold, db));
      } catch (e) { console.warn(`[mirror] classify ${canonical}: ${e.message}`); }
    }
    upsertPage(db, {
      url: canonical, path_slug: pathSlug, local_path: savedPath,
      from_sitemap: fromSitemap ? 1 : 0,
      etag: result.etag, last_modified: result.lastModified,
      content_hash: contentHash, mime_type: mimeType, status_code: status,
      depth, page_role, word_count_clean
    });
    if (classify_method) {
      db.prepare('UPDATE pages SET classify_method=? WHERE url=?').run(classify_method, canonical);
    }
    if (isNew || isChanged) {
      const pageRow = { url: canonical, path_slug: pathSlug, local_path: savedPath,
        content_hash: contentHash, mime_type: mimeType, depth, from_sitemap: fromSitemap ? 1 : 0,
        page_role, last_seen_at: new Date().toISOString(), backup_url: null,
        backup_archived_at: null, archive_only: 0, last_changed_at: null };
      if (compiled.prefer_format !== 'html') {
        if (mimeType === 'application/pdf') {
          exportTextPdf(db, siteConfig, pageRow).catch(e =>
            console.warn(`[mirror] pdf export ${canonical}: ${e.message}`)
          );
        } else if (mimeType?.includes('wordprocessingml') || canonical.endsWith('.docx')) {
          exportDocx(db, siteConfig, pageRow).catch(e =>
            console.warn(`[mirror] docx export ${canonical}: ${e.message}`)
          );
        }
      }
    }
    if (mimeType?.includes('text/html') && depth < maxDepth) {
      const $ = cheerio.load(buf.toString('utf8'));
      for (const link of extractLinks($, canonical)) {
        if (!visited.has(link) && inScope(link, siteConfig, seedHost)) {
          discoverQueue.push({ url: link, depth: depth + 1, fromSitemap: false });
          totalDiscovered++;
        }
      }
    }
  };

  while (discoverQueue.length > 0 || recheckQueue.length > 0 || inFlight.size > 0) {
    if (inFlight.size >= concurrency || (discoverQueue.length === 0 && recheckQueue.length === 0)) {
      await Promise.race(inFlight);
      continue;
    }
    const { url, depth, fromSitemap } = discoverQueue.length > 0 ? discoverQueue.shift() : recheckQueue.shift();
    let canonical;
    try { canonical = stripQueryParams(compiled, url); new URL(canonical); } catch {
      console.warn(`[mirror] skipping malformed URL: ${url}`); continue;
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (depth > maxDepth) continue;
    if (siteConfig.respect_robots_txt && !isRobotsAllowed(canonical)) continue;
    if (applyFollowOverride(compiled, canonical) === false) continue;
    const p = fetchAndExportPage(canonical, depth, fromSitemap).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (requestDelay > 0) await new Promise(r => setTimeout(r, requestDelay));
  }

  await adapter.close();
  const ranToCompletion = discoverQueue.length === 0 && recheckQueue.length === 0;
  if (ranToCompletion) {
    const safeGoneCutoff = new Date(Date.now() - staleMs * 3).toISOString();
    stats.gone = markGoneUrls(db, safeGoneCutoff);
    db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run(COMPLETE_KEY, runStartedAt);
    db.prepare('DELETE FROM site_meta WHERE key=?').run(RESUME_KEY);
    db.prepare('DELETE FROM site_meta WHERE key=?').run('mirror_progress');
  }
  return stats;
};
