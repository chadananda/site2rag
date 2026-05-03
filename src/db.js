// SQLite database layer -- opens/creates site.sqlite, runs migrations, exposes statement accessors.
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { metaDir } from './config.js';
// Schema DDL
const DDL = `
CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT, finished_at TEXT, status TEXT,
  sitemap_added INT DEFAULT 0, sitemap_changed INT DEFAULT 0, sitemap_removed INT DEFAULT 0,
  pages_checked INT DEFAULT 0, pages_new INT DEFAULT 0, pages_changed INT DEFAULT 0, pages_gone INT DEFAULT 0,
  pages_gc_deleted INT DEFAULT 0,
  pages_classified INT DEFAULT 0, host_pages_detected INT DEFAULT 0,
  exports_written INT DEFAULT 0, exports_skipped INT DEFAULT 0, exports_failed INT DEFAULT 0,
  ocr_pages INT DEFAULT 0, ocr_pages_flagged INT DEFAULT 0, reconciler_calls INT DEFAULT 0,
  retention_frozen INT DEFAULT 0, retention_net_loss INT DEFAULT 0,
  archive_uploaded INT DEFAULT 0, archive_skipped INT DEFAULT 0, archive_failed INT DEFAULT 0,
  message TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  path_slug TEXT,
  local_path TEXT,
  from_sitemap INT DEFAULT 0,
  sitemap_lastmod TEXT,
  etag TEXT, last_modified TEXT,
  content_hash TEXT,
  mime_type TEXT,
  status_code INT,
  depth INT,
  first_seen_at TEXT, last_seen_at TEXT, last_changed_at TEXT,
  gone INT DEFAULT 0,
  gone_since TEXT,
  archive_only INT DEFAULT 0,
  backup_url TEXT, backup_etag TEXT, backup_archived_at TEXT,
  page_role TEXT,
  classify_method TEXT,
  classify_rationale TEXT,
  word_count_clean INT
);
CREATE TABLE IF NOT EXISTS hosts (
  host_url TEXT NOT NULL,
  hosted_url TEXT NOT NULL,
  hosted_title TEXT,
  detected_at TEXT,
  PRIMARY KEY (host_url, hosted_url)
);
CREATE TABLE IF NOT EXISTS sitemaps (
  url TEXT PRIMARY KEY,
  lastmod TEXT,
  source_sitemap TEXT,
  first_seen_at TEXT, last_seen_at TEXT,
  removed INT DEFAULT 0,
  removed_at TEXT
);
CREATE TABLE IF NOT EXISTS exports (
  url TEXT PRIMARY KEY,
  md_path TEXT,
  source_hash TEXT,
  md_hash TEXT,
  exported_at TEXT,
  conversion_method TEXT,
  word_count INT,
  ocr_used INT DEFAULT 0,
  ocr_engines TEXT,
  reconciler TEXT,
  pages INT,
  agreement_avg REAL,
  flagged_pages TEXT,
  host_page_url TEXT,
  status TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS ocr_pages (
  doc_url TEXT NOT NULL,
  page_no INT NOT NULL,
  engine TEXT NOT NULL,
  text_md TEXT,
  confidence REAL,
  bboxes_json TEXT,
  cached_at TEXT,
  bytes INT,
  PRIMARY KEY (doc_url, page_no, engine)
);
CREATE TABLE IF NOT EXISTS assets (
  hash TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  original_url TEXT,
  mime_type TEXT,
  bytes INT,
  first_seen_at TEXT, last_seen_at TEXT,
  ref_count INT DEFAULT 0,
  skipped_reason TEXT,
  gone_since TEXT,
  backup_url TEXT, backup_etag TEXT, backup_archived_at TEXT
);
CREATE TABLE IF NOT EXISTS pdf_quality (
  url TEXT PRIMARY KEY,
  content_hash TEXT,
  scored_at TEXT,
  avg_chars_per_page REAL,
  readable_pages_pct REAL,
  has_text_layer INT,
  word_quality_estimate REAL,
  composite_score REAL,
  pages INT,
  pdf_title TEXT,
  excerpt TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_mime_gone ON pages(mime_type, gone);
CREATE INDEX IF NOT EXISTS idx_pages_last_seen ON pages(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_hosts_hosted_url ON hosts(hosted_url);
CREATE INDEX IF NOT EXISTS idx_pdf_quality_score ON pdf_quality(composite_score);
CREATE TABLE IF NOT EXISTS pdf_upgrade_queue (
  url TEXT PRIMARY KEY,
  content_hash TEXT,
  priority REAL,
  status TEXT DEFAULT 'pending',
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  upgraded_pdf_path TEXT,
  before_score REAL,
  after_score REAL,
  score_improvement REAL,
  pages_processed INT,
  method TEXT,
  bad_sample TEXT,
  emailed INT DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS asset_refs (
  asset_hash TEXT NOT NULL,
  referencing_url TEXT NOT NULL,
  PRIMARY KEY (asset_hash, referencing_url)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  stage TEXT,
  url TEXT,
  page_no INT,
  provider TEXT, model TEXT,
  tokens_in INT, tokens_out INT, cost_usd REAL,
  ok INT,
  called_at TEXT
);
`;
/** Run ALTER TABLE migrations for columns added after initial schema. */
const migrate = (db) => {
  const addCol = (table, col, type) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
  };
  addCol('pdf_quality', 'pdf_title', 'TEXT');
  addCol('pdf_quality', 'excerpt', 'TEXT');
  addCol('pdf_quality', 'skip', 'INT DEFAULT 0');
  addCol('pdf_quality', 'ai_summary', 'TEXT');
  addCol('pdf_quality', 'ai_author', 'TEXT');
  addCol('pdf_quality', 'ai_summarized_at', 'TEXT');
  addCol('pdf_quality', 'thumbnail_path', 'TEXT');
  addCol('pdf_quality', 'summary_tier', 'TEXT');   // 'free' | 'haiku'
  addCol('pdf_quality', 'ai_language', 'TEXT');
  // Fix readable_pages_pct stored as 0-100 instead of 0-1; recompute composite_score
  db.exec(`
    UPDATE pdf_quality
    SET readable_pages_pct = readable_pages_pct / 100.0,
        composite_score = ROUND(
          0.4 * COALESCE(word_quality_estimate, 0)
          + 0.3 * (readable_pages_pct / 100.0)
          + 0.2 * MIN(COALESCE(avg_chars_per_page, 0) / 500.0, 1.0)
          + 0.1 * COALESCE(has_text_layer, 0),
          2)
    WHERE readable_pages_pct > 1
  `);
};

/** Open (or create) site.sqlite for a domain. Returns better-sqlite3 db instance. */
export const openDb = (domain) => {
  const dir = metaDir(domain);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'site.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  migrate(db);
  return db;
};
/** Insert a new run row, return run id. */
export const startRun = (db) => {
  const stmt = db.prepare('INSERT INTO runs (started_at, status) VALUES (?, ?)');
  return stmt.run(new Date().toISOString(), 'running').lastInsertRowid;
};
/** Finish a run row. */
export const finishRun = (db, id, status, fields = {}) => {
  const cols = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(fields);
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?${cols ? ', ' + cols : ''} WHERE id = ?`)
    .run(new Date().toISOString(), status, ...vals, id);
};
/** Upsert a page row. */
export const upsertPage = (db, page) => {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM pages WHERE url = ?').get(page.url);
  if (!existing) {
    db.prepare(`INSERT INTO pages (url, path_slug, local_path, from_sitemap, sitemap_lastmod, etag, last_modified, content_hash, mime_type, status_code, depth, first_seen_at, last_seen_at, last_changed_at, gone, page_role, word_count_clean)
      VALUES (@url, @path_slug, @local_path, @from_sitemap, @sitemap_lastmod, @etag, @last_modified, @content_hash, @mime_type, @status_code, @depth, @first_seen_at, @last_seen_at, @last_changed_at, @gone, @page_role, @word_count_clean)`)
      .run({ sitemap_lastmod: null, etag: null, last_modified: null, content_hash: null, mime_type: null, status_code: null, depth: 0, path_slug: null, local_path: null, from_sitemap: 0, page_role: null, word_count_clean: null, first_seen_at: now, last_seen_at: now, last_changed_at: now, gone: 0, ...page });
  } else {
    const changed = page.content_hash && page.content_hash !== existing.content_hash;
    db.prepare(`UPDATE pages SET path_slug=@path_slug, local_path=@local_path, from_sitemap=@from_sitemap, sitemap_lastmod=@sitemap_lastmod, etag=@etag, last_modified=@last_modified, content_hash=@content_hash, mime_type=@mime_type, status_code=@status_code, depth=@depth, last_seen_at=@last_seen_at, last_changed_at=@last_changed_at, gone=0, gone_since=NULL, page_role=COALESCE(@page_role, page_role), word_count_clean=COALESCE(@word_count_clean, word_count_clean) WHERE url=@url`)
      .run({ sitemap_lastmod: null, etag: null, last_modified: null, content_hash: null, mime_type: null, status_code: null, depth: 0, path_slug: null, local_path: null, from_sitemap: 0, page_role: null, word_count_clean: null, ...page, last_seen_at: now, last_changed_at: changed ? now : existing.last_changed_at });
  }
};
/** Mark URLs as gone that haven't been seen in this run (last_seen_at < run_start). */
export const markGoneUrls = (db, runStartedAt) => {
  const now = new Date().toISOString();
  // Never mark gone: pages in the upgrade queue (being actively processed)
  return db.prepare(`UPDATE pages SET gone=1, gone_since=? WHERE last_seen_at < ? AND gone=0
    AND url NOT IN (SELECT url FROM pdf_upgrade_queue WHERE status IN ('pending','processing','done'))`)
    .run(now, runStartedAt).changes;
};
/** Get site_meta value. */
export const getMeta = (db, key) => db.prepare('SELECT value FROM site_meta WHERE key=?').get(key)?.value;
/** Set site_meta value. */
export const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)').run(key, value);
/** Upsert sitemap entry. */
export const upsertSitemap = (db, entry) => {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM sitemaps WHERE url=?').get(entry.url);
  if (!existing) {
    db.prepare('INSERT INTO sitemaps (url, lastmod, source_sitemap, first_seen_at, last_seen_at) VALUES (@url, @lastmod, @source_sitemap, @first_seen_at, @last_seen_at)')
      .run({ ...entry, first_seen_at: now, last_seen_at: now });
  } else {
    db.prepare('UPDATE sitemaps SET lastmod=@lastmod, source_sitemap=@source_sitemap, last_seen_at=@last_seen_at, removed=0, removed_at=NULL WHERE url=@url')
      .run({ ...entry, last_seen_at: now });
  }
};
/** Mark sitemap URLs removed that weren't seen in current diff. */
export const markSitemapRemoved = (db, seenUrls) => {
  const now = new Date().toISOString();
  const placeholders = seenUrls.map(() => '?').join(',');
  const clause = seenUrls.length ? `AND url NOT IN (${placeholders})` : '';
  return db.prepare(`UPDATE sitemaps SET removed=1, removed_at=? WHERE removed=0 ${clause}`)
    .run(now, ...seenUrls).changes;
};
/** Upsert export row. */
export const upsertExport = (db, exp) => {
  db.prepare(`INSERT OR REPLACE INTO exports (url, md_path, source_hash, md_hash, exported_at, conversion_method, word_count, ocr_used, ocr_engines, reconciler, pages, agreement_avg, flagged_pages, host_page_url, status, error)
    VALUES (@url, @md_path, @source_hash, @md_hash, @exported_at, @conversion_method, @word_count, @ocr_used, @ocr_engines, @reconciler, @pages, @agreement_avg, @flagged_pages, @host_page_url, @status, @error)`)
    .run(exp);
};
/** Get or cache OCR page result. Returns cached result or null. */
export const getOcrPage = (db, docUrl, pageNo, engine) =>
  db.prepare('SELECT * FROM ocr_pages WHERE doc_url=? AND page_no=? AND engine=?').get(docUrl, pageNo, engine);
/** Save OCR page result to cache. */
export const saveOcrPage = (db, { docUrl, pageNo, engine, text_md, confidence, bboxes_json, bytes }) => {
  db.prepare('INSERT OR REPLACE INTO ocr_pages (doc_url, page_no, engine, text_md, confidence, bboxes_json, cached_at, bytes) VALUES (?,?,?,?,?,?,?,?)')
    .run(docUrl, pageNo, engine, text_md, confidence, bboxes_json, new Date().toISOString(), bytes);
};
/** Log an LLM call. */
export const logLlmCall = (db, call) => {
  db.prepare('INSERT INTO llm_calls (stage, url, page_no, provider, model, tokens_in, tokens_out, cost_usd, ok, called_at) VALUES (@stage, @url, @page_no, @provider, @model, @tokens_in, @tokens_out, @cost_usd, @ok, @called_at)')
    .run({ called_at: new Date().toISOString(), ...call });
};
const MODEL_RATES = {
  'claude-haiku-4-5-20251001': [0.80, 4.00],
  'claude-haiku-3-5-20241022': [0.80, 4.00],
  'claude-sonnet-4-5': [3.00, 15.00],
  'claude-sonnet-4-5-20251001': [3.00, 15.00],
  'claude-opus-4-7': [15.00, 75.00],
  'claude-opus-4-5': [15.00, 75.00],
  'mistral-ocr-latest': [1.00, 1.00],
};
/** Compute API cost in USD from token counts and model name. */
export const llmCost = (model, tokensIn, tokensOut) => {
  const [inRate, outRate] = MODEL_RATES[model] || [3.00, 15.00];
  return (tokensIn || 0) / 1e6 * inRate + (tokensOut || 0) / 1e6 * outRate;
};
/** Upsert asset row. */
export const upsertAsset = (db, asset) => {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM assets WHERE hash=?').get(asset.hash);
  if (!existing) {
    db.prepare('INSERT INTO assets (hash, path, original_url, mime_type, bytes, first_seen_at, last_seen_at, ref_count) VALUES (@hash, @path, @original_url, @mime_type, @bytes, @first_seen_at, @last_seen_at, @ref_count)')
      .run({ ...asset, first_seen_at: now, last_seen_at: now, ref_count: 0 });
  } else {
    db.prepare('UPDATE assets SET last_seen_at=?, gone_since=NULL WHERE hash=?').run(now, asset.hash);
  }
};
/** Add asset reference. */
export const addAssetRef = (db, hash, refUrl) => {
  db.prepare('INSERT OR IGNORE INTO asset_refs (asset_hash, referencing_url) VALUES (?, ?)').run(hash, refUrl);
  db.prepare('UPDATE assets SET ref_count = (SELECT COUNT(*) FROM asset_refs WHERE asset_hash=?) WHERE hash=?').run(hash, hash);
};
