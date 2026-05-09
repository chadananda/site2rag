# bin/ — Entry points and servers

- **site2rag.js** — CLI entry point: parses commands, opens DB, runs pipeline stages
- **report-server.js** — HTTP API routes only; delegates to report-queries, report-utils, thumb-worker-pool
- **report-queries.js** — siteSummary(), siteDocs(), recentRuns() (SQL → API data shapes)
- **report-utils.js** — stripHtml(), getLinkContext(), buildFreeSummary(), mapDoc(), buildSummaryPrompt()
- **thumb-worker-pool.js** — generateThumb() via Worker thread pool (pdfjs+canvas)
- **thumb-worker.js** — Worker thread: renders PDF page to JPEG thumbnail
- **worker-agent.py** — Universal worker agent (Python 3, no external deps); runs on any machine; GET /health, GET /capacity, POST /tools/run; auto-detects CPU/GPU/tools; self-registers with pipeline-server registry
- **worker-agent.js** — Node.js version of worker agent (same interface; for machines with Node but not Python)
- **install-worker.sh** — One-command deploy: `bin/install-worker.sh <host> [--registry URL]`; installs as LaunchAgent (macOS) or systemd unit (Linux)
