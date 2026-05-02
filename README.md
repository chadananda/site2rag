# site2rag

**Mirror websites, upgrade their PDF archives, and produce high-quality search index materials for [OceanLibrary.com](https://oceanlibrary.com).**

site2rag is a self-hosted pipeline that crawls institutional and scholarly websites, scores the quality of their PDFs, upgrades image-only PDFs (scans with no text layer) through AI-assisted OCR, and exports structured Markdown suitable for RAG (retrieval-augmented generation) and full-text search via Meilisearch.

---

## Why this exists

Many institutional websites — libraries, archives, religious organizations, NGOs — host large PDF collections that are effectively invisible to search engines and AI tools. These PDFs are scanned documents: photographic images with no text layer, meaning they cannot be indexed, searched, or read by screen readers.

**The core problem:** A 300-page academic report scanned at 200 DPI is just a stack of images. No text = no search = no AI access.

**Our goal:** Make every PDF in the OceanLibrary corpus fully searchable, accessible, and usable as high-quality training/retrieval material for the OceanLibrary.com search engine — which uses Meilisearch under the hood and feeds into RAG pipelines for AI-assisted discovery.

---

## Architecture

```
sites.yaml                   ← list of sites to mirror + rules
    │
    ▼
[Sitemap stage]              ← parse sitemap.xml, detect changes
    │
    ▼
[Mirror stage]               ← conditional GET crawl, writes files to mirror/
    │                           (etag/last-modified, robots.txt, depth limits)
    ▼
[Score stage]                ← heuristic PDF quality scoring (0.0–1.0)
    │                           detects text layers, readable % by page
    ▼
[Classify stage]             ← label pages: content / index / host_page / redirect
    │
    ▼
[PDF Upgrade pipeline]       ← for image PDFs with score < 0.7
    │   ├─ identify.js       ← Tesseract OSD → language detection → skip/queue
    │   ├─ score.js          ← composite quality score, queue management
    │   ├─ reocr.js          ← vision LLM page-by-page OCR transcription
    │   ├─ rebuild.js        ← embed text layer via OCRmyPDF / pdf-lib
    │   └─ report.js         ← upgrade outcome stats
    ▼
[Export stage]               ← HTML → Markdown, PDF metadata → YAML front matter
    │
    ▼
[Archive stage]              ← optional S3/R2 upload of upgraded PDFs
    │
    ▼
SQLite per-domain DB         ← pages, pdf_quality, pdf_upgrade_queue, exports, runs
```

The pipeline runs as a PM2-managed Node.js process on a 15-minute tick. Each site is checked on its own schedule (`check_every_days`, default 3 days). Multiple sites run sequentially within a tick to avoid overwhelming the network or the AI API.

---

## Pipeline stages in detail

### 1. Sitemap (`src/sitemap.js`)
Fetches `sitemap.xml` (or `sitemap_index.xml`), diffs against the previous crawl, and returns lists of added/changed/removed URLs. Changed URLs go into a priority queue for the mirror stage so they are fetched before general crawl URLs.

### 2. Mirror (`src/mirror.js`)
Crawls the site with conditional GET requests (`If-None-Match`, `If-Modified-Since`). Handles:
- **Robots.txt** compliance
- **Depth limits** (configurable, default 8)
- **Include/exclude rules** for path prefixes
- **Document types**: HTML pages and PDFs are mirrored; other binary formats skipped
- **Long filenames**: URL-encoded filenames (e.g., Arabic) are hashed to avoid ENAMETOOLONG on Linux
- **Filesystem conflicts**: hash-named fallback when a directory exists where a file is needed
- **Connection drops**: `undici` "terminated" errors during body reads are caught and retried gracefully

Files are written to `mirror/{domain}/...` preserving the URL path structure. A `sha256` content hash detects changes. Pages are marked `gone` if they return 404/410 or aren't seen after a full run.

### 3. PDF Scoring (`src/score-pdfs.js`, `src/pdf-upgrade/score.js`)
Heuristic quality scoring for every mirrored PDF:
- **Has text layer**: detected via `pdf-parse`
- **Readable pages %**: ratio of pages with meaningful character content
- **Average chars per page**: distinguishes thin text overlays from real content
- **Word quality estimate**: cleaned word count
- **Composite score 0.0–1.0**: weighted combination of all signals
- **Language detection**: Unicode script composition → english / arabic / persian / hebrew / russian / japanese / chinese / unknown
- **Queue decision**: PDFs with `composite_score < 0.7` and no skip flag are queued for upgrade

### 4. PDF Upgrade (`src/pdf-upgrade/`)
The upgrade pipeline processes queued image PDFs through multiple stages:

**identify.js** — Cheap pre-screening (no GPU required):
1. Rasterizes a sample page with `pdftoppm`
2. Runs **Tesseract OSD** (`--psm 0`) for script detection
3. Runs **Tesseract OCR** for a text sample
4. If text is sparse, calls **Claude Haiku** for metadata extraction (title, author, language)
5. Results saved to `pdf_quality` (sets `summary_tier='identified'`)

**reocr.js** — Full re-OCR via vision LLM:
- Each page rasterized at high resolution
- Sent to a vision language model (LLaVA or Claude) for structured Markdown transcription
- Preserves headings, paragraphs, lists, tables — context-aware, not naive character recognition
- Two-engine reconciliation (`src/ocr/reconcile.js`) for quality verification

**rebuild.js** — PDF reconstruction:
- OCR text embedded as invisible layer via **OCRmyPDF** (ISO 19005-3 PDF/A compliant)
- Fallback: direct layer injection via `pdf-lib`
- Metadata enriched: `/Title`, `/Author`, `/Subject`, `/Keywords` from AI analysis
- Original filename preserved; drop-in replacement for the original file

**score.js** — Queue management:
- Assigns priority based on score, language cost multiplier, and page count
- Tracks `before_score` / `after_score` / `score_improvement` for each upgraded PDF
- Language cost multipliers (English=1.0x, Arabic/Persian/Hebrew=1.35x, Japanese/Chinese=1.5x)

### 5. Classify (`src/classify.js`)
Labels HTML pages as `content` (article/report), `index` (list/category), `host_page` (a page that links to PDFs), or `redirect`. Drives export prioritization and deduplication.

### 6. Export (`src/export-html.js`, `src/export-doc.js`)
Converts crawled HTML and upgraded PDFs to clean Markdown:
- Strips navigation, ads, and boilerplate using configurable CSS selectors
- Preserves semantic structure: headings, lists, blockquotes, tables
- Generates YAML front matter: `title`, `url`, `author`, `language`, `description`, `source_domain`
- Output goes to `md/{domain}/...` for ingestion by the Meilisearch indexer in SifterSearch

### 7. Archive (`src/archive.js`)
Optional S3/R2 upload of upgraded PDFs, with configurable bucket and rewrite of HTML asset links.

### 8. Retain (`src/retain.js`)
Garbage-collects mirror files for pages that have been `gone` longer than the grace period (default 90 days), with optional preservation of pages from the archive.

---

## Database schema (per domain)

Each site gets its own SQLite database at `mirror/{domain}/_meta/site.sqlite`.

**Key tables:**
- `pages` — every URL crawled: local_path, mime_type, content_hash, depth, gone flag, timestamps
- `pdf_quality` — scoring data: composite_score, pages, readable_pages_pct, has_text_layer, thumbnail_path, ai_summary, ai_author, ai_language, summary_tier
- `pdf_upgrade_queue` — upgrade queue: status (pending/processing/done/failed), before/after scores, upgraded_pdf_path
- `ocr_pages` — per-page OCR output: text_md, confidence, engine
- `hosts` — which host pages link to which PDFs (for context extraction)
- `assets` — images and other static assets
- `exports` — Markdown export records
- `runs` — one row per pipeline run: started_at, finished_at, status, message, stats
- `llm_calls` — token usage per API call: provider, model, stage, tokens_in, tokens_out

---

## Report server & UI

`bin/report-server.js` serves a monitoring dashboard on port 7840 (or `$REPORT_PORT`).

**API endpoints:**
- `GET /api/sites` — site cards with live stats (pages, PDFs, upgrade progress, last run)
- `GET /api/docs?site=&tab=&page=&q=&sort=` — paginated PDF list with filtering
- `GET /api/thumbnail?url=&w=&page=` — on-demand thumbnail generation via PDF.js worker threads
- `GET /api/pdf?url=` — proxy mirrored PDF file to the browser (for the viewer)
- `GET /pdfjs/*` — serves pdfjs-dist build files for the in-browser viewer
- `POST /api/docs/summarize?site=&url=` — trigger per-document Haiku summary
- `POST /api/docs/summarize-batch?site=&limit=` — batch summarize via SSE stream
- `POST /api/docs/skip?site=&url=&skip=` — mark a PDF as not worth upgrading
- `GET /api/docs/download?site=&url=` — download upgraded PDF

**Dashboard (`public/index.html`):**
- Per-site cards showing spider progress bar, summarizing progress bar, upgrade progress bar
- Health badge showing recent failure count and last error message
- Full PDF list with search, sort, tab filter (queue / upgraded / adequate)
- PDF detail modal: multi-page thumbnail carousel, AI summary, metadata, action buttons
- "Read PDF" button opens the in-browser viewer

**PDF Viewer (`public/viewer.html`):**
- Self-hosted using pdfjs-dist 4.x (no external CDN dependency)
- Text layer rendering for selection and search
- In-page search with match highlighting and hit navigation
- Page bookmarks persisted to `localStorage` (keyed by PDF URL)
- Keyboard shortcuts: arrow keys (page nav), +/- (zoom), F (focus search), B (bookmark)
- Tablet-friendly: fits to viewport width, no scrolling chrome
- PWA-cacheable (registered in manifest.json)

---

## Infrastructure

- **Node.js** 20+ with ES modules
- **PM2** for process management (15-min ticks, auto-restart)
- **better-sqlite3** for synchronous DB operations (safe for single-process use)
- **undici** for HTTP fetching (fast, streaming, conditional GET)
- **pdfjs-dist** 4.x for thumbnail generation (worker threads) and browser viewing
- **Tesseract** (system binary) for OSD and OCR pre-screening
- **OCRmyPDF** (system binary) for PDF/A text layer embedding
- **pdftoppm** (system binary, part of poppler-utils) for page rasterization
- **Anthropic SDK** for Claude Haiku summarization and Claude (vision) OCR

Hardware target: 80-core / 190 GB RAM server with no GPU. Parallelism is scaled to CPU count:
- Thumbnail workers: `max(4, floor(cpus / 4))`
- Identify concurrency: 40 parallel Tesseract subprocesses
- Upgrade concurrency: `max(4, floor(cpus / 2))`

---

## Configuration (`sites.yaml`)

```yaml
mirror_root: /tank/site2rag/mirror
md_root: /tank/site2rag/md

sites:
  - url: https://example.org
    domain: example.org
    enabled: true
    check_every_days: 3
    max_depth: 6
    user_agent: site2rag/1.0
    respect_robots_txt: true
    timeout_seconds: 1800
    include:
      - /library/
      - /documents/
    exclude:
      - /admin/
    classify:
      enabled: true
    export_md: true
    rules:
      - match: /archive/
        follow: false
      - match: /search?
        strip_query: true
    retention:
      gone_grace_days: 90
      preserve_always: false
```

---

## Utility scripts

**`scripts/pregen-thumbs.js`** — Bulk pre-generate PDF page thumbnails before users open the UI. Useful after a large initial crawl. Scales to ~75% of CPU cores.

```bash
node scripts/pregen-thumbs.js --pages 5 --site example.org
```

**`bin/setup.js`** — One-time DB schema creation.

**`bin/updater.js`** — Self-update mechanism (pulls latest code from git, restarts PM2).

---

## Data flow to OceanLibrary

```
site2rag mirror/          ← raw crawl (HTML + PDFs)
    │
    ▼
site2rag md/              ← clean Markdown with YAML front matter
    │
    ▼
SifterSearch indexer      ← ingests md/ into Meilisearch
    │
    ▼
OceanLibrary.com          ← faceted full-text search + RAG retrieval
```

The Markdown export is designed to be ingested directly by the SifterSearch pipeline:
- One `.md` file per HTML page or upgraded PDF
- Front matter fields match SifterSearch's expected schema: `title`, `url`, `author`, `language`, `description`, `source_domain`, `content_type`
- Image PDFs without upgrades are skipped from export (no text = no index value)
- Upgraded PDFs get their OCR Markdown embedded as the document body

---

## Operations

All common tasks have npm scripts. Run `npm run <script>` from the project root.

### Deploy

| script | what it does |
|--------|-------------|
| `deploy:ui` | Build CSS, bump version, deploy `public/` to Cloudflare Pages, commit version.json. **Always use this — never run wrangler directly.** |
| `deploy:backend` | `git pull` on tower-nas + `pm2 reload site2rag pdf-report-server` |
| `deploy:all` | Both of the above |

UI live at `https://site2rag.lnker.com` (CF Pages).  
API live at `https://api.lnker.com` → Cloudflare tunnel → tower-nas:7840.

### Restart individual processes

| script | restarts |
|--------|---------|
| `restart:spider` | `site2rag` (crawler) |
| `restart:api` | `pdf-report-server` |
| `restart:worker` | `pdf-upgrade-worker` |
| `restart:all` | all PM2 processes |

### Logs (streaming)

| script | log |
|--------|-----|
| `logs:spider` | spider stdout |
| `logs:spider:err` | spider stderr |
| `logs:api` | API server stdout |
| `logs:api:err` | API server stderr |

### Server access

| script | does |
|--------|------|
| `status` | `pm2 status` on tower-nas |
| `ssh` | open SSH session to tower-nas |

### PM2 processes on tower-nas (`/tank/site2rag/app`)

| process | script | notes |
|---------|--------|-------|
| `site2rag` | `src/index.js` | 15-min tick scheduler |
| `pdf-report-server` | `bin/report-server.js` | API + static UI on :7840 |
| `lnker-server` | `bin/lnker-server.js` | Asset server on :7841 |
| `pdf-upgrade-worker` | `bin/pdf-upgrade-worker.js` | LLM OCR upgrade worker |
| `site2rag-updater` | `bin/updater.js` | git pull watchdog — does NOT reload PM2 |

### Local development

```bash
npm install
npm test                               # run 85-test Vitest suite
SITE2RAG_ROOT=/path/to/data npm start  # run pipeline once
```
