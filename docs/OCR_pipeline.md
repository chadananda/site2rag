# OCR Upgrade Pipeline

## Philosophy

Non-LLM work is essentially free and should be maximized. LLM calls are expensive and must earn their cost by producing measurable quality improvement per token. Difficult sections are never abandoned — they escalate to more capable (and more expensive) tools. Every document that enters the pipeline exits as a durable archival PDF with a complete upgrade receipt.

---

## Stage 0: Intake & Quality Baseline

**Cost: free**

For every PDF, compute a deterministic quality baseline before any processing:

### Per-page quality signals (all deterministic, no LLM)

| Signal | How | Weight |
|---|---|---|
| `text_coverage` | chars extracted / estimated chars from page area | high |
| `readable_pct` | pages where pdftotext yields >50 chars | high |
| `ocr_confidence` | mean Tesseract word confidence (from hOCR) | high |
| `word_error_rate_proxy` | % words not in dictionary (fast spellcheck) | medium |
| `visual_complexity` | std dev of pixel intensity histogram (noise indicator) | medium |
| `skew_angle` | detected rotation angle (0° = clean) | medium |
| `contrast_ratio` | histogram spread (low = faded/washed out) | medium |
| `image_vs_text_ratio` | proportion of page area that is rasterized vs vector | low |
| `font_size_variance` | coefficient of variation of detected font sizes | low |

**Composite quality score** (0.0–1.0) = weighted average. Stored as `quality_baseline` alongside existing `composite_score`.

### Document-level classification

After scoring, classify the document once (cheap Haiku call on a 3-page sample if needed):

```
{
  language: "en" | "ar" | "fa" | "mixed" | ...,
  script_type: "printed" | "handwritten" | "mixed",
  condition: "clean" | "degraded" | "poor",
  has_tables: bool,
  has_figures: bool,
  importance: 0..5   // set by curator or inferred from metadata
}
```

This drives all routing decisions downstream. Computed once, cached permanently.

---

## Stage 1: Image Preprocessing

**Cost: free (CPU only, temp images discarded)**

### Coordinate invariant

All preprocessing operates on a *copy* of the rendered page image. Original PDF is never modified. Bboxes from OCR are transformed back to original page coordinates before saving.

```
render page → 300dpi PNG (original coords)
    ↓
preprocess copy (pixel-value ops only, temp)
    ↓
OCR on preprocessed → bboxes in preprocessed space
    ↓
apply inverse transform if needed (deskew rotation, resize scale)
    ↓
map pixel coords → PDF points (÷ DPI × 72)
    ↓
discard preprocessed image
```

### Preprocessing operations

**Always safe (no coord transform needed):**
- Binarization — Sauvola adaptive thresholding (better than Otsu for uneven lighting)
- Despeckling — median filter (removes salt-and-pepper noise)
- Contrast stretch — histogram normalization
- Sharpening — unsharp mask

**Requires inverse transform:**
- Deskew — detect & correct rotation angle; apply `R⁻¹` to bbox corners after OCR
- Resize — apply scale factor `÷ s` to all bbox coords after OCR

**Dewarping** (curved pages from book scanning) — compute inverse warp map, transform bbox points through it. Only for `condition: "poor"` documents.

### Quality gate

Compare Tesseract confidence before and after preprocessing. If preprocessed result is worse, discard and use original. Never regress.

---

## Stage 2: Per-Page Region Classification

**Cost: ~$0.002/page (one Haiku call per page, cached permanently)**

For each page, identify regions and classify them:

```json
[
  { "region": [x1, y1, x2, y2], "type": "printed_latin" },
  { "region": [x1, y1, x2, y2], "type": "printed_arabic" },
  { "region": [x1, y1, x2, y2], "type": "handwritten" },
  { "region": [x1, y1, x2, y2], "type": "table" },
  { "region": [x1, y1, x2, y2], "type": "figure" },
  { "region": [x1, y1, x2, y2], "type": "degraded" }
]
```

Send a low-res thumbnail (100dpi, JPEG compressed) to Haiku with a structured output prompt. Result is cached — never re-classified unless the page changes.

For documents with `script_type: "printed"` and `condition: "clean"`, skip region classification entirely — treat the whole page as `printed_latin` (or the detected language).

---

## Stage 3: OCR Routing by Region

**Cost: free for Tesseract/PaddleOCR; escalates for vision models**

### Crop → OCR → offset pattern

For each classified region:
1. Crop the (preprocessed) page image at the region bbox
2. Send to the appropriate OCR service
3. Receive word bboxes in crop-local coordinates
4. Add `(cropX, cropY)` offset → full-page coordinates
5. Merge into unified bbox word list

### Routing table

| Region type | Primary OCR | Notes |
|---|---|---|
| `printed_latin` (conf >85%) | Tesseract `eng` | Pass-through, no cost |
| `printed_latin` (conf 50–85%) | Tesseract + binarize | Preprocessing loop |
| `printed_latin` (conf <50%) | → Stage 4 escalation | |
| `printed_arabic` / `printed_persian` | PaddleOCR Arabic | Far better than Tesseract for these scripts |
| `printed_cjk` | PaddleOCR CJK | |
| `handwritten` | → Stage 5 escalation | Cannot be handled cheaply |
| `table` | Tesseract + table extractor | Post-process into structured cells |
| `figure` | Skip (no text expected) | Flag for metadata |
| `degraded` | Tesseract + full preprocessing | Then escalate if still poor |

### Confidence-gated word routing

After initial OCR, split the word bbox list into buckets by Tesseract confidence:

```
conf ≥ 90  → "clean" bucket    — no further processing needed
conf 60–89 → "fuzzy" bucket    — LLM spell-fix pass (Stage 6)
conf < 60  → "dirty" bucket    — escalate to vision model (Stage 5)
```

Only the fuzzy and dirty buckets ever touch an LLM. For a mostly-clean document, this reduces AI token usage by 80–95%.

---

## Stage 4: Escalation — Degraded Printed Text

**Cost: low (local compute, no LLM)**

For regions with conf <50% after preprocessing:

1. **Increase DPI** — re-render at 600dpi; Tesseract improves significantly on small text
2. **Alternative binarization** — try Niblack, Bernsen, and Sauvola; pick highest resulting confidence
3. **PSM tuning** — try Tesseract PSM 3 (auto), 6 (uniform block), 11 (sparse text); take best
4. **Morphological cleanup** — dilate/erode to reconnect broken characters (useful for faded ink)

If conf still <60% after all local attempts → mark region as `needs_vision`, pass to Stage 5.

---

## Stage 5: Escalation — Vision Model (Boss / Cloud)

**Cost: medium–high; fire-and-forget, cached per page**

For `needs_vision` regions and all `handwritten` regions:

### Option A: Correction mode (Tesseract bboxes exist but are poor)

Use vision model as a *corrector*, not a primary OCR engine:

1. Send crop image + Tesseract word sequence to vision model
2. Ask: "Correct the OCR errors in this word list. Return only the corrected sequence."
3. Align corrections back to Tesseract bboxes using edit distance (insertion/deletion aware)
4. Tesseract bboxes survive; text quality improves

This is the cheapest vision path — the model does minimal work, bboxes are pre-established.

### Option B: Primary OCR mode (Tesseract returned nothing usable)

For dense handwriting or completely failed OCR:

1. Send crop to vision model with prompt requesting structured word output
2. Model returns text (no bboxes — vision models cannot generate coordinates)
3. **For moderate handwriting**: create synthetic bboxes by distributing words across region proportionally (rough but captures content)
4. **For dense Nastaliq/calligraphic scripts**: create a single region-level bbox with full text as block content — per-word bbox precision is unrealistic

### Escalation ladder for extreme cases

| Level | Tool | Use case |
|---|---|---|
| 1 | Boss vision model (local) | Standard printed + light degradation |
| 2 | Kraken + OpenITI models | Historical Arabic/Persian printed manuscripts |
| 3 | PaddleOCR Arabic (GPU) | Modern Arabic/Persian printed |
| 4 | GPT-4o / Claude Opus vision | Any script, strong context reasoning |
| 5 | Multi-model consensus | Run L1–L4 on same region; Haiku votes/merges |
| 6 | Domain RAG correction | Match output against existing clean corpus (Bahá'í texts have heavy repetition) |
| 7 | Fine-tuned vision model | Train on verified pages from same document series |
| 8 | Transkribus / eScriptorium | Human-assisted HTR for irreplaceable manuscripts |

Escalation is gated by `importance` score — a low-importance document never reaches L4+. A high-importance document with handwritten Nastaliq warrants L5 or beyond.

---

## Stage 6: LLM Spell-Fix Pass

**Cost: ~$0.001–0.003/page (Haiku); only on fuzzy bucket**

Input: word bbox objects from the "fuzzy" bucket (conf 60–89), plus document context.

### Token efficiency rules

1. **Send word text only** — bboxes, confidence scores, and metadata never enter the prompt
2. **Numbered list format** — `N:word` per line; response is `N:correction` only for changed words
3. **Context injection** — title, page number, previous page tail (last 200 chars) for better corrections
4. **Batch by page** — one API call per page, not per word
5. **Skip foreign terms, proper nouns, numbers** — instruct explicitly in system prompt

### Bbox merge rule for hyphen-split words

When Haiku merges a hyphen-split word (`word-¶continuation` → `wordcontinuation`):
- **Same-line** split (next.y1 ≤ current.y2): union the bboxes horizontally
- **Cross-line** split (next.y1 > current.y2): keep only the first bbox — the continuation was on the next line

### What Haiku fixes

- Line-end hyphen breaks (`antici-¶pates` → `anticipates`)
- Missing spaces (`wordstuck` → `words tuck`)
- Clear character confusions (`rn→m`, `li→h`, `0→O`, `l→1`)
- Obvious misspellings resolvable from context

### What Haiku does not fix

- Proper nouns, names, transliterations
- Foreign language terms
- Numbers, dates, codes
- Anything uncertain

---

## Stage 7: Archival PDF Assembly

**Cost: free (local, ocrmypdf)**

After all OCR corrections are merged into the bbox word list:

1. **Rebuild text layer** — embed corrected word objects as invisible text overlay at exact bbox positions
2. **PDF/A-3 output** — via `ocrmypdf --output-type pdfa-3` for maximum archival durability
3. **Metadata injection** — embed title, author, date, language, source URL, processing date, pipeline version
4. **Page normalization** — standardize page size if inconsistent (common in scanned collections)
5. **Image optimization** — if rasterized, apply lossless compression (JBIG2 for B&W, JPEG2000 for grayscale)

Output: `<original_name>_archival.pdf` — original preserved, archival copy is the deliverable.

---

## Stage 8: MD Export

**Cost: negligible (one lightweight Haiku pass for block repair, optional)**

Convert the archival PDF text layer to structured Markdown with page references:

### Block identification (deterministic)

Using bbox geometry from the corrected word list:

- **Paragraphs** — group words by line proximity; join lines within paragraph; detect cross-page continuation by checking last line of page N against first line of page N+1
- **Headings** — detect by font size variance (significantly larger than body mean)
- **Footnotes** — detect by small font size + bottom-of-page position
- **Captions** — detect by proximity to figure/table regions
- **Block quotes** — detect by consistent left-indent offset

### Cross-page paragraph joining

Key rule: if the last word of page N doesn't end with sentence-terminal punctuation, and the first word of page N+1 starts lowercase, join them as a continuing paragraph. Use the hyphen-merge rule for any words split across the page boundary.

### Page reference anchors

Every paragraph gets `<!-- p.N -->` anchors so citations remain possible. Headings get both the anchor and an `id` attribute.

### Optional block repair pass (Haiku)

For `importance ≥ 3` documents only: one Haiku pass per page that:
- Joins incorrectly split paragraphs
- Identifies running headers/footers and strips them from body text
- Normalizes quotation marks and dashes

Cost: ~$0.001/page. Skip entirely for low-importance documents.

---

## Upgrade Receipt

Every processed document generates a machine-readable receipt stored alongside the archival PDF:

```json
{
  "doc_id": "...",
  "source_url": "...",
  "processed_at": "ISO timestamp",
  "pipeline_version": "1.0",

  "baseline": {
    "composite_score": 0.12,
    "readable_pct": 0.18,
    "mean_ocr_confidence": 0.34,
    "word_error_rate_proxy": 0.61
  },

  "final": {
    "composite_score": 0.68,
    "readable_pct": 0.94,
    "mean_ocr_confidence": 0.87,
    "word_error_rate_proxy": 0.09
  },

  "stages_applied": [
    "preprocessing:binarize+denoise",
    "preprocessing:deskew(angle=1.3deg)",
    "ocr:tesseract_eng",
    "ocr:paddleocr_arabic(2_regions)",
    "escalation:boss_vision(4_regions)",
    "spell_fix:haiku(pages=12,tokens_in=4200,tokens_out=380,cost_usd=0.0013)",
    "archival:pdfa3+metadata",
    "export:markdown+block_repair"
  ],

  "pages": {
    "total": 48,
    "clean_passthrough": 31,
    "preprocessed_only": 9,
    "ocr_corrected": 6,
    "vision_escalated": 2,
    "failed": 0
  },

  "cost_usd": {
    "region_classification": 0.0021,
    "spell_fix": 0.0013,
    "vision_escalation": 0.0184,
    "total": 0.0218
  },

  "notes": [
    "2 pages routed to boss vision (handwritten margin annotations)",
    "PaddleOCR applied to 3 Persian-language sections",
    "Cross-page paragraph joins applied at pp.12-13, 27-28, 41-42"
  ]
}
```

### Re-run behavior

The pipeline is designed to be run multiple times on the same document:
- Each stage checks its own output exists before re-running
- `importance` can be incremented to unlock higher escalation levels
- Individual stages can be forced-rerun (e.g., `--force-spell-fix`) without reprocessing from scratch
- Receipt is versioned — multiple runs append entries rather than overwriting

---

## Quality Score Components (full breakdown)

| Component | Source | Range |
|---|---|---|
| `text_coverage` | pdftotext char density | 0–1 |
| `ocr_confidence` | Tesseract hOCR mean | 0–1 |
| `word_error_rate_proxy` | fast dictionary check | 0–1 (inverted) |
| `visual_quality` | image preprocessing metrics | 0–1 |
| `language_confidence` | language detection certainty | 0–1 |
| `structure_score` | headings/paragraphs detected vs expected | 0–1 |
| `completeness` | pages with content / total pages | 0–1 |

**Composite** = weighted geometric mean (geometric mean penalizes single-dimension failures more fairly than arithmetic mean).

Stored per-page and at document level. The delta between `quality_baseline` and `quality_final` is the headline number on the upgrade receipt.

---

## Domain Detection

Every document runs through a generic domain detection cascade at s0. Domain context is never hardcoded — it is either supplied by the caller or inferred automatically. The pipeline makes no assumptions about what kind of document it is processing.

### Detection layers (cheapest first)

| Layer | Trigger | Signal | Cost |
|-------|---------|--------|------|
| 1 — Site profile | `config.lookupDomainProfile(host)` injected by caller | Learned from prior runs, stored in `domain_profiles` table | Free |
| 2 — Pattern match | Always (fallback) | URL path, PDF metadata title, anchor text, detected language | Free |
| 3 — Haiku inference | Confidence < 0.75 and `config.apiKey` set | All metadata signals combined in structured prompt | ~$0.0003 |

### `ctx.domain` shape

```js
{
  subject: 'religious-texts',    // top-level bucket or 'general'
  subdomains: ['bahai', 'persian', '19th-century'],
  era: '1844-1921',
  script_context: 'Mixed Latin and Persian script',
  confidence: 0.91,
  source: 'site_profile',        // which layer fired
  prompt_context: '...',         // 2-4 sentence expert briefing injected into LLM prompts
}
```

### Caller-supplied domain

Pre-populate `ctx.domain` before calling `runPipeline` to skip detection entirely:

```js
await runPipeline({
  docId: '...',
  sourcePath: '...',
  config: { ... },
  // Supply domain directly — detection is skipped
  domain: {
    subject: 'legal',
    subdomains: ['contracts', 'english-law'],
    prompt_context: 'This is a 19th-century English legal contract. OCR corrections should preserve archaic legal terminology such as "hereinafter", "whereas", "aforesaid".',
    confidence: 1.0,
    source: 'caller',
  }
});
```

Or disable detection entirely: `config.domainDetect: false`.

### How LLM stages use domain context

Every stage that calls an LLM wraps its system prompt with `buildSystemPrompt(stageInstructions, ctx)` from `index.js`. This prepends `ctx.domain.prompt_context` when present — no per-stage changes needed to benefit from domain context.

### Learning loop

After each completed run, `writeAnalytics()` updates `domain_profiles.avg_quality_gain` for the site host using an exponential moving average. Over time, high-doc-count profiles with strong `avg_quality_gain` become trusted (confidence promoted to 0.90+) and serve subsequent docs for free at layer 1, eliminating Haiku inference cost.

---

## Internal Analytics (Privacy-Safe)

The pipeline logs rich metrics internally without exposing document content. These analytics power iterative improvement decisions.

### Privacy contract

| Category | Logged | Not logged |
|----------|--------|------------|
| Document identity | Opaque `run_id` (SHA-256 hash, unrecoverable) | `doc_id`, source URL, file path, title |
| Errors | Classified error codes (`file_not_found`, `timeout`, `corrupted_input`) | Raw error messages (may contain paths) |
| Decisions | Decision code + first token of reason | Full reason strings (may contain values) |
| Domain | Subject, subdomains, confidence, source | Document text, excerpts longer than 200 chars |
| Site | Hostname only | Full URL, path |

### Analytics tables

| Table | Purpose |
|-------|---------|
| `pipeline_runs` | One row per doc: quality scores, costs, domain signals, stage list |
| `stage_metrics` | Per-stage: cost, tokens, quality delta, approach used |
| `page_confidence_metrics` | Per-page: word confidence distribution before/after |
| `decision_log` | Every routing decision: code + numeric value |
| `error_log` | Classified error events, recoverable flag |
| `domain_profiles` | Learned per-site domain context, accumulated quality gains |

### Key queries for pipeline improvement

```sql
-- Which stage contributes the most quality gain per dollar?
SELECT stage, AVG(quality_delta) as avg_gain,
       AVG(cost_usd) as avg_cost,
       AVG(cost_usd / NULLIF(quality_delta, 0)) as cost_per_point
FROM stage_metrics WHERE quality_delta > 0
GROUP BY stage ORDER BY avg_gain DESC;

-- Which sites benefit most from domain context?
SELECT site_host, doc_count, avg_quality_gain, confidence, source
FROM domain_profiles ORDER BY avg_quality_gain DESC;

-- Error frequency by type (identifies patterns to fix)
SELECT error_code, COUNT(*) as count, stage
FROM error_log GROUP BY error_code, stage ORDER BY count DESC;

-- Are docs of a given type improving over time?
SELECT DATE(ts) as day, doc_type, AVG(quality_gain) as avg_gain, COUNT(*) as runs
FROM pipeline_runs GROUP BY day, doc_type ORDER BY day DESC;
```

### Configuration

```js
await runPipeline({
  docId: '...',
  sourcePath: '...',
  config: {
    analyticsDbPath: '/data/pipeline-analytics.db',  // enables analytics
    lookupDomainProfile: async (host) => {           // inject DB lookup
      return db.prepare('SELECT * FROM domain_profiles WHERE site_host=?').get(host);
    },
  }
});
```

Analytics write failures are always silent — they never affect pipeline execution or the client receipt.
