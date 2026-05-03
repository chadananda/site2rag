// One-time anchor-text backfill: scans crawled HTML to populate hosts table for PDF summarization context. Exports: backfillHostsFromMirror. Deps: cheerio, db, fs
import { existsSync, readFileSync } from 'fs';

const log = (msg) => console.log(`[pdf-upgrade] ${new Date().toISOString().slice(0,19)} ${msg}`);

/** Scan all local HTML pages and insert PDF link anchor text into hosts table. Runs once per DB. */
export const backfillHostsFromMirror = async (db, domain) => {
  const already = db.prepare("SELECT value FROM site_meta WHERE key='hosts_backfilled_at'").get();
  if (already) return;

  const { load } = await import('cheerio');
  const htmlPages = db.prepare(
    "SELECT url, local_path FROM pages WHERE mime_type LIKE 'text/html%' AND local_path IS NOT NULL AND gone=0"
  ).all();

  let inserted = 0;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO hosts (host_url, hosted_url, hosted_title, detected_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  const insertMany = db.transaction((rows) => { for (const r of rows) insert.run(...r); });

  for (const { url: hostUrl, local_path } of htmlPages) {
    if (!existsSync(local_path)) continue;
    let html;
    try { html = readFileSync(local_path, 'utf8'); } catch { continue; }
    if (!html.includes('.pdf')) continue;

    const $ = load(html);
    const batch = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.toLowerCase().includes('.pdf')) return;
      let hostedUrl;
      try { hostedUrl = new URL(href, hostUrl).toString().split('#')[0]; } catch { return; }
      if (!hostedUrl.toLowerCase().endsWith('.pdf')) return;
      const text = $(el).text().trim() || href.split('/').pop();
      batch.push([hostUrl, hostedUrl, text, now]);
    });
    if (batch.length) { insertMany(batch); inserted += batch.length; }
  }

  db.prepare("INSERT OR REPLACE INTO site_meta (key, value) VALUES ('hosts_backfilled_at', ?)").run(now);
  log(`Backfilled hosts: ${inserted} PDF links from ${htmlPages.length} HTML pages`);
};
