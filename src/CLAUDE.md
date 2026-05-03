# src/ — Core pipeline modules

- **constants.js** — DOC_MIMES, DOC_EXTS, IMAGE_MIMES (shared across mirror, classify, assets)
- **language.js** — detectLanguage(), LANG_COST, LANG_DISPLAY, LANG_PRIORITY
- **mirror.js** — runMirror() crawl loop; re-exports crawl utilities from mirror-crawl.js
- **mirror-crawl.js** — pure crawl utilities: urlToMirrorPath, urlPathToSlug, inScope, parseRobots, extractLinks
- **export-html.js** — exportHtmlPage(), runExportHtml()
- **export-doc.js** — exportTextPdf(), runExportDoc(); re-exports from export-doc-utils.js
- **export-doc-utils.js** — addBacklink(), assembleDocMd()
- **classify.js** — runClassify() page role classification (content/index/host_page/redirect)
- **db.js** — all DB access, openDb(), upsertPage(), llmCost(), logLlmCall()
- **rules.js** — compileRules(), applyFollowOverride(), applyClassifyOverride(), stripQueryParams()
- **config.js** — path helpers: mirrorDir(), mdDir(), metaDir(), assetsDir(), getMirrorRoot()
- **metadata.js** — extractMetadata() from HTML: title, authors, dates, schema.org
- **assets.js** — runAssets() image/document download + sha256 dedup
- **sitemap.js** — runSitemap(), parseSitemapXml()
- **archive.js** — runArchive() Wayback Machine backup
- **retain.js** — runRetain() cleanup of gone pages
