# src/pipeline/ — OCR upgrade pipeline

Entry: `index.js` → `runPipeline(opts)` → chains s0–s8, writes receipt + analytics.

## Files

| File | Exports | Purpose |
|------|---------|---------|
| index.js | `runPipeline(opts)` | stage orchestration, receipt, analytics |
| context.js | `PipelineContext`, `PIPELINE_VERSION` | per-doc state, metrics, ctx.run |
| config.js | `DEFAULT_CONFIG`, `mergeConfig`, `shouldRun`, `withinBudget`, `llmCost`, `MODEL_RATES` | defaults, thresholds, cost model |
| tool-runner.js | `createToolRunner(config)→run` | local\|http\|cloud tool routing |
| domain-detect.js | `detectDomain(ctx)` | cascade: site profile → pattern → Haiku |
| analytics.js | `writeAnalytics(ctx,path)` | privacy-safe metrics → analytics SQLite |
| improve.js | `analyzeRun(ctx)`, `reviewSuggestions(db)` | post-run heuristic improvement analysis |
| job-store.js | `JobStore` | SQLite-backed HTTP job queue |
| server.js | `startPipelineServer(opts)` | HTTP wrapper: `/health`, `/jobs`, `/tools/run` |
| client.js | `PipelineClient` | HTTP client for pipeline-server |

## Stages

| Stage | File | Exports | Purpose |
|-------|------|---------|---------|
| s0 | s0-baseline.js | `s0Baseline` | quality score, domain detect, early-exit flags |
| s1 | s1-preprocess.js | `s1Preprocess`, `CORRUPT_PATTERN` | gs normalize, unpaper per page |
| s2 | s2-classify.js | `s2Classify`, `langToRegionType` | Haiku region classification on thumbnails |
| s3 | s3-ocr.js | `s3Ocr`, `parseHocr`, `repairHyphens`, `resolveLang`, `cleanRatio` | All CPU engines on every block crop → Surya only if dirty → Haiku synthesis always (unless all engines failed) → dirty blocks marked for s4 |
| s4 | s4-escalate.js | `s4Escalate`, `buildDraftPrompt` | Local vision escalation (boss/Surya at higher res) on dirty block crops from s3 |
| s5 | s5-vision.js | `s5Vision` | Specialist API escalation per block type: Mistral OCR (Arabic/Persian), Claude Opus (handwritten), Gemini (tables) |
| s6 | s6-spellfix.js | `s6SpellFix` | Haiku spell-fix on fuzzy-confidence words |
| s7 | s7-archive.js | `s7Archive` | rebuild archival PDF with corrected text layer |
| s8 | s8-export.js | `s8Export`, `adaptWord` | export corrected Markdown with page anchors |

## HTTP service (pipeline-server)

Run: `bin/pipeline-server.js` on port 49900.

| Route | Method | Body / Response |
|-------|--------|-----------------|
| `/health` | GET | `{status,version,queue_depth,deps,missing_required}` — 503 if required tool missing |
| `/jobs` | POST | body: `{pdfPath,sourceUrl?,meta?,config?,importance?}` → `{jobId}` |
| `/jobs/:id` | GET | `{status,progress,receipt?,error?,has_markdown,has_pdf}` |
| `/jobs/:id/md` | GET | corrected markdown (text/markdown) |
| `/jobs/:id/pdf` | GET | upgraded PDF (application/pdf) |
| `/jobs/:id` | DELETE | `{ok:true}` |
| `/tools/run` | POST | body: `{tool,args,timeout?}` → `{stdout,stderr}` — executes CLI on this host |

## Key invariants

- Every stage calls `ctx.beginStage` / `ctx.endStage` — always in a `finally` block
- Stages check `shouldRun(stage, ctx)` at entry and return early if skipping
- `ctx.run(tool, args, opts)` routes CLI calls per `config.toolBackends` — stages never call execFile directly
- Confidence bands: clean ≥90%, fuzzy 60–90%, dirty <60% (configurable via thresholds)
- `buildSystemPrompt(instructions, ctx)` prepends domain context to any LLM stage prompt
