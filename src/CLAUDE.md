# src/ — Core crawl pipeline

Entry: `index.js` (PM2 daemon). Per-site pipeline: sitemap → mirror → classify → export → score-pdfs → archive → retain.
PDF upgrades are submitted to the external SLP service via `slp-client.js`; no local upgrade pipeline here.

| File | Exports | Purpose |
|------|---------|---------|
| **index.js** | — | PM2 entry. 15-min tick loop; runs each due site through full pipeline. 4-hour hard timeout per site. |
| **db.js** | `openDb` `startRun` `finishRun` `upsertPage` `upsertSitemap` `markSitemapRemoved` `getMeta` `setMeta` `logLlmCall` | better-sqlite3 wrapper. Opens/migrates `_meta/site.sqlite`. Schema: pages, hosts, sitemaps, pdf_quality, pdf_upgrade_queue, exports, ocr_pages, llm_calls, runs, site_meta, assets. |
| **config.js** | `loadConfig` `mergeSiteConfig` `getMirrorRoot` `mirrorDir` `mdDir` `metaDir` `assetsDir` | Reads `websites.yaml`. Deep-merges defaults + per-site config. Path helpers lazy (env read at call time). Auto-loads `.env`. |
| **mirror.js** | `runMirror` + re-exports from mirror-crawl | Crawl loop. Sitemap + recheck queue. Concurrent fetch (20). Conditional GET, robots. Pluggable adapter. |
| **mirror-crawl.js** | `urlToMirrorPath` `urlPathToSlug` `inScope` `parseRobots` `extractLinks` | Pure crawl utils. URL→path (query hashing, 200-byte filename limit). No side effects. |
| **fetch-adapters.js** | `getAdapter` `createHttpAdapter` `createMediaWikiAdapter` `createWordPressRssAdapter` | Pluggable fetch backends. Each: `fetch(url, existingPage) → {status,buf,mimeType,etag,lastModified}\|null`. |
| **playwright-fetch.js** | `createPlaywrightPool` `isHtmlShell` `isWorthRendering` | Playwright pool for JS-rendered SPAs. Requires `npx playwright install chromium`. |
| **classify.js** | `classifyPage` `runClassify` `wordCount` `computeDocFeatures` | 4-role classifier: content/index/host_page/redirect. Rules-first → Readability fallback. |
| **export-html.js** | `exportHtmlPage` `runExportHtml` | HTML → Markdown + frontmatter. Turndown+GFM. Skips unchanged via content hash. |
| **export-doc.js** | `exportTextPdf` `exportDocx` `runExportDoc` `addBacklink` `assembleDocMd` | PDF/DOCX → MD. Text-layer only (no OCR). Image PDFs queued to SLP via `maybeQueue`. |
| **export-doc-utils.js** | `addBacklink` `assembleDocMd` | MD assembly: per-page backlinks, metadata headers. |
| **score.js** | `scorePdf` `saveQualityScore` `maybeQueue` `wordQuality` `extractBadSample` `ocrNoiseRatio` `detectLanguage` `LANG_COST` `LANG_PRIORITY` | PDF quality scoring (heuristics, no AI). Saves to pdf_quality. `maybeQueue` inserts low-scorers into pdf_upgrade_queue for SLP submission. |
| **score-pdfs.js** | `runScorePdfs` | Scores unscored PDFs in parallel via score-worker threads. 5-min budget, max 4 threads. |
| **score-worker.js** | Worker thread | Scores a single PDF via score.js, returns metrics via postMessage. |
| **slp-client.js** | `PipelineClient` | SLP service HTTP client. `submitJob({pdfPath,sourceUrl,importance}) → jobId`. Used by report-server to submit upgrades. |
| **sitemap.js** | `runSitemap` `parseSitemapXml` | Fetches sitemap.xml, diffs added/changed/removed. |
| **rules.js** | `compileRules` `applyFollowOverride` `applyClassifyOverride` `stripQueryParams` | Compiles site rules block to pre-built RegExps. Pure/deterministic. |
| **metadata.js** | `extractMetadata` | JSON-LD, OpenGraph, meta tags, byline heuristics → title/authors/date. |
| **language.js** | `detectLanguage` `detectLanguageFromUrl` `LANG_COST` `LANG_DISPLAY` `LANG_PRIORITY` `LANG_WORDS` | Unicode-range language detection + cost/priority tables. |
| **constants.js** | `DOC_MIMES` `DOC_EXTS` `IMAGE_MIMES` | Shared MIME/extension sets. |
| **assets.js** | `runAssets` | Downloads images/docs linked from crawled HTML. SHA256 dedup → `_assets/`. |
| **archive.js** | `runArchive` | ETag-based S3 sync of mirror files to Wayback. |
| **retain.js** | `runRetain` | 90-day grace deletion, degradation freeze, tombstone management. |
