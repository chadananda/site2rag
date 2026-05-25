# Worker Agent API — Specification

Each machine in the worker pool exposes this API on port **49910**.
Workers advertise only what is installed, running, and reachable on that machine.
The pipeline selects workers based on the `tools` map and current load.

---

## Supported Technologies

All capabilities appear as boolean keys in the `tools` map returned by `/health`.

### Hardware
| Key | Technology |
|-----|-----------|
| `gpu:cuda` | NVIDIA CUDA GPU (AMD ROCm also reports `true` here) |
| `gpu:rocm` | AMD ROCm GPU |
| `gpu:metal` | Apple Silicon GPU |

### Document Preprocessing
| Key | Technology |
|-----|-----------|
| `gs` | Ghostscript — PDF normalization and rasterization |
| `pdftoppm` | Poppler — PDF to image per page |
| `convert` | ImageMagick — image preprocessing |
| `unpaper` | Scan deskew and despeckle |
| `ffmpeg` | Media processing |

### OCR Engines
| Key | Technology | GPU benefit |
|-----|-----------|-------------|
| `tesseract` | Tesseract — script detection (OSD) + OCR, all language packs | No |
| `easyocr_ocr` | EasyOCR — multi-script, all languages | Yes |
| `paddle_ocr` | PaddleOCR — CJK-optimized, Arabic, Latin | Yes |
| `doctr_ocr` | DocTR — printed document understanding | Yes |
| `kraken_ocr` | Kraken — historical and Latin OCR | No |
| `surya_ocr` | Surya — layout segmentation + OCR for complex layouts | Yes |

### Document Intelligence
| Key | Technology | Requires |
|-----|-----------|----------|
| `marker` | Marker — PDF → Markdown with layout understanding | GPU recommended |
| `llm` | Local LLM — orchestration, re-ranking, analysis | VRAM ≥16 GB |
| `llm:thinking` | Thinking/reasoning LLM | VRAM ≥20 GB |
| `vision` | Vision model — image → text | VRAM ≥8 GB |
| `html2md` | HTML/DOCX/EPUB → Markdown | No |

---

## API

### `GET /health`

Full capability and load snapshot.

**Response 200**
```json
{
  "status": "ok",
  "hostname": "boss",
  "platform": "linux",
  "cpu_cores": 16,
  "ram_gb": 128,
  "cpu_pct": 42.0,
  "mem_pct": 31.0,
  "disk_free_gb": 850.0,
  "queue_depth": 2,
  "active_jobs": 3,
  "total_jobs": 1482,
  "uptime_seconds": 86400,
  "available": true,
  "capacity_limit_pct": 80,
  "tools": {
    "gpu:rocm": true,
    "gpu:cuda": false,
    "gpu:metal": false,
    "gs": true,
    "pdftoppm": true,
    "convert": true,
    "unpaper": true,
    "ffmpeg": true,
    "tesseract": true,
    "easyocr_ocr": true,
    "paddle_ocr": true,
    "doctr_ocr": true,
    "kraken_ocr": true,
    "surya_ocr": true,
    "marker": true,
    "llm": true,
    "llm:thinking": true,
    "vision": true,
    "html2md": true
  }
}
```

`available` is `false` when `cpu_pct` or `mem_pct` exceeds `capacity_limit_pct` (default 80). Workers with `available: false` are skipped for new jobs.

---

### `GET /capacity`

Lightweight load check — no tool list.

**Response 200**
```json
{
  "available": true,
  "cpu_pct": 42.0,
  "mem_pct": 31.0,
  "queue_depth": 2,
  "active_jobs": 3
}
```

---

### `POST /tools/run`

Execute any advertised tool. Files are transferred as base64 — no shared filesystem required.

**Request**
```json
{
  "tool": "easyocr_ocr",
  "args": ["__dir_0", "__out_0.json"],
  "timeout": 120000,
  "inputFiles": {
    "__dir_0/page_001.png": "<base64>",
    "__dir_0/page_002.png": "<base64>"
  },
  "outputPaths": ["__out_0.json"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool` | string | yes | Any key from `tools` that is `true` |
| `args` | string[] | yes | Arguments passed to the tool |
| `timeout` | integer | no | Milliseconds, default 120000 |
| `inputFiles` | object | no | `filename → base64`. Directories: `__dir_N/filename` keys |
| `outputPaths` | string[] | no | Keys to collect from worker and return as base64 |

**Response 200**
```json
{
  "stdout": "...",
  "stderr": "...",
  "duration_ms": 1840,
  "outputFiles": {
    "__out_0.json": "<base64>"
  }
}
```

| Status | Meaning |
|--------|---------|
| 200 | Tool completed |
| 400 | Missing tool or args |
| 503 | Worker over capacity — retry with another worker |
| 500 | Tool execution failed |

---

## OpenAPI Specification

```yaml
openapi: "3.0.0"
info:
  title: site2rag Worker Agent
  version: "1.1.0"
  description: |
    Universal worker agent. Each machine advertises the tools it can serve
    based on installed software and available hardware. The pipeline uses /health
    to select the best worker per job type.

servers:
  - url: http://{host}:49910
    variables:
      host:
        default: localhost

paths:
  /health:
    get:
      summary: Full capabilities and current load
      responses:
        "200":
          description: Worker health snapshot
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/HealthResponse"

  /capacity:
    get:
      summary: Lightweight availability check (no tool list)
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CapacityResponse"

  /tools/run:
    post:
      summary: Execute an advertised tool
      description: |
        Accepts any tool key that is true in /health tools.
        Input files passed as base64 — no shared filesystem needed.
        Directories use __dir_N/filename key convention.
        Output files returned as base64 in outputFiles.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RunRequest"
      responses:
        "200":
          description: Tool completed successfully
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/RunResponse"
        "400":
          description: Missing tool or args
        "503":
          description: Worker over capacity — retry with another worker
        "500":
          description: Tool execution failed

components:
  schemas:

    Tools:
      type: object
      description: |
        All keys are boolean. true means the tool is installed and reachable.
        LLM/vision/marker keys are false on machines without sufficient VRAM.
      properties:
        "gpu:cuda":      { type: boolean, description: "NVIDIA CUDA or AMD ROCm GPU" }
        "gpu:rocm":      { type: boolean, description: "AMD ROCm GPU" }
        "gpu:metal":     { type: boolean, description: "Apple Silicon GPU" }
        gs:              { type: boolean, description: "Ghostscript" }
        pdftoppm:        { type: boolean, description: "Poppler PDF to image" }
        convert:         { type: boolean, description: "ImageMagick" }
        unpaper:         { type: boolean, description: "Scan deskew and despeckle" }
        ffmpeg:          { type: boolean, description: "Media processing" }
        tesseract:       { type: boolean, description: "Tesseract OCR + OSD" }
        easyocr_ocr:     { type: boolean, description: "EasyOCR — multi-script" }
        paddle_ocr:      { type: boolean, description: "PaddleOCR — CJK, Arabic, Latin" }
        doctr_ocr:       { type: boolean, description: "DocTR — printed documents" }
        kraken_ocr:      { type: boolean, description: "Kraken — historical OCR" }
        surya_ocr:       { type: boolean, description: "Surya — layout + OCR" }
        marker:          { type: boolean, description: "Marker — PDF to Markdown" }
        llm:             { type: boolean, description: "Local LLM (requires VRAM ≥16GB)" }
        "llm:thinking":  { type: boolean, description: "Reasoning LLM (requires VRAM ≥20GB)" }
        vision:          { type: boolean, description: "Vision model (requires VRAM ≥8GB)" }
        html2md:         { type: boolean, description: "HTML/DOCX/EPUB to Markdown" }

    HealthResponse:
      type: object
      properties:
        status:             { type: string, enum: [ok, busy] }
        hostname:           { type: string }
        platform:           { type: string, enum: [linux, darwin, win32] }
        cpu_cores:          { type: integer }
        ram_gb:             { type: number }
        cpu_pct:            { type: number, description: "0–100" }
        mem_pct:            { type: number, description: "0–100" }
        disk_free_gb:       { type: number }
        queue_depth:        { type: integer }
        active_jobs:        { type: integer }
        total_jobs:         { type: integer }
        uptime_seconds:     { type: integer }
        available:          { type: boolean, description: "False when cpu_pct or mem_pct exceeds capacity_limit_pct" }
        capacity_limit_pct: { type: integer, default: 80 }
        tools:
          $ref: "#/components/schemas/Tools"

    CapacityResponse:
      type: object
      properties:
        available:   { type: boolean }
        cpu_pct:     { type: number }
        mem_pct:     { type: number }
        queue_depth: { type: integer }
        active_jobs: { type: integer }

    RunRequest:
      type: object
      required: [tool, args]
      properties:
        tool:
          type: string
          description: Any key from Tools that is true on this worker
        args:
          type: array
          items: { type: string }
        timeout:
          type: integer
          default: 120000
          description: Milliseconds before the worker aborts the job
        inputFiles:
          type: object
          description: |
            filename → base64 content.
            Directories: use __dir_N/filename keys.
          additionalProperties: { type: string, format: byte }
        outputPaths:
          type: array
          items: { type: string }
          description: Keys to collect after run and return as base64

    RunResponse:
      type: object
      properties:
        stdout:      { type: string }
        stderr:      { type: string }
        duration_ms: { type: integer }
        outputFiles:
          type: object
          additionalProperties: { type: string, format: byte }
```
