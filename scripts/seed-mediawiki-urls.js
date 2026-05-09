// Seed MediaWiki article URLs into pages table via the MediaWiki API.
// Usage: SITE2RAG_ROOT=/tank/site2rag node scripts/seed-mediawiki-urls.js <domain>
// Calls api.php?action=query&list=allpages to enumerate all articles, then inserts them
// into the pages table at depth=0 with last_seen_at far in the past so they get rechecked.
import { fetch } from 'undici';
import Database from 'better-sqlite3';
import { join } from 'path';
import { metaDir } from '../src/config.js';

const domain = process.argv[2];
if (!domain) { console.error('Usage: node seed-mediawiki-urls.js <domain>'); process.exit(1); }

const MEDIAWIKI_ORIGINS = {
  'bahaipedia.org': 'https://bahaipedia.org',
  'bahai.works': 'https://bahai.works',
};
const origin = MEDIAWIKI_ORIGINS[domain];
if (!origin) { console.error(`Unknown MediaWiki domain: ${domain}. Add it to MEDIAWIKI_ORIGINS.`); process.exit(1); }

const db = new Database(join(metaDir(domain), 'site.sqlite'));
db.pragma('journal_mode = WAL');

const insertOrIgnore = db.prepare(`
  INSERT OR IGNORE INTO pages (url, path_slug, depth, first_seen_at, last_seen_at, gone)
  VALUES (?, ?, 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 0)
`);
const insertBatch = db.transaction((rows) => {
  for (const { url, slug } of rows) insertOrIgnore.run(url, slug);
});

let total = 0;
let apcontinue = null;
let page = 0;

console.log(`Seeding ${domain} from MediaWiki API...`);
do {
  const params = new URLSearchParams({
    action: 'query',
    list: 'allpages',
    aplimit: '500',
    apnamespace: '0',
    format: 'json',
    ...(apcontinue ? { apcontinue } : {}),
  });
  const url = `${origin}/api.php?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();

  const articles = data.query?.allpages ?? [];
  const rows = articles.map(a => {
    const articleUrl = `${origin}/wiki/${encodeURIComponent(a.title.replace(/ /g, '_'))}`;
    return { url: articleUrl, slug: a.title.replace(/ /g, '_').slice(0, 200) };
  });
  insertBatch(rows);
  total += rows.length;
  page++;
  if (page % 10 === 0) process.stdout.write(`  ${total} articles seeded...\r`);

  apcontinue = data['query-continue']?.allpages?.apcontinue
    ?? data.continue?.apcontinue
    ?? null;
} while (apcontinue);

console.log(`\nDone. Seeded ${total} article URLs for ${domain}.`);
db.close();
