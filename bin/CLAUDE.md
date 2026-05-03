# bin/ — Entry points and servers

- **site2rag.js** — CLI entry point: parses commands, opens DB, runs pipeline stages
- **report-server.js** — HTTP API routes only; delegates to report-queries, report-utils, thumb-worker-pool
- **report-queries.js** — siteSummary(), siteDocs(), recentRuns() (SQL → API data shapes)
- **report-utils.js** — stripHtml(), getLinkContext(), buildFreeSummary(), mapDoc(), buildSummaryPrompt()
- **thumb-worker-pool.js** — generateThumb() via Worker thread pool (pdfjs+canvas)
- **thumb-worker.js** — Worker thread: renders PDF page to JPEG thumbnail
