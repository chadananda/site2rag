# bin/ — HTTP servers, workers, daemons

| File | Entry / Port | Purpose |
|------|-------------|---------|
| **report-server.js** | HTTP :7840 (127.0.0.1) | API + static file server. Routes: /api/sites /api/docs /api/docs/upgrade /api/docs/reset /api/thumbnail /api/runs /api/pdf /api/focus /api/activity. Serves public/ as static. Admin auth via REPORT_ADMIN_PASSWORD. Polls SLP pipeline for job status every 3s. |
| **report-queries.js** | — | SQL → API shapes. Exports: `siteSummary`, `siteDocs`, `siteTabCounts`, `recentRuns`. Dir-size cache (5min TTL, async so requests never block). |
| **report-utils.js** | — | Response transforms. Exports: `stripHtml`, `getLinkContext`, `buildFreeSummary`, `mapDoc`, `buildSummaryPrompt`. `mapDoc` is the central row→API shape transform; includes cost estimates, score trails, receipt parsing, narrative. |
| **thumb-worker-pool.js** | — | Exports: `generateThumb(pdfPath,outPath)`. Worker thread pool (4–8 threads) for PDF→JPEG via pdfjs+canvas. |
| **thumb-worker.js** | Worker thread | pdfjs render at 2× → downscale. Falls back to pdftoppm for scanned PDFs that render blank. |
| **lnker-server.js** | HTTP :7841 | Archive mirror server. Maps `{domain}.lnker.com` Host header → `websites_mirror/{domain}/`. Rewrites internal links. robots: noindex. |
| **setup.js** | postinstall | Idempotent PM2 registration. Safe to re-run. |
| **updater.js** | PM2 daemon | Polls GitHub, fast-forward pull, `pm2 reload` on update. Interval: UPDATE_CHECK_INTERVAL_MIN (default 15). |

> OCR/upgrade processing lives entirely in the separate **SLP** service. site2rag has
> no local OCR workers — it submits jobs to SLP (`PIPELINE_URL`) and polls results.

## PM2 processes (all site2rag-owned, prefixed for clear ownership)

`site2rag` (crawler) · `site2rag-report` (report-server :7840) · `site2rag-lnker` (lnker-server :7841) · `site2rag-updater`.

## Deploy

- **UI (Cloudflare Pages)**: `npm run deploy:ui` or `npm run deploy:all`
- **Backend (tower-nas)**: `npm run deploy:backend` → git push + SSH pull + pm2 reload ecosystem

## Key env vars (report-server)

`PIPELINE_URL` — public SLP API base URL (set in SITE2RAG_ROOT/.env; no localhost default). Without it, upgrade/polling is disabled.
`REPORT_ADMIN_PASSWORD` — enables admin endpoints (upgrade, reset, focus).
`SITE_SESSIONS_FILE` — path to sessions JSON for multi-site UI.
