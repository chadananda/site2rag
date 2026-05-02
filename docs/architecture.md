# site2rag Architecture

## Overview

PM2-supervised Node.js pipeline. Runs on a 15-min tick; each site checked on its own `check_every_days` schedule (default 3). `SITE2RAG_ROOT` env var sets data root.

## Directory layout (at SITE2RAG_ROOT)

```
websites_mirror/<domain>/          # mirrored files
  _meta/site.sqlite                # per-domain SQLite DB
  _assets/<sha[0:2]>/<sha>.<ext>   # deduplicated assets
  <url-path>/index.html            # mirrored HTML
websites_md/<domain>/              # exported Markdown
logs/                              # PM2 log files
websites.yaml                      # site config
```

## Pipeline (src/index.js — runSite)

Each stage runs sequentially. A crash in any stage stops all subsequent stages — classify/export only run if sitemap→mirror→assets→score→summarize all succeed.

| # | Stage | File | Notes |
|---|-------|------|-------|
| 1 | Sitemap | src/sitemap.js | Discovers URLs; diffs vs DB; 24h cache |
| 2 | Mirror | src/mirror.js | Conditional GET crawl; etag/lastmod; timeout_seconds |
| 3 | Assets | src/assets.js | Downloads images + PDFs from HTML; sha256 dedup |
| 4 | ScorePdfs | src/score-pdfs.js | Worker-pool PDF scoring; **5-min budget, 500-PDF batch, max 4 workers** |
| 5 | SummarizePdfs | src/summarize-pdfs.js | Claude Haiku summaries for image PDFs; 10-min budget |
| 6 | Classify | src/classify.js | Rules-first; 4 roles: content/index/redirect/host_page |
| 7 | ExportHtml | src/export-html.js | HTML → Markdown + YAML frontmatter |
| 8 | ExportDoc | src/export-doc.js | PDF → Markdown via text extract or OCR; 30-min timeout |
| 9 | Archive | src/archive.js | S3/R2 upload (etag-skip); rewrites URLs in S3 copy only |
| 10 | Retain | src/retain.js | Grace-period GC; degradation freeze; tombstone pruning |

## Subsystems

### src/config.js
Path helpers are **lazy functions** (not constants). `getSiteRoot()` reads `process.env.SITE2RAG_ROOT` at call time. Required for test isolation with ESM hoisting — do NOT convert to module-level constants.

Exports: `getSiteRoot`, `getMirrorRoot`, `getMdRoot`, `getLogsRoot`, `mirrorDir`, `mdDir`, `metaDir`, `assetsDir`, `loadConfig`, `mergeSiteConfig`

### src/db.js
`openDb(domain)` runs `db.exec(DDL)` then `migrate(db)` on every open. Migration uses `ALTER TABLE … ADD COLUMN` wrapped in try/catch (silently skips existing columns). The `pdf_quality` table has many migration-only columns — any query referencing them must be inside try/catch or called after `openDb`.

Migration columns on `pdf_quality`: `pdf_title`, `excerpt`, `skip`, `ai_summary`, `ai_author`, `ai_summarized_at`, `thumbnail_path`, `summary_tier`, `ai_language`

### src/sitemap.js
Exports: `runSitemap`, `hasSitemapOrFallback`. Follows sitemap index chains (max 5 levels). Diffs against DB; returns `{ added, changed, removed, total }`. Caches diffs for 24h — returns early if last diff was recent.

### src/mirror.js
Exports: `runMirror`, `urlToMirrorPath`, `urlPathToSlug`. Query params hashed into filename. Filenames >200 bytes truncated with sha256 prefix. Marks 404/410 pages as gone. Per-site `timeout_seconds` (default 1800). Priority queue for changed/added URLs from sitemap diff.

### src/assets.js
Exports: `runAssets`. Scans mirrored HTML with cheerio; downloads `<img src>` and `<a href>` to doc extensions. Content-addressed storage at `_assets/<sha[0:2]>/<sha>.<ext>`. Also writes asset to mirror path for lnker-server URL serving. Images capped at `image_max_bytes` (default 10MB).

### src/score-pdfs.js
Exports: `runScorePdfs`. Worker-pool parallel scoring using `src/score-worker.js`. Cap: 4 workers, 500-PDF batch per run, 5-min budget. OOM risk if uncapped — tower-nas has many PDFs.

### src/summarize-pdfs.js
Exports: `runSummarizePdfs`. Queries `pdf_quality` for unsummarized image PDFs. **db.prepare() is wrapped in try/catch** — returns `{summarized:0, skipped:0}` if schema missing columns. 10-min budget, concurrent batch processing.

### src/classify.js
Exports: `runClassify`. Pure heuristics, no LLM. Role priorities: host_page > redirect > index > content. Host pages detected by low word count + document link density; populates `hosts` table. **Reclassifies all pages on every run** — rule changes in websites.yaml take effect immediately.

### src/rules.js
Exports: `compileRules`, `applyClassifyOverride`, `applyFollowOverride`, `applyOcrOverride`, `stripQueryParams`. Compiles regex patterns from config at pipeline start. Pure functions, no side effects. Returns first matching override only.

### src/export-html.js
Exports: `runExportHtml`. Skips pages with matching source_hash in exports table. Uses rules selector or Readability+Turndown. Writes 40+ frontmatter fields including host_pages array. Stores conversion_method for auditability.

### src/export-doc.js
Exports: `runExportDoc`. Tries pdf-parse first (text PDFs); falls back to pdfjs rasterize + OCR engines for image PDFs. Multiple OCR engines reconciled via `src/ocr/reconcile.js`. 30-min timeout via Promise.race in index.js.

### src/retain.js
Exports: `runRetain`. Grace period (default 90 days). Freeze if net loss (gone - added in window) exceeds threshold. Frozen state persisted in site_meta. Deletes local file, MD export, and S3 object. Tombstone (archive_only=1) preserved for S3-backed pages. Prunes tombstones after 1 year.

### src/metadata.js
Exports: `extractMetadata`. Priority chain: JSON-LD → OpenGraph → meta tags → heuristics. Returns title, authors, dates, language, keywords, canonical, schema.org type. All fallbacks deterministic.

### bin/report-server.js
API on port 7840. Routes: `/api/sites`, `/api/docs`, `/api/thumbnail`, `/api/docs/skip`, `/api/docs/summarize`. Also serves `public/` static files. `DOC_SELECT` query references pdf_quality migration columns — DB must be opened via `openDb()` first to ensure migrations ran. All `/api/docs` requests wrapped in try/catch to prevent server crash.

### bin/lnker-server.js
Asset/mirror server on port 7841. Routes by `{domain}.lnker.com` Host header (falls back to TLD variants). Serves robots.txt blocking all crawlers. Rewrites internal links to relative. Cache-Control: 30d for assets, 1h for HTML.

## Key invariants

1. `openDb` must be called before any query referencing migration columns
2. score-pdfs workers are capped — never use raw `cpus().length` as concurrency
3. Pipeline stages 6-10 only run if 1-5 complete without throwing
4. `config.js` path helpers are functions, never constants
5. `DOC_SELECT` in report-server references migration columns — always use `safeOpenDb` (which calls `openDb`)
