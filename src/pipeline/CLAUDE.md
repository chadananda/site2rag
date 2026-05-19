# src/pipeline/ — OCR upgrade pipeline

Entry: `index.js` → `runPipeline(opts)` → chains s0–s8, writes receipt + analytics.
HTTP service: `server.js` on port 49900. Client: `client.js` → `PipelineClient`.

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
| server.js | `startPipelineServer(opts)` | HTTP wrapper — see routes below |
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

Start: `node bin/pipeline-server.js` or `pm2 start bin/pipeline-server.js`. Default port: **49900**.

### Routes

| Route | Method | Auth | Body / Response |
|-------|--------|------|-----------------|
| `/health` | GET | none | `{status,version,queue_depth,deps,disk,missing_required}` — 503 if broken |
| `/jobs` | POST | Bearer (optional) | `{pdfPath,sourceUrl?,meta?,config?,importance?}` → `{jobId}` |
| `/jobs/:id` | GET | Bearer (optional) | `{id,status,progress,receipt?,error?,has_markdown,has_pdf}` |
| `/jobs/:id/md` | GET | Bearer (optional) | corrected markdown (`text/markdown`) |
| `/jobs/:id/pdf` | GET | Bearer (optional) | upgraded PDF (`application/pdf`) |
| `/jobs/:id` | DELETE | Bearer (optional) | `{ok:true}` |
| `/workers` | GET | Bearer (optional) | `{workers:[{url,hostname,platform,lastSeen,health}]}` |
| `/workers/register` | POST | Bearer (optional) | `{url,hostname?,platform?}` → `{ok:true}` |
| `/tools/run` | POST | Bearer (optional) | `{tool,args,timeout?}` → `{stdout,stderr}` |

**Auth**: if `startPipelineServer({ apiKey })` is set, all routes require `Authorization: Bearer <key>`. Otherwise open.

### Job status values

`pending` → `processing` → `done` | `failed`

Progress shape (from `GET /jobs/:id`):
```json
{
  "stage": "s3-ocr",
  "stage_started_at": "2025-01-01T12:00:00.000Z",
  "total_pages": 12,
  "pages_done": 4,
  "completed": [{"stage":"s0-baseline","pages":12,"ms":340}]
}
```

### Health response

```json
{
  "status": "ok",
  "version": "1.4.0",
  "queue_depth": 2,
  "deps": {
    "tesseract": {"ok": true, "required": true},
    "python_ocr_easyocr": {"ok": true, "required": true},
    "python_ocr_kraken": {"ok": false, "error": "not found: kraken", "required": false}
  },
  "disk": {"path": "/tmp", "avail_gb": 48, "use_percent": 12, "ok": true},
  "missing_required": []
}
```

Returns 503 when `missing_required` is non-empty or disk < 5GB free.

### Worker registry

Workers (GPU hosts like `boss`) self-register on startup:
```
POST /workers/register  { "url": "http://192.168.1.50:4001", "hostname": "boss", "platform": "rocm" }
```

Registry is persisted to `pipeline-workers.db` (sibling of `pipeline-jobs.db`) so it survives server restarts without a 60-second blind window.

Seed via env: `WORKER_URLS=http://boss:4001,http://bayan:4001` (comma-separated).

`GET /workers` refreshes health snapshots (TTL 30s) and prunes workers unreachable for >5 min.

### /tools/run

Remote tool execution endpoint. Executes any CLI tool on the pipeline-server host and returns stdout/stderr. Used by `ToolRunner` when `config.toolBackends[tool] = { type: 'http', url }`.

```json
POST /tools/run
{ "tool": "tesseract", "args": ["/tmp/page.png", "out", "-l", "ara"], "timeout": 30000 }
```

Response: `{ "stdout": "...", "stderr": "..." }` or `{ "error": "...", "code": "ENOENT" }`

## PipelineClient usage

```js
import { PipelineClient } from './client.js';

const client = new PipelineClient({
  baseUrl: process.env.PIPELINE_URL ?? 'http://localhost:49900',
  apiKey: process.env.PIPELINE_API_KEY,   // optional
  pollInterval: 3000,   // ms between status polls
  timeout: 600_000,     // 10 min before waitForJob gives up
});

// Submit by URL — server fetches the PDF (no local file I/O in client)
const jobId = await client.submitJob({ sourceUrl, meta, importance: 1 });

// Poll until done
const job = await client.waitForJob(jobId);   // throws on failure or timeout

// Get outputs
const markdown = await client.getMarkdown(jobId);   // string
const pdfBuf   = await client.getPdf(jobId);         // Buffer

// Or submit + wait in one call
const job = await client.runJob({ sourceUrl, meta });

// Cleanup
await client.deleteJob(jobId);
```

`meta` object shape: `{ title?, author?, language?, anchorText?, ... }` — fed into stage prompts for domain context.

## Key invariants

- Every stage calls `ctx.beginStage` / `ctx.endStage` — always in a `finally` block
- Stages check `shouldRun(stage, ctx)` at entry and return early if skipping
- `ctx.run(tool, args, opts)` routes CLI calls per `config.toolBackends` — stages never call execFile directly
- Confidence bands: clean ≥90%, fuzzy 60–90%, dirty <60% (configurable via thresholds)
- `buildSystemPrompt(instructions, ctx)` prepends domain context to any LLM stage prompt
- Required CLI tools: `pdftoppm tesseract gs surya_ocr unpaper convert`
- Required Python engines: `easyocr paddle doctr` (all have `--check` self-test mode)
- Optional Python engines: `kraken` (improves Arabic; absence causes silent cloud escalation, not failure)
