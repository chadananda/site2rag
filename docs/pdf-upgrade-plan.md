# PDF Upgrade Pipeline -- Plan

## Goal

Mirror bahai-library.com. Score every PDF for OCR quality. Use local AI (boss,
OpenAI-compatible) to re-OCR lowest-quality PDFs first. Rebuild each as a
PDF/A-3 with invisible text layer + enhanced XMP metadata. Publish a live
report page. Email Jonah Winters in batches offering drop-in replacements.

Designed to run slow and steady -- one document at a time, respectful of
boss availability, no urgency. The value is in quality, not speed.

---

## What makes a killer PDF upgrade

Each upgraded PDF is not just "re-OCR'd". It gets:

1. **Invisible text overlay** -- original scan image preserved exactly, text
   becomes selectable/searchable/copyable. No visual change.
2. **Paragraph-aware text placement** -- text positioned to match visual layout
   so selection works naturally (not just a text dump).
3. **XMP metadata** -- title, author, date, subject, keywords, language all
   populated from extracted content and bahai-library.com page metadata.
4. **PDF/A-3 archival standard** -- long-term preservation format,
   accepted by institutional archives and search engines.
5. **Table of contents** (when detectable from headings) -- clickable PDF
   outline/bookmarks.
6. **Structured headings** -- tagged PDF with proper heading hierarchy for
   screen readers and reflow.
7. **Quality certificate comment** -- embedded invisible annotation noting
   the upgrade date, method, and original quality score.

---

## Architecture

Three PM2 processes total:

| Process | File | Role |
|---|---|---|
| `site2rag` | `src/index.js` | existing -- mirror + initial score |
| `pdf-upgrade` | `src/pdf-upgrade/index.js` | new -- re-OCR queue worker |
| `pdf-report` | `src/pdf-upgrade/report.js` | new -- rebuilds static report |

All share `_meta/site.sqlite` per domain. Two new tables added to schema.

---

## Stage 1: Quality Scoring (runs inside existing site2rag pipeline)

After every PDF is mirrored or re-checked, compute quality score. No AI needed.

### Heuristics (src/pdf-upgrade/score.js)

1. `avg_chars_per_page` -- raw chars / pages. < 100 = likely image-only.
2. `readable_pages_pct` -- % of pages with >= 50 extractable chars.
3. `has_text_layer` -- pdf-parse found any text at all.
4. `word_quality_estimate` -- sample 200 tokens from extracted text, score
   % that look like real English words (length 2-15, common character patterns).
   Garbled OCR produces strings like "Tli1s" and "vvhich" that fail this check.
5. `composite_score` -- weighted: 0.4 * word_quality + 0.3 * readable_pct +
   0.2 * (chars_clamped/500) + 0.1 * has_text_layer. Range 0.0-1.0.

Computed once on first mirror; recomputed only when content_hash changes.
No threshold gating -- every PDF gets a score. Threshold for upgrade queue
is configurable in websites.yaml (default: composite_score < 0.7).

### New DB tables (added to existing DDL in db.js)

```sql
CREATE TABLE IF NOT EXISTS pdf_quality (
  url TEXT PRIMARY KEY,
  content_hash TEXT,
  scored_at TEXT,
  avg_chars_per_page REAL,
  readable_pages_pct REAL,
  has_text_layer INT,
  word_quality_estimate REAL,
  composite_score REAL,
  pages INT
);

CREATE TABLE IF NOT EXISTS pdf_upgrade_queue (
  url TEXT PRIMARY KEY,
  content_hash TEXT,
  priority REAL,               -- 1 - composite_score (higher = worse = first)
  status TEXT DEFAULT 'pending',
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  upgraded_pdf_path TEXT,
  before_score REAL,
  after_score REAL,
  score_improvement REAL,
  pages_processed INT,
  method TEXT,                 -- 'local-ai' | 'tesseract-retry'
  emailed INT DEFAULT 0,
  error TEXT
);
```

---

## Stage 2: Re-OCR Worker (src/pdf-upgrade/index.js)

PM2 process. Runs every 5 minutes via cron_restart. Processes one document
per tick. Designed for slow-and-steady operation.

### Per-document workflow

1. Pick next `pending` row ordered by `priority DESC` (worst first).
2. Check boss: `GET /v1/models` with 3s timeout.
   - Busy/slow (>3s) -- log, skip this tick, try next tick.
   - Down -- same.
   - Available -- proceed.
3. Rasterize all pages to PNG (reuse `_meta/raster/<hash>/` cache).
4. For each page sequentially:
   - Call boss vision model with OCR prompt (see below).
   - Cache result in `ocr_pages(doc_url, page_no, engine='local-ai')`.
   - 500ms cooldown between pages.
   - On boss error: mark page failed, continue to next page.
5. Assemble full page-text array.
6. Extract document structure (headings, TOC) via a second boss call on
   the assembled text.
7. Rebuild PDF with overlay (see Stage 3).
8. Score the upgraded PDF.
9. Update queue row.
10. Trigger report rebuild.

### Boss OCR prompt (per page)

```
You are an expert archival OCR system working on a scanned Bahai text.
Extract ALL text from this page image exactly as written.

Rules:
- Preserve paragraph breaks (blank line between paragraphs)
- Mark headings: # for main, ## for sub, ### for section headings
- Preserve footnote markers and footnote text (mark footnotes as [^N]: text)
- Preserve page headers/footers in <!-- header: ... --> and <!-- footer: ... -->
- Preserve tables using markdown table syntax
- Do NOT summarize, interpret, or omit anything
- Correct obvious OCR artifacts (e.g. "vvhich" -> "which", "Tlie" -> "The")
  but preserve unusual spellings that may be intentional
- If a word is genuinely unreadable, write [illegible]

Return only the extracted text, no preamble or explanation.
```

### Boss structure-extraction prompt (full document)

After all pages OCR'd, one additional call:

```
Given this OCR'd document text, extract:
1. The document title (if identifiable)
2. The author(s) (if present)
3. The publication date (if present)
4. A list of main section headings in order
5. Up to 10 keywords/topics

Return as JSON: { title, authors, date, headings: [{level, text, page}], keywords }
```

This populates XMP metadata and PDF bookmarks.

### Throttling / boss courtesy

- Sequential pages, 500ms between calls.
- One document per 5-min tick.
- If boss returns 429: back off 2x, max 20min wait.
- If 3 consecutive ticks fail: log warning, do not process, alert via status.yaml.

---

## Stage 3: PDF Reconstruction (src/pdf-upgrade/rebuild.js)

Input: original PDF + page-OCR results + structure metadata.
Output: PDF/A-3 with invisible text layer, XMP metadata, bookmarks.

### Approach: OCRmyPDF with custom sidecar

OCRmyPDF is the gold standard tool for this. Workflow:

```bash
# 1. Generate sidecar text file from our OCR results (not tesseract)
#    OCRmyPDF accepts --tesseract-config to override; we use its
#    --sidecar option to inject pre-built text

# Actually: use OCRmyPDF in force-ocr mode but substitute our text
# via a custom Tesseract LSTM replacement script, or:

# Simpler proven path:
ocrmypdf \
  --force-ocr \
  --output-type pdfa-3 \
  --pdf-renderer sandwich \
  --title "..." --author "..." --keywords "..." \
  --rotate-pages \
  --clean \
  --deskew \
  input.pdf output.pdf
```

Actually the cleanest approach with pre-computed text is pdf-lib overlay:

```
For each page:
  1. Extract page image from original PDF (keep original scan)
  2. Place image as background
  3. Add invisible text (renderMode: 3) positioned per page
  4. Text positioning: approximate from page dimensions / line count
```

Then run the result through OCRmyPDF `--skip-text --output-type pdfa-3`
to get proper PDF/A conformance without re-doing OCR.

### XMP metadata injected

```xml
<dc:title>Document Title</dc:title>
<dc:creator>Author Name</dc:creator>
<dc:subject>Keywords from extraction</dc:subject>
<dc:description>Bahai-library.com archive -- OCR enhanced</dc:description>
<xmp:CreatorTool>site2rag pdf-upgrade v1.0</xmp:CreatorTool>
<xmpMM:OriginalDocumentID>sha256:original-hash</xmpMM:OriginalDocumentID>
<pdf:Keywords>extracted, keywords, here</pdf:Keywords>
```

### Output location

`/tank/site2rag/websites_mirror/bahai-library.com/_meta/upgraded/<url-slug>.pdf`

---

## Stage 4: Live Report Page (src/pdf-upgrade/report.js)

Static HTML rebuilt after each document upgrade. No server needed.

### Content

- **Header**: "bahai-library.com OCR Enhancement Project"
- **Summary stats**: total PDFs scored / upgraded / pending / failed,
  average score improvement, total documents made searchable
- **Distribution chart**: histogram of quality scores (ASCII or SVG)
- **Table**: every PDF ever processed, sortable columns:
  - Title / URL / Pages / Score before / Score after / Improvement / Status / Download
- **Queue**: next N pending (shows project is active)
- **Last updated**: ISO timestamp

### Hosting

Static HTML at a path served by cloudflared tunnel or nginx already on tower-nas.
Rebuilt file: `/fast/projects/pdf-upgrade-report/index.html` (fast SSD for serving).
After each rebuild: `cp` to served location.

---

## Stage 5: Email to Jonah Winters (src/pdf-upgrade/email.js)

Batched, not per-document. Manual gate by default.

### Trigger

Configurable: every N upgrades (default 20) OR weekly cron.
Writes draft to `_meta/email-drafts/YYYY-MM-DD.txt` and stops.
Operator sets `AUTO_EMAIL=true` in .env to enable fully automated send.

### Email template

```
Subject: Improved OCR for [N] bahai-library.com documents -- drop-in replacements

Hi Jonah,

We're running an automated archival enhancement project on the bahai-library.com
document collection. This week we upgraded [N] PDFs with significantly improved
OCR text layers using local AI models.

Each upgraded file is a drop-in replacement:
- Same page images, no visual changes
- Full text now selectable, copyable, and indexable by search engines
- PDF/A-3 archival format with XMP metadata (title, author, keywords)
- Clickable table of contents where headings were detected

Sample improvements this batch:
[table: title | pages | quality before | quality after]

Full project report (all upgrades to date): [URL]
Download this batch: [URL]

Average OCR quality improvement this batch: [X]%
Estimated new words made searchable: [N]

These are offered freely with no strings attached. Drop-in replacement should
improve organic search discoverability for these documents.

-- Chad (chadananda@gmail.com)
   Automated by site2rag pdf-upgrade pipeline
```

---

## New .env keys

```
LOCAL_LLM=http://boss.taile945b3.ts.net:8000/v1
LOCAL_LLM_MODEL=                  # e.g. qwen2-vl or minicpm-v
LOCAL_LLM_TIMEOUT_MS=30000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=chadananda@gmail.com
SMTP_PASS=                        # app password
EMAIL_FROM=chadananda@gmail.com
JONAH_EMAIL=                      # bahai-library.com contact email
AUTO_EMAIL=false
UPGRADE_SCORE_THRESHOLD=0.7       # only queue PDFs scoring below this
UPGRADE_REPORT_PATH=/fast/projects/pdf-upgrade-report
```

---

## New files

```
src/pdf-upgrade/
  index.js       -- PM2 worker, queue loop (one doc per tick)
  score.js       -- PDF quality scoring, no AI
  reocr.js       -- boss API calls, page-by-page, caching
  rebuild.js     -- pdf-lib overlay + OCRmyPDF PDF/A output
  report.js      -- static HTML report generator
  email.js       -- draft + send logic
```

---

## ecosystem.config.cjs additions

```js
{
  name: 'pdf-upgrade',
  script: './src/pdf-upgrade/index.js',
  cwd: '/tank/site2rag/app',
  env: { NODE_ENV: 'production', SITE2RAG_ROOT: '/tank/site2rag' },
  autorestart: true,
  watch: false,
  cron_restart: '*/5 * * * *',
  max_memory_restart: '1G',
  out_file: '../logs/pdf-upgrade.out.log',
  error_file: '../logs/pdf-upgrade.err.log'
}
```

---

## websites.yaml entry for bahai-library.com

```yaml
- domain: bahai-library.com
  url: https://bahai-library.com/
  enabled: true
  export_md: true
  check_every_days: 14
  max_depth: 6
  timeout_seconds: 3600
  assets:
    enabled: true
    types: [image, document]
  ocr:
    mode: single
    engines: [tesseract]          # cheap initial pass for scoring only
    min_text_chars_per_page: 50
  archive:
    enabled: false
  retention:
    gone_grace_days: 90
    preserve_always: false
```

Note: tesseract gives us a quick text extraction for quality scoring.
The pdf-upgrade pipeline does the real re-OCR via boss.

---

## Phased rollout

### Phase 1 -- Mirror and score (ready to start now)
- Add pdf_quality + pdf_upgrade_queue tables to db.js
- Add scoring step to export-doc pipeline
- Configure bahai-library.com in websites.yaml
- Let site2rag run -- get a full quality score distribution across the collection

### Phase 2 -- Re-OCR (after Phase 1 data)
- Build score.js, reocr.js
- Find out what vision model boss is running
- Test on 10 worst-scoring PDFs, evaluate output quality

### Phase 3 -- Rebuild and report (after Phase 2 validation)
- Build rebuild.js (pdf-lib + OCRmyPDF PDF/A)
- Build report.js
- Wire up pdf-upgrade PM2 process
- Get report page hosted and publicly accessible

### Phase 4 -- Email (after Phase 3 is solid)
- Build email.js
- Review first draft email manually
- Send to Jonah, share report URL
