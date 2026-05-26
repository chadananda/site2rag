# site2rag

Web crawler → RAG export pipeline. Mirrors websites, classifies pages, exports Markdown, scores PDFs. Low-scoring PDFs are submitted to the external SLP service for OCR upgrade.

## Architecture

```
src/index.js (PM2 daemon)
  └─ per site: sitemap → mirror → classify → export → score-pdfs → archive → retain
                                                             ↓
                                                    SLP service (port 49900)
                                                    submitted via slp-client.js
bin/report-server.js (port 7840, Cloudflare Tunnel)
  └─ /api/* routes + static public/ serving
  └─ polls SLP for job progress, saves receipt to pdf_upgrade_queue
public/ (Cloudflare Pages CDN)
  └─ Alpine.js dashboard → calls report-server API
bin/lnker-server.js (port 7841)
  └─ {domain}.lnker.com → websites_mirror/{domain}/ (archive viewer)
bin/worker-agent.js/py (port 49910)
  └─ OCR tool runner — self-registers with SLP as a GPU/CPU worker
```

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
