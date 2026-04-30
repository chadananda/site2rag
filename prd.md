# site2rag — Claude Code spec

Long-running PM2 service on tower-nas. Mirrors websites + assets + S3 archive. Produces RAG-ready MD with rich frontmatter. Replaces v0.5.x CLI at github.com/chadananda/site2rag.

Heavy LLM enhancement (context disambiguation, semantic enrichment) is downstream batch — NOT this project. Runtime LLM use here is OCR only.

## Invariants

- URL → mirror path is a pure function (deterministic, no DB lookup).
- MD slug is a pure function of URL path (no hash, no collision suffix).
- Mirror = Archive. Same files, same retention lifecycle.
- Rules-first runtime. No LLM in classification. LLM only for OCR engines + reconciler.
- Every document MD paragraph back-links to source URL (with `#page=N` for PDFs).
- Every MD frontmatter carries both `source_url` and `backup_url`.
- Edits propagate; only `gone` URLs are subject to retention deletion.
- 90-day grace + degradation freeze gates all deletions (local + S3 atomic).
- `_meta/` and `_assets/` underscore-prefixed → never collide with URL paths.
- PM2 file-watch is OFF on all site2rag dirs (mirror writes would loop).
- `git push` to GitHub is the deployment action; `site2rag-updater` polls and applies. `npm install` postinstall handles initial PM2 registration idempotently.

## Layout

`SITE2RAG_ROOT` = `<largest-tower-nas-mount>/site2rag/`. App resolves root from env var or `path.resolve(__dirname, '..')`.

```
site2rag/
  app/
    package.json
    ecosystem.config.cjs
    .env                          # gitignored
    bin/
      setup.js                    # postinstall hook; idempotent PM2 registration
      updater.js                  # PM2-supervised auto-update watchdog
    src/{index,sitemap,mirror,assets,classify,export-html,export-doc,archive,retain,rules,metadata}.js
    src/ocr/{engines,reconcile}.js
  websites.yaml                   # only config file
  logs/
  websites_mirror/<domain>/
    _meta/{site.sqlite,status.yaml,last-run.log}
    _meta/raster/<doc-hash>/page-NNN.png
    _assets/<sha[0:2]>/<sha>.<ext>
    <url-path>                    # mirrors URL exactly
  websites_md/<domain>/<slug>.md  # flat per domain
```

## URL → path mapping

- `https://docs.python.org/3/library/asyncio.html` → `websites_mirror/docs.python.org/3/library/asyncio.html`
- Trailing `/` or no extension → append `index.html`
- Query string → hash and append: `page.html?id=42` → `page__a3f1.html`
- Document binaries (PDF/etc.) keep native extension at native path
- MD slug = URL path with `/` → `-`. Last write wins on collision; log warning.

## Pipeline (per scheduler tick, per due site)

```
Sitemap → Mirror → Assets → Classify → Export(if export_md) → Archive(if archive.enabled) → Retain → status.yaml
```

Tick every 15 min. Per-site cadence: `check_every_days` (default 3). One site at a time (`max_concurrent_sites: 1`). Sitemap diff every `sitemap.diff_every_hours` (default 24).

## Configuration: `websites.yaml`

```yaml
version: 1
defaults:
  check_every_days: 3
  timeout_seconds: 1800
  user_agent: site2rag/1.0
  max_concurrent_sites: 1
  same_domain_only: true
  max_depth: 8
  respect_robots_txt: true
  sitemap:
    enabled: true
    diff_every_hours: 24
    fallback_to_crawl: true
    include_languages: []         # [] = all; e.g. ["en", "es"] uses hreflang
  classify:
    enabled: true
    word_threshold: 200
  ocr:
    mode: reconcile               # single | multi | vote | reconcile
    engines: [mistral, claude]
    pass_bounding_boxes: true
    confidence_short_circuit: true
    agreement_skip_threshold: 0.97
    confidence_skip_threshold: 0.92
    reconciler: claude
    min_text_chars_per_page: 50
    flag_threshold: 0.85
  assets:
    enabled: true
    types: [image, document]      # image | document | media
    image_max_bytes: 10485760
    dedupe_by_hash: true
    rewrite_links: true
  archive:
    enabled: true
    s3_endpoint: https://s3.tower-nas.local
    s3_bucket: site2rag-archive
    s3_region: us-east-1
    s3_access_key_env: S3_ACCESS_KEY
    s3_secret_key_env: S3_SECRET_KEY
    public_url_template: https://archive.tower-nas.example.com/{domain}/{path}
    upload_html: true
    upload_documents: true
    upload_assets: true
    upload_md: false
    versioning: true
    rewrite_html_assets: false
    respect_archive_block: true
  metadata:
    sources: [json_ld, opengraph, meta_tags, byline]
    extract_author_bio: true
  document:
    backlink_format: both         # visible | comment | both
    backlink_granularity: paragraph   # paragraph | page
  retention:
    gone_grace_days: 90
    freeze_on_degradation:
      enabled: true
      net_loss_threshold_pct: 10
      net_loss_min_pages: 50
      window_days: 30
    preserve_always: false
  llm:
    providers:
      claude:
        api_key_env: ANTHROPIC_API_KEY
        models: { vision: claude-opus-4-7 }
      mistral:
        api_key_env: MISTRAL_API_KEY
        models: { ocr: mistral-ocr-latest }
    rate_limit: { requests_per_minute: 60 }
sites:
  - domain: example.com           # folder name; suffix to disambiguate
    url: https://example.com/
    enabled: true
    export_md: true
    include: ["/docs/"]           # URL path prefixes
    exclude: ["/admin/"]
    max_depth: 4
    check_every_days: 7
    rules: { ... }                # see Site Rules
    ocr: { ... }                  # per-site override
    archive: { ... }              # per-site override
    retention: { preserve_always: false }
    tags: [docs]
```

Per-site keys merge over `defaults`. `domain` is required. `url` is seed (used only when sitemap absent or `fallback_to_crawl: true`). `include`/`exclude` = URL path prefixes; exclude wins.

## Stage specs

### Sitemap

1. Discover via robots.txt `Sitemap:` → `/sitemap.xml` → `/sitemap_index.xml` → variants (`/sitemap-index.xml`, `/sitemap1.xml`). Recurse indexes.
2. Parse to `sitemaps` table with `<lastmod>` and source-sitemap URL.
3. Diff against cached snapshot every `diff_every_hours`:
   - **Added** → queue fetch this tick.
   - **Removed** → mark `gone=1`, `gone_since=now`.
   - **`<lastmod>` advanced** → queue re-fetch (overrides 304).
4. Sitemap URLs queue-priority over crawl-discovered.
5. URLs from sitemap have `pages.from_sitemap=1`.
6. No sitemap + `fallback_to_crawl: true` → seed crawl. Else skip site, log status.

### Mirror

Custom Node crawler. Open `_meta/site.sqlite`. Read robots.txt if `respect_robots_txt: true`. Seed queue from sitemap delta first, then site `url`.

Per URL in scope:
1. Conditional GET (etag/last_modified).
2. `304 Not Modified` → mark seen, skip body.
3. `200` → fetch, sha256 body, compare to `pages.content_hash`.
   - Unchanged → mark seen, skip write.
   - Changed/new → write to mirror path, update `pages` row.
4. HTML → extract links via cheerio. Filter by include/exclude/depth/`same_domain_only`. Enqueue new (skip already-from-sitemap).
5. URLs in DB unseen this run AND not in sitemap → `gone=1`, `gone_since=now`. Leave file on disk; retain stage handles deletion.

### Assets

After Mirror. From cleaned (post-rules) HTML content of each page in scope:

- `<img src>` → image; size-cap by `assets.image_max_bytes`. Skip oversize, log.
- `<a href>` to PDF/doc/docx/odt/epub/txt MIME → document. PDFs also flow through OCR pipeline.
- `media` type (audio/video) only when configured.
- Follow CDN redirects (S3, CloudFlare, etc.).

Storage: `_assets/<sha[0:2]>/<sha>.<ext>`, sha256 of body. Dedupe by hash; one file regardless of how many pages reference. Track `(asset_hash, referencing_url)` rows in `asset_refs`. Update `assets.ref_count`.

When `assets.rewrite_links: true`: in MD output, rewrite asset URLs to local relative path; preserve original URL in trailing HTML comment:
```
![alt](../_assets/9f/9f3a...d2.png)<!-- src: https://example.com/img/architecture.png -->
```

### Classify

Rules-first. Deterministic. No runtime LLM.

Roles: `content` | `host_page` | `redirect` | `index`.

Order:
1. `rules.classify_overrides` URL pattern match → set role, skip rest.
2. Chrome strip: `rules.content_selector` + `rules.exclude_selectors` → Mozilla Readability → body minus (`nav`, `header`, `footer`, `aside`).
3. Compute features: `word_count`, `doc_link_count` (same-domain links to PDF/doc/etc.), `outbound_link_count`, `title_doc_overlap` (similarity of `<title>` to linked doc filename or first-page/document title), `text_to_link_ratio`.
4. Heuristic decision:
   - `word_count < classify.word_threshold` AND prominent same-domain doc link AND high `title_doc_overlap` (or `doc_link_count >= 1` for multi-doc landers) → `host_page`.
   - `word_count < 50` AND single dominant link → `redirect`.
   - High link density + low prose → `index`.
   - Else → `content`.
5. `host_page` → for each same-domain doc link in cleaned content, insert row into `hosts(host_url, hosted_url, hosted_title, detected_at)`. One host page may host many.

Misclassifications corrected by adding a `classify_overrides` rule. No LLM fallback.

### Export (when `site.export_md: true`)

Three sub-stages: HTML→MD (content/index/host_page), Document→MD (PDFs).

Output filename = path-slug. Skip when `exports.source_hash == pages.content_hash`.

#### HTML → MD

1. Parse with cheerio.
2. Apply rules: `content_selector`, `exclude_selectors`, `title_selector`, `date_selector`.
3. Fallback: Readability output → body-minus-chrome.
4. Strip `<script>`, `<style>`, comments.
5. Convert via turndown + GFM plugin: fenced code, GFM tables, no reference-style links.
6. host_page frontmatter: `page_role: host_page`, `hosts: [{url, backup_url, title, md_path}, ...]`.
7. `conversion_method`: `rules+turndown` | `readability+turndown` | `cheerio+turndown`.

#### Document (PDF) → MD

1. Try `pdf-parse`. If `avg_chars_per_page >= ocr.min_text_chars_per_page` → text PDF, use extracted text + page boundaries directly.
2. Image PDF → rasterize all pages via pdfjs-dist (or pdftoppm) → cache `_meta/raster/<doc-hash>/page-NNN.png`.
3. Run `ocr.engines` in parallel per page. Each engine returns `{text_md, confidence, bboxes_json?}`. Cache in `ocr_pages(doc_url, page_no, engine)`.
4. Per-page confidence-aware merge:
   - Compute Levenshtein agreement (normalized text) across engines.
   - If `agreement >= ocr.agreement_skip_threshold` AND `max(engine_confidence) >= ocr.confidence_skip_threshold` → take highest-confidence engine; `conversion_method: ocr+confidence-merge`. **No reconciler call.**
   - Else if `mode: vote` → highest-confidence engine wins.
   - Else (`mode: reconcile`) → call reconciler.
5. Reconciler input: page PNG + per-engine `{name, transcript, confidence, bboxes?}` (bboxes when `pass_bounding_boxes: true`). Strict JSON return: `{markdown, agreement_score, unresolved_spans[]}`. Wrap unresolved spans in `<!-- unresolved: ... -->` in output.
6. Pages with reconciler `agreement_score < ocr.flag_threshold` → add page number to `exports.flagged_pages` (advisory).
7. Assemble MD with paragraph back-links per `document.backlink_format` × `backlink_granularity`:
   - `paragraph + visible`: `text. [↗ p.N](source_url#page=N)`
   - `paragraph + comment`: `text.\n<!-- src: {"url":"...","page":N,"para":M} -->`
   - `paragraph + both`: visible marker + comment
   - `page` (granularity): `## Page N [↗](source_url#page=N)\n\n` headers, paragraphs underneath
8. Cross-link: if `hosts` has row with this doc as `hosted_url`, frontmatter gets `host_page_url`, `host_page_backup_url`, `host_page_title`, `host_page_md`. Body NOT modified.
9. Write MD; update `exports`.

#### OCR engines

| Engine | Local? | Confidence | Bboxes |
|---|---|---|---|
| tesseract | yes (tesseract.js) | per-word | yes |
| mistral | no (Mistral OCR API) | per-region | yes |
| claude | no (`@anthropic-ai/sdk`) | self-reported per-page (prompted) | no |

Reconciler default: `claude` (vision). Confidence aggregation for short-circuit: min-of-engines.

#### Reconciler prompt template

Input: page PNG + per-engine `{name, transcript, confidence, bboxes?}`.

Instruction: produce canonical Markdown for this page; preserve headings/lists/tables/paragraph order; weight engines by confidence; verify against image; wrap unresolvable spans in `<!-- unresolved: ... -->`.

Output: strict JSON `{markdown, agreement_score, unresolved_spans}`.

#### OCR caching

- `_meta/raster/<doc-hash>/page-NNN.png` for rasterized pages
- `ocr_pages(doc_url, page_no, engine)` keys per-engine output (text + confidence + bboxes_json)
- Reconciler outputs are derived; can re-run reconciler from cache without re-OCR (e.g. when changing reconciler model)

### Archive (when `archive.enabled: true`)

After Export. Push changed mirror files to S3.

For each file in mirror tree (filtered by `upload_html`/`upload_documents`/`upload_assets`):
1. Compare local `content_hash` to row's `backup_etag`.
2. Match → skip.
3. Mismatch → PUT to S3 with `Content-Type` from `mime_type`. Use `If-None-Match`/`If-Match` to avoid races.
4. Record returned ETag and timestamp on row.

S3 key = `<bucket>/<domain>/<url-path>` (mirrors URL path exactly). `backup_url` = `archive.public_url_template` filled with `{domain}` and `{path}`; cached on row, no live S3 lookup needed.

`rewrite_html_assets: true` → rewrite `<img src>`, `<link href>`, etc. to `backup_url`s before upload (only for assets that have been archived). Local mirror HTML never rewritten.

`respect_archive_block: true` → honor `X-Robots-Tag: noarchive` header AND `<meta name="robots" content="noarchive">`. Mirror locally; skip S3 upload. Note in status.yaml.

`archive.versioning: true` → S3 versioning preserves prior versions of edited content automatically. site2rag never explicitly deletes a non-current version.

site2rag never crawls its own archive.

### Retain

Single sweep, operating on local mirror AND S3 atomically.

1. Compute `net_loss_in_window = pages_gone_in_window − pages_new_in_window` over `retention.freeze_on_degradation.window_days`.
2. Trigger freeze if `net_loss_in_window > max(net_loss_threshold_pct × total_pages, net_loss_min_pages)`.
3. If frozen OR `retention.preserve_always: true` → skip all deletions for site this tick. Set/update `site_meta.frozen_since` and `freeze_reason`. Set `runs.retention_frozen=1`.
4. Else: for each `pages` row with `gone=1` AND `gone_since < (now − gone_grace_days)`:
   - Delete local mirror file
   - Delete corresponding MD export from `websites_md/<domain>/`
   - Delete S3 object (creates delete marker; prior versions preserved by S3 versioning)
   - Set `pages.local_path=null`, `pages.archive_only=1` (tombstone)
5. Tombstone rows kept 1 year, then pruned (regardless of freeze).
6. Asset retention follows same rules: `assets.ref_count == 0` AND `gone_since < (now − gone_grace_days)` → delete (subject to freeze).

Freeze re-evaluated every tick. Self-healing: bleed stops → trigger fails → deletions resume on next tick. No manual unfreeze needed.

Re-discovered URL during grace → unset `gone`, resume normal tracking.

Edits never trigger retention. Only `gone` status does.

## Frontmatter

Common (all exports):
```yaml
source_url: <url>
canonical_url: <url>
backup_url: <s3-public-url>
backup_archived_at: <iso>
archive_only: false               # true if origin returns 4xx/410
domain: <domain>
title: <str>
title_source: json_ld | meta | og | h1 | filename
fetched_at: <iso>
modified_at: <iso>
date_published: <iso>             # from JSON-LD when available
date_modified: <iso>
content_hash: sha256:<hex>
mime_type: <mime>
mirror_path: <relative-path>
url_path: <path>
crawl_depth: <int>
from_sitemap: <bool>
language: <code>
page_role: content | host_page | redirect | index
conversion_method: <str>
ocr_used: <bool>
word_count: <int>
authors: [{name, url, bio, job_title, organization}]
keywords: [...]
tags: [...]
schema_org_type: <str>            # from JSON-LD
```

Host page additions:
```yaml
page_role: host_page
hosts:
  - { url, backup_url, title, md_path }
```

Document (PDF) additions:
```yaml
mime_type: application/pdf
ocr_engines: [...]
reconciler: <provider> | null     # null when short-circuited
pages: <int>
agreement_avg: <0..1>
flagged_pages: [<page_no>, ...]
host_page_url: <url>
host_page_backup_url: <url>
host_page_title: <str>
host_page_md: <relative-path>
backlink_format: visible | comment | both
backlink_granularity: paragraph | page
```

### Metadata fallback chains

| Field | Priority |
|---|---|
| title | JSON-LD `headline`/`name` → og:title → `<title>` → first `<h1>` → filename slug |
| authors | JSON-LD `Person` → meta `author` → Dublin Core → `.byline` heuristic |
| date_published | JSON-LD → `meta article:published_time` → HTTP Last-Modified |
| date_modified | JSON-LD → `meta article:modified_time` → HTTP Last-Modified |
| keywords | union of meta keywords + JSON-LD keywords + rule-extracted tags |
| language | `<html lang>` → sitemap hreflang → content language detection |

`<field>_source` companion field records which path was used. All deterministic.

## SQLite schema (per site, in `_meta/site.sqlite`)

```sql
CREATE TABLE site_meta (key TEXT PRIMARY KEY, value TEXT);
-- keys: frozen_since, freeze_reason (net_loss_threshold|preserve_always|manual), freeze_last_eval

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT, finished_at TEXT,
  status TEXT,
  sitemap_added INT, sitemap_changed INT, sitemap_removed INT,
  pages_checked INT, pages_new INT, pages_changed INT, pages_gone INT,
  pages_gc_deleted INT,
  pages_classified INT, host_pages_detected INT,
  exports_written INT, exports_skipped INT, exports_failed INT,
  ocr_pages INT, ocr_pages_flagged INT, reconciler_calls INT,
  retention_frozen INT, retention_net_loss INT,
  archive_uploaded INT, archive_skipped INT, archive_failed INT,
  message TEXT
);

CREATE TABLE pages (
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
  classify_method TEXT,           -- rules | heuristic
  classify_rationale TEXT,
  word_count_clean INT
);

CREATE TABLE hosts (
  host_url TEXT NOT NULL,
  hosted_url TEXT NOT NULL,
  hosted_title TEXT,
  detected_at TEXT,
  PRIMARY KEY (host_url, hosted_url)
);

CREATE TABLE sitemaps (
  url TEXT PRIMARY KEY,
  lastmod TEXT,
  source_sitemap TEXT,
  first_seen_at TEXT, last_seen_at TEXT,
  removed INT DEFAULT 0,
  removed_at TEXT
);

CREATE TABLE exports (
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
  status TEXT,                    -- ok | failed
  error TEXT
);

CREATE TABLE ocr_pages (
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

CREATE TABLE assets (
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

CREATE TABLE asset_refs (
  asset_hash TEXT NOT NULL,
  referencing_url TEXT NOT NULL,
  PRIMARY KEY (asset_hash, referencing_url)
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  stage TEXT,                     -- ocr_engine | ocr_reconcile
  url TEXT,
  page_no INT,
  provider TEXT, model TEXT,
  tokens_in INT, tokens_out INT, cost_usd REAL,
  ok INT,
  called_at TEXT
);
```

## Site Rules

Per-site `rules:` block in `websites.yaml`. Pure data; cannot expand scope; cannot break runtime (extraction falls through). Edited by humans or by Claude Code from human notes.

```yaml
rules:
  content_selector: <css>         # isolates main content
  exclude_selectors: [<css>, ...] # removed from content
  title_selector: <css>
  date_selector: <css>
  classify_overrides:             # URL-pattern role overrides
    - { pattern: <regex>, role: host_page | content | index | redirect }
  ocr_overrides:                  # per-pattern OCR config
    - { pattern: <regex>, mode: ..., engines: [...] }
  follow_overrides:               # per-pattern crawl control
    - { pattern: <regex>, follow: <bool> }
  canonical_strip_query: [<param>, ...]   # strip query params before canonical
```

Application order:
1. Crawl: `follow_overrides`, `canonical_strip_query`.
2. Classify: `classify_overrides` (overrides heuristic).
3. Extract: `content_selector` + `exclude_selectors` (overrides Readability).
4. OCR: `ocr_overrides` (overrides defaults for matching docs).

## status.yaml fields (per-site)

```yaml
site: { domain, url }
last_check_at: <iso>
last_success_at: <iso>
last_sitemap_diff_at: <iso>
next_due_at: <iso>
last_status: success | failed | frozen | skipped
sitemap: { total_urls, added_today, changed_today, removed_today }
mirror: { pages_checked, pages_new, pages_changed, pages_gone, gc_deleted }
retention:
  grace_days: 90
  frozen: <bool>
  frozen_since: <iso|null>
  freeze_reason: net_loss_threshold | preserve_always | manual | null
  net_loss_in_window: <int>
  net_loss_threshold: <int>
  preserve_always: <bool>
  tombstones_active: <int>
  next_grace_clear_at: <iso|null>
assets: { total, new, bytes }
archive:
  enabled: <bool>
  uploaded_today: <int>
  skipped_unchanged: <int>
  archive_only_pages: <int>
  bucket_objects: <int>
  bucket_bytes: <int>
  rewrite_html_assets: <bool>
classify: { content, index, host_pages, redirects, rule_overrides_applied }
export: { enabled, written, skipped_unchanged, failed }
ocr:
  docs_processed: <int>
  pages_total: <int>
  pages_short_circuited: <int>
  reconciler_calls: <int>
  pages_flagged: <int>
  avg_agreement: <0..1>
tokens:
  ocr:
    <provider>: { input, output, cost_usd }
  total_cost_usd: <float>
rules: { rules_present, rules_version }
last_error: <str|null>
```

## Tech stack

| Concern | Package |
|---|---|
| Runtime | Node.js 20+ (ES6+, no TS, no React) |
| Process mgr | PM2 |
| Config | js-yaml |
| State | better-sqlite3 (sync API) |
| HTTP | undici |
| HTML parse | cheerio |
| Chrome strip fallback | @mozilla/readability + jsdom |
| HTML → MD | turndown + GFM plugin |
| Sitemap | fast-xml-parser |
| JSON-LD | cheerio + JSON.parse |
| PDF text | pdf-parse |
| PDF rasterize | pdfjs-dist (or pdftoppm) |
| OCR local | tesseract.js |
| OCR cloud | Mistral OCR API |
| Vision/reconciler | @anthropic-ai/sdk |
| S3 | @aws-sdk/client-s3 (or minio SDK) |

## Code style (mandatory)

- No blank lines in code. Use comments to separate sections.
- Single-line if statements where readable.
- Functional/compact style with chaining; ternary over if/else where readable.
- All functions exported inline: `export const fn = () => {}`.
- JSDoc headers on every exported function.
- All imports at top of file. No inline imports.
- ES6+ throughout. No CommonJS in `src/`.
- Modern Node patterns. Prefer `undici` over `node-fetch`, `better-sqlite3` over `sqlite3`.
- No em-dashes in prose/comments; use spaced double-hyphen ` -- ` or colons.
- Tests in `tests/` mirroring `src/` structure. Use Vitest.
- Lint and format must pass before commit. Run after every edit.
- Trunk dev with short-lived branches. Small frequent commits.

## Deployment

Host: tower-nas. `SITE2RAG_ROOT` on largest mount.

```bash
export SITE2RAG_ROOT=/mnt/tank/site2rag
mkdir -p $SITE2RAG_ROOT
git clone https://github.com/chadananda/site2rag $SITE2RAG_ROOT/app
cd $SITE2RAG_ROOT/app
cp .env.example .env  # edit
npm install           # postinstall registers PM2 apps + saves
pm2 startup           # one-time, requires sudo
```

After bootstrap, `git push` to GitHub is the only deploy action — `site2rag-updater` polls and applies.

`app/.env.example`: `ANTHROPIC_API_KEY=`, `MISTRAL_API_KEY=`, `S3_ACCESS_KEY=`, `S3_SECRET_KEY=`.

`app/package.json` scripts:
```json
"scripts": {
  "postinstall": "node bin/setup.js"
}
```

`app/ecosystem.config.cjs`:
```js
const path = require('path');
const SITE2RAG_ROOT = path.resolve(__dirname, '..');
module.exports = {
  apps: [
    {
      name: 'site2rag',
      script: './src/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production', SITE2RAG_ROOT },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 30000,
      max_memory_restart: '2G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: '../logs/site2rag.out.log',
      error_file: '../logs/site2rag.err.log',
      merge_logs: true
    },
    {
      name: 'site2rag-updater',
      script: './bin/updater.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SITE2RAG_ROOT,
        UPDATE_CHECK_INTERVAL_MIN: '60',
        UPDATE_BRANCH: 'main',
        UPDATE_ENABLED: 'true'
      },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 60000,
      max_memory_restart: '256M',
      out_file: '../logs/updater.out.log',
      error_file: '../logs/updater.err.log',
      merge_logs: true
    }
  ]
};
```

## Self-Update

Two PM2 apps: `site2rag` (worker) + `site2rag-updater` (watchdog).

### `bin/setup.js` (postinstall)

Idempotent. Runs on every `npm install`.

1. Verify `pm2` available; if not, log instructions and exit 0 (don't fail npm).
2. Verify `.env` exists; warn if not (don't fail).
3. `pm2 jlist` → check if `site2rag` already registered.
4. If not registered: `pm2 start ecosystem.config.cjs && pm2 save`. Log instruction to run `pm2 startup` (one-time, sudo).
5. If registered: log "already configured, skipping" and exit. The updater will handle restart if needed.

### `bin/updater.js` (PM2-supervised loop)

Polling interval = `UPDATE_CHECK_INTERVAL_MIN` minutes (default 60). Skip entirely if `UPDATE_ENABLED=false`.

Each check:
1. `cd $SITE2RAG_ROOT/app`.
2. `git fetch --quiet origin $UPDATE_BRANCH`. On failure: log, retry next interval.
3. `git rev-parse HEAD` vs `git rev-parse origin/$UPDATE_BRANCH`. Equal → sleep.
4. `git diff --name-only HEAD origin/$UPDATE_BRANCH` → check for `package.json` or `package-lock.json`. Set `needs_install`.
5. `git pull --ff-only origin $UPDATE_BRANCH`. On non-FF: log error, abort. Operator must clean local state manually.
6. If `needs_install`: `execSync('npm install', { stdio: 'inherit' })`. On failure: log error, abort (skip restart).
7. Spawn detached: `pm2 startOrReload ecosystem.config.cjs && pm2 save`. Process exits as part of restart; PM2 brings it back with new code.
8. Log result to `logs/updater.out.log`.

`UPDATE_BRANCH` accepts branch names, tags, or SHAs (anything `git rev-parse origin/<X>` resolves).

`pm2 startOrReload` (vs `pm2 restart all`) ensures ecosystem config changes are picked up too.

### Failure semantics

| Failure | Action |
|---|---|
| `git fetch` (network) | Log warning, skip cycle |
| Non-fast-forward (local diverged) | Log error, abort; manual cleanup required |
| `npm install` fails | Log error, abort; do not restart |
| `pm2 startOrReload` fails | Log error; code on disk is new but processes are still old; retry next cycle |
| Updater itself crashes | PM2 restarts it (with `restart_delay: 60s`); worker unaffected |
| Worker crashes from bad pull | PM2 restarts worker; updater can pull fix on next cycle |

### Why two processes

If the worker crashes from a bad pull, the updater is unaffected and can pull a fix. If a pull updates the updater itself, `pm2 startOrReload` brings it back with the new code.

### Manual update

Equivalent of one updater cycle:
```bash
cd $SITE2RAG_ROOT/app
git pull --ff-only
npm install
pm2 startOrReload ecosystem.config.cjs && pm2 save
```

### Disable

`pm2 set site2rag-updater:UPDATE_ENABLED false && pm2 restart site2rag-updater`. Updater runs but skips checks. Re-enable by setting back to `true`.

## Failure handling

- Per-site failures isolated. Other sites continue next tick. No backoff in v1.
- Mirror writes never destructive on failure.
- OCR engine failure → omit from reconciler input; continue with remaining. All fail → page failed; neighbors intact.
- Reconciler failure → fall back to vote (highest-confidence engine). `conversion_method: ocr+vote-fallback`.
- Sitemap fetch failure → use cached sitemap; warn. No cache + `fallback_to_crawl: true` → seed crawl.
- Rule misconfiguration (selector matches nothing) → fall through Readability → body-minus-chrome. Per-site warning logged.
- Asset fetch failure → skip this run; original URL stays in MD; retry next run.
- S3 upload failure → leave `backup_etag` unchanged; retry next run. `backup_url` still written (template-computed); 404 against bucket until upload succeeds.
- S3 endpoint unreachable → skip Archive stage entirely this tick; everything else proceeds. Log once per run.

## Acceptance criteria

- [ ] App in `site2rag/app/`; data in siblings; both on tower-nas largest drive.
- [ ] Reads `SITE2RAG_ROOT` env or falls back to `path.resolve(__dirname, '..')`.
- [ ] PM2 supervises both `site2rag` and `site2rag-updater`; `pm2 save` + `pm2 startup`; file-watch disabled.
- [ ] `npm install` postinstall runs `bin/setup.js` which idempotently registers both apps with PM2 on first install; no-op on subsequent installs.
- [ ] `bin/updater.js` polls `UPDATE_BRANCH` every `UPDATE_CHECK_INTERVAL_MIN`; pulls fast-forward only; runs `npm install` when `package.json` differs; calls `pm2 startOrReload ecosystem.config.cjs && pm2 save`.
- [ ] Updater aborts cleanly on fetch failure, non-FF, or install failure; old code keeps running.
- [ ] `UPDATE_ENABLED=false` disables polling. `UPDATE_BRANCH` accepts branches/tags/SHAs.
- [ ] Updater logs every check to `logs/updater.out.log`.
- [ ] Reads `websites.yaml` on startup and each tick.
- [ ] Discovers sitemaps including indexes; daily diff drives queue.
- [ ] Mirrors per include/exclude/depth/`same_domain_only`; sitemap-priority queue.
- [ ] 304 / content-hash skip; no rewrite of unchanged files.
- [ ] HTML and PDF → MD when `export_md`.
- [ ] Image PDFs OCR'd; layout/page boundaries preserved.
- [ ] All SQLite tables present and accurately tracked.
- [ ] `status.yaml` updated each run.
- [ ] Survives reboot/crashes via PM2.
- [ ] Re-running export reproduces MD tree from mirror.
- [ ] Filenames deterministic from URL path; no DB lookup needed.
- [ ] Pages classified into 4 roles; `hosts` populated for host pages.
- [ ] Host page MD: `page_role: host_page` + `hosts:` array. Document MD: `host_page_url`/`host_page_md`. Bidirectional consistent.
- [ ] Document MD has paragraph-level back-links to source (with `#page=N` for PDFs).
- [ ] Multi-engine OCR parallel; cached by `(doc_url, page_no, engine)` with confidence + bboxes.
- [ ] Confidence-aware merge skips reconciler when `agreement >= threshold` AND `confidence >= threshold`.
- [ ] Reconciler receives image + transcripts + confidences + bboxes when available.
- [ ] Pages below `flag_threshold` listed in `flagged_pages`.
- [ ] OCR engine cache enables reconciler-only reruns without re-OCR.
- [ ] Site `rules:` honored: `classify_overrides`, content/exclude selectors, `ocr_overrides`.
- [ ] 90-day retention deletes from local AND S3 atomically; tombstones kept.
- [ ] Degradation freeze: `net_loss > max(threshold_pct × total, min_pages)` → no deletions; auto-releases.
- [ ] `preserve_always: true` overrides everything.
- [ ] Edits don't trigger retention. S3 versioning preserves prior versions.
- [ ] Tombstone rows pruned at 1 year.
- [ ] S3 archive populated for `archive.enabled` sites; idempotent ETag-based upload.
- [ ] Frontmatter has `backup_url` + `backup_archived_at`; documents add `host_page_backup_url`.
- [ ] `archive_only=1` set when origin returns 4xx/410.
- [ ] `noarchive` honored when `respect_archive_block: true`.
- [ ] `rewrite_html_assets` only affects S3 copy; local mirror HTML never rewritten.
- [ ] OCR token usage tracked in `llm_calls`; aggregated in `status.yaml.tokens`.
- [ ] JSON-LD metadata populates `authors`/`dates`/`keywords`/`schema_org_type` with fallback chains.
- [ ] `language` set from `<html lang>` or sitemap hreflang.
- [ ] Asset stage downloads images + configured doc types; sha256 dedup.
- [ ] MD link rewriting → local relative paths; original URL in adjacent comment.
- [ ] Asset retention: `ref_count=0` for >90 days → delete (subject to freeze).