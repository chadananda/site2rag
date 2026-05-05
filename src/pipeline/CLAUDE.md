# src/pipeline/ — OCR upgrade pipeline

Entry point: `index.js` → `runPipeline(opts)` chains all stages, writes receipt + analytics.

## Files
- **index.js** — `runPipeline()`, `runStage()`, `STAGES` registry, `buildSystemPrompt()`
- **context.js** — `PipelineContext`: per-doc state, metrics, quality scores, domain, receipt
- **config.js** — `DEFAULT_CONFIG`, `mergeConfig()`, `shouldRun()`, `withinBudget()`
- **domain-detect.js** — `detectDomain()`: cascade (site profile → pattern match → Haiku)
- **analytics.js** — `writeAnalytics()`: privacy-safe metrics → analytics SQLite DB (includes `improvement_suggestions` table)
- **improve.js** — `analyzeRun()`: heuristic post-run improvement analysis; `reviewSuggestions()`: periodic digest query
- **job-store.js** — `JobStore`: SQLite-backed job queue for the HTTP service (separate DB from site DBs and analytics)
- **server.js** — `startPipelineServer()`: HTTP service wrapping `runPipeline()` — REST API for deployment isolation
- **client.js** — `PipelineClient`: HTTP client for site2rag (and any other caller) — change `baseUrl` to move the service

## HTTP service (pipeline-server)
Entry: `bin/pipeline-server.js` — run as PM2 process on port 49900.

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | `{ status, version, queue_depth }` |
| `/jobs` | POST | Submit job: `{ pdfPath, sourceUrl, meta, config, importance }` → `{ jobId }` |
| `/jobs/:id` | GET | Job status + `has_markdown`/`has_pdf` flags |
| `/jobs/:id/md` | GET | Corrected markdown (when done) |
| `/jobs/:id/pdf` | GET | Upgraded PDF binary (when done) |
| `/jobs/:id` | DELETE | Remove job record |

**To move the service**: set `PIPELINE_URL=http://new-host:49900` in the upgrade worker env. No code changes.
**To enable**: set `PIPELINE_URL` in pdf-upgrade-worker env. Unset = old Marker/OCR flow (automatic fallback if service unreachable).

## Stages (`stages/`)
| Stage | File | Status | Purpose |
|-------|------|--------|---------|
| s0 | s0-baseline.js | ✅ | Score PDF, detect domain, set early-exit flags |
| s1 | s1-preprocess.js | stub | Deskew, despeckle, binarize (in-memory, no coord loss) |
| s2 | s2-classify.js | stub | Region classification on low-res thumbnails |
| s3 | s3-ocr.js | stub | Tesseract hOCR + PaddleOCR routing + crop-offset correction |
| s4 | s4-escalate.js | stub | Alt OCR strategies for dirty regions |
| s5 | s5-vision.js | stub | Boss/cloud vision + edit-distance bbox alignment |
| s6 | s6-spellfix.js | ✅ | Haiku spell-fix on fuzzy-confidence words only |
| s7 | s7-archive.js | stub | Rebuild archival PDF with improved text layer |
| s8 | s8-export.js | stub | Export corrected text as Markdown with page anchors |

## Domain detection (generic, not hardcoded)
`ctx.domain` is populated by `detectDomain()` at s0 via a three-layer cascade:
1. **Site profile lookup** — `config.lookupDomainProfile(host)` callback (injected by caller)
2. **Pattern matching** — keyword scoring against URL, title, anchor text, language
3. **Haiku inference** — only if layers 1+2 confidence < 0.75 and `config.apiKey` is set

Callers can bypass detection entirely by pre-populating `ctx.domain` before calling `runPipeline`,
or disable it with `config.domainDetect: false`. The pipeline makes no assumptions about domain.

`ctx.domain.prompt_context` (2-4 sentence expert briefing) is injected into every LLM stage
via `buildSystemPrompt(stageInstructions, ctx)` from `index.js`.

## Analytics (privacy-safe)
`config.analyticsDbPath` → enables analytics write after each pipeline run.
**Logged**: numeric metrics, stage names, error codes, domain signals, site hostname.
**Never logged**: document text, file paths, URLs, titles, raw error messages, doc_id.
`run_id` in analytics DB = one-way SHA-256 hash of (docId + timestamp) — opaque, unrecoverable.
See `analytics.js` header for full privacy contract.

## Key invariants
- Each stage calls `ctx.beginStage` / `ctx.endStage` — always in a finally block
- Stages check `shouldRun(stageName, ctx)` at entry and return early if skipping
- All writes mutate `ctx`; each stage returns `ctx` for chaining
- `ctx.quality.perStage` tracks composite score per stage → drives `cost_per_quality_point`
- Confidence buckets: clean ≥90%, fuzzy 60-90%, dirty <60% (configurable via thresholds)
- `buildSystemPrompt(instructions, ctx)` prepends domain context to any LLM stage prompt

## Self-improvement hooks
- `config.implementations.spellfix[0]` selects model (A/B via index)
- `ctx.metrics.decisions` records every routing choice with code + value
- `toReceipt()` computes `cost_per_quality_point = total_cost / quality_gain`
- `domain_profiles` table accumulates `avg_quality_gain` per site over time
- Tests cover contracts only — implementations are swappable without breaking tests
