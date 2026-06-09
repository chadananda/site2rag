# site2rag

Web crawler → RAG export pipeline. Mirrors websites, classifies pages, exports Markdown, scores PDFs. Low-scoring PDFs are submitted to the external SLP service for OCR upgrade.

## Architecture

site2rag owns OCR nothing — all OCR/upgrade work lives in the separate SLP
service. site2rag only submits jobs and polls results via slp-client.js.

```
src/index.js  (PM2: site2rag)
  └─ per site: sitemap → mirror → classify → export → score-pdfs → archive → retain
                                                             ↓
                                                    SLP service (port 49900, separate project)
                                                    submitted via slp-client.js
bin/report-server.js  (PM2: site2rag-report, port 7840, Cloudflare Tunnel)
  └─ /api/* routes + static public/ serving
  └─ polls SLP for job progress, saves receipt to pdf_upgrade_queue
public/ (Cloudflare Pages CDN)
  └─ Alpine.js dashboard → calls report-server API
bin/lnker-server.js  (PM2: site2rag-lnker, port 7841)
  └─ {domain}.lnker.com → websites_mirror/{domain}/ (archive viewer)
bin/updater.js  (PM2: site2rag-updater)
  └─ polls GitHub, fast-forwards, pm2 reloads on update
```

All PM2 processes site2rag owns are prefixed `site2rag-` (or `site2rag`) so
ownership is unambiguous alongside the separate SLP service.

## Deploy

- **All**: `npm run deploy:all` — bumps version, deploys UI to CF Pages, deploys backend to tower-nas
- **UI only**: `npm run deploy:ui`
- **Backend only**: `npm run deploy:backend` — git push + SSH pull + pm2 reload

## Key directories

- `src/` — crawl pipeline modules (see src/CLAUDE.md)
- `bin/` — servers and daemons (see bin/CLAUDE.md)
- `public/` — frontend dashboard (see public/CLAUDE.md)
- `scripts/` — deploy utilities (see scripts/CLAUDE.md)

## Config

`websites.yaml` — list of sites with crawl config. `SITE2RAG_ROOT` env → mirror/db location. See `src/config.js` for all path helpers.

## Database

Per-site SQLite at `{SITE2RAG_ROOT}/{domain}/_meta/site.sqlite`. See `src/db.js` for schema.
