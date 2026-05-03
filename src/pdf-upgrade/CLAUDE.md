# src/pdf-upgrade/ — PDF quality scoring and OCR upgrade pipeline

- **index.js** — upgrade loop daemon: tick(), run(), upgradeDocument(), resetStuckProcessing()
- **backfill.js** — backfillHostsFromMirror(): one-time anchor text extraction from crawled HTML
- **lang-detect.js** — detectLanguageForImagePdfs(): free Unicode scan + Tesseract+Haiku cascade
- **summarize.js** — summarizeTopPending(): Haiku API summaries for pending queue items
- **score.js** — scorePdf(), saveQualityScore(), maybeQueue(); re-exports detectLanguage, LANG_COST, LANG_PRIORITY from language.js
- **identify.js** — identifyDocument(): 3-stage pipeline (Tesseract OSD → Haiku → boss vision)
- **reocr.js** — reocrDocument(), bossAvailable(), ocrAvailableBackend()
- **rebuild.js** — rebuildPdf(): assembles OCR results into a new PDF with text layer
