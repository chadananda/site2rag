# SLP OCR Pipeline — Reference Documentation

Pipeline version 1.0 | Tower-NAS orchestrator + boss GPU worker

## Architecture Overview

```
site2rag (crawler)
    ↓ PDF URL
pipeline-server :49900  (Tower-NAS — Node.js, single-threaded)
    ↓ job queue (SQLite, FIFO by importance DESC)
    ↓ ctx.run(tool, args) → workerPool
boss node-agent :49910  (GPU machine — distributes to OCR services)
    ├── Tesseract (CPU, bundled)
    ├── torch-server :8091  (EasyOCR · docTR · Surya — ROCm GPU)
    ├── paddle-server :8092  (PaddleOCR — MIGraphX)
    └── kraken-server :8093  (Kraken HTR — CPU, OpenITI models)
```

Documents flow through stages s0→s8. Each stage gates the next: if quality is already above
threshold, expensive stages are skipped. Receipts + analytics written on completion.

---

## Stage Reference

### s0 — Baseline Assessment
**Input**: PDF file path
**Tools**: pdftoppm (thumbnail), gs (normalization probe), Haiku vision (optional)
**What it does**: Determines the document's starting quality and routing profile.
- Checks for existing text layer (text vs image PDF)
- Estimates page count, language, processing difficulty
- Computes composite_score (0–1) as baseline for gain measurement

**Quality metric**: composite_score = text_layer_weight × char_density + lang_confidence × 0.2
**Typical duration**: 1–3 s text PDFs; 3–8 s image PDFs
**Stress cases**: PDFs >200 pages; JPEG2000-compressed scans; unknown language

---

### s1 — Preprocessing
**Input**: Source PDF
**Tools**: pdftoppm (rasterize), unpaper (deskew), convert (normalize)
**What it does**: Per-page image normalization at 300 DPI.
Enhancement methods tried: otsu → sharpen → unsharp_mask → autocontrast → faded_boost
Best method selected by downstream block detection score.

**Quality metric**: Sets processing_difficulty flag (0=clean, 0.5=degraded, 1=handwritten)
**Typical duration**: 300–600 ms/page
**Stress cases**: Severely skewed pages (unpaper >30s); handwritten marginalia

---

### s2 — Page Classification
**Input**: Preprocessed page images
**Tools**: pdftoppm (150 DPI thumbnail), Haiku vision
**What it does**: Identifies region types per page (~$0.0002/page).
Region types: printed_text, printed_arabic, printed_persian, table, figure, handwritten, mixed
Sets lang per page; routes RTL pages to ara/fas/heb/urd engine set.

**Quality metric**: region_coverage fraction (routing only, not receipt)
**Typical duration**: 800–1200 ms/page
**Stress cases**: Mixed-script pages; handwritten annotations on printed pages

---

### s3 — Core OCR  ← main value stage
**Input**: Classified page images
**Tools**: Tesseract · EasyOCR · PaddleOCR · docTR · Kraken · Surya · Haiku synthesis

Engine dispatch matrix (per detected lang):

| Engine    | Latin | Arabic/Persian/Urdu | Hebrew | CJK |
|-----------|-------|---------------------|--------|-----|
| Tesseract | ✓     | ✓                   | ✓      | ✓   |
| EasyOCR   | —     | ✓                   | ✓      | —   |
| PaddleOCR | ✓     | —                   | —      | ✓   |
| docTR     | ✓     | —                   | —      | —   |
| Kraken    | ✓     | ✓ (OpenITI)         | —      | —   |
| Surya     | escalation | escalation     | —      | —   |

Kraken model routing (auto, confidence-based per crop):
- ara → arabic_best.mlmodel (OpenITI Naskh)
- fas → DUAL MODEL: persian_best vs urdu_best, winner = higher avg character confidence
- urd → urdu_best.mlmodel (Nastaliq)
- ota → ottoman_best.mlmodel
- Latin → CATMuS-Print-Tiny (historical European printed text)

Layout detection cascade (tries each if prior returns 0 blocks):
1. Raw page at 150 DPI
2. otsu enhanced
3. PaddleOCR layout detection
4. Surya layout detection
5. Full-page fallback

Synthesis: Haiku receives Tesseract word anchors + batch engine context.
Concurrency: D_SYNTH_CONC = 8 parallel Haiku calls
Cost: ~$0.01/page block

**Quality metric**: mean_word_confidence (Tesseract 0–100, normalized), filtered by cleanRatio
**Typical duration**: 8–15 s/page (Latin); 12–20 s/page (Arabic/Persian)
**Stress cases**: Multi-column newspapers; >20 blocks/page (synthesis queue starvation)

---

### s4 — Escalation (Dirty-Page Re-OCR)
**Input**: Pages where mean_word_confidence < dirty_threshold
**Tools**: pdftoppm (600 DPI), Tesseract, Haiku synthesis
**What it does**: Re-processes dirty pages at 2× resolution.
Keeps 600 DPI result only if confidence_delta improves above threshold.

**Quality metric**: confidence_delta = mean_conf(600dpi) - mean_conf(300dpi)
**Typical duration**: 3–8 s/page × dirty pages only
**Stress cases**: >50% dirty pages; very faded ink (delta stays negative)

---

### s5 — Vision Escalation
**Input**: Pages below visionQualityGate (default 1.0 = all scanned pages)
**Tools**: Surya (local GPU), batch OCR engines (high DPI), cloud vision (Azure/Google/Claude)

Escalation ladder:
  difficulty >= 0.5 (handwritten/degraded) → cloud vision regardless of importance
  importance >= cloudVision (default 3)    → cloud vision
  importance >= localVision (default 1)    → Surya + batch engines only

**Quality metric**: vision_coverage = vision_pages / total_pages; LaTeX penalty if math
**Typical duration**: 8–30 s/page
**Cost**: Surya ~$0.01/page; cloud vision $0.10–$0.20/page
**Hard stop**: withinBudget(ctx, 2000) — halts if maxTokenBudget exhausted (default: null = unlimited)
**Stress cases**: Handwritten Arabic/Persian (100% cloud escalation); importance=5 docs with any degradation

---

### s6 — Spell Correction
**Input**: Per-word confidence scores from s3/s4/s5
**Tools**: Haiku (fuzzy-band words only)
**What it does**: Targeted correction of words in confidence fuzzy band.
Retroactively adjusts prior stage quality: prior_score × (1 - correction_rate)

**Quality metric**: correction_rate = corrected_words / total_words
**Typical duration**: 1–3 s/page
**Stress cases**: Uniformly mid-confidence output (degraded prints)

---

### s7 — Archive Build
**Input**: Per-page word positions + corrected text
**Tools**: ocrmypdf (PDF/A embedding), gs (compression)
**What it does**: Embeds corrected searchable text layer into original PDF.
**Typical duration**: 2–5 s total
**Stress cases**: Conflicting embedded fonts

---

### s8 — Markdown Export
**Input**: Per-page word bboxes + vision transcriptions
**What it does**: Assembles final markdown from bbox positions + vision drafts.
**Quality metric**: clean_word_pct + vision_pages × 0.1 bonus (final receipt score)
**Typical duration**: 500 ms–1 s/page

---

## Receipt Structure

Written to {archival_pdf}_receipt.json and pipeline-jobs.db after every run.

```json
{
  "quality": {
    "baseline": 0.12,
    "per_stage": { "s0": 0.12, "s3": 0.71, "s4": 0.79, "s5": 0.88, "s6": 0.90, "s8": 0.91 },
    "final": 0.91,
    "gain": 0.79,
    "cost_per_quality_point": 0.019
  },
  "stages": [
    { "stage": "s3", "duration_ms": 142000, "pages_affected": 18,
      "tokens_in": 12400, "tokens_out": 890, "cost_usd": 0.031 }
  ],
  "decisions": [
    { "stage": "s3", "decision": "layout_cascade", "reason": "raw detected 0 blocks; retried otsu" }
  ],
  "errors": [],
  "totals": { "cost_usd": 0.21, "tokens_in": 45000, "tokens_out": 3200, "duration_ms": 310000 }
}
```

---

## Analytics Queries (pipeline-jobs.db)

```sql
-- Quality gain by language
SELECT lang, AVG(final_score - baseline_score) as avg_gain, AVG(cost_usd) as avg_cost
FROM pipeline_runs GROUP BY lang;

-- Stage cost breakdown
SELECT stage, AVG(cost_usd), AVG(duration_ms), AVG(pages_affected)
FROM stage_metrics GROUP BY stage ORDER BY AVG(cost_usd) DESC;

-- Vision escalation rate
SELECT COUNT(*) FILTER (WHERE stage='s5') * 1.0 / COUNT(DISTINCT run_id) as vision_rate
FROM stage_metrics;

-- Layout cascade frequency (column-heavy docs)
SELECT decision, COUNT(*) FROM decision_log
WHERE stage='s3' GROUP BY decision ORDER BY COUNT(*) DESC;
```

---

## Tuning Constants

| Constant | Default | Effect |
|----------|---------|--------|
| D_LAYOUT_DPI | 150 | Layout detection DPI |
| D_SURYA_CHUNK | 20 | Max crops per Surya GPU call |
| D_SYNTH_CONC | 8 | Concurrent Haiku synthesis calls |
| visionQualityGate | 1.0 | s5 trigger threshold |
| maxTokenBudget | null | Global LLM token cap (null = unlimited) |
| escalation.cloudVision | 3 | Min importance for cloud APIs |
| escalation.suryaVision | 2 | Min importance for Surya in s5 |
