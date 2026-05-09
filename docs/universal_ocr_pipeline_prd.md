# Universal OCR Orchestration Pipeline PRD

## Overview

This product defines a local-first, policy-driven OCR orchestration system for multilingual, archival, and technically complex image PDFs. The system should maximize low-cost CPU preprocessing and open-source OCR while using AI selectively for routing, synthesis, and escalation on difficult blocks and pages.[cite:19][cite:20][cite:26]

The product goal is not to choose one OCR engine, but to build an adaptive execution layer that diagnoses each page and block, chooses an appropriate preprocessing and OCR strategy, compares competing outputs, and escalates only when cheaper local methods fail.[cite:20][cite:25][cite:26]

## Product Goals

- Build a universal OCR pipeline that can process image PDFs containing printed text, handwriting, tables, equations, marginalia, and mixed scripts.[cite:14][cite:15][cite:26]
- Prioritize local processing, especially CPU-friendly diagnostics, preprocessing, and baseline OCR, to minimize cost and maximize throughput.[cite:19][cite:22]
- Use AI as a sparse expert layer for document classification, issue detection, strategy recommendation, output synthesis, and expensive fallback OCR.[cite:16][cite:20]
- Preserve archival fidelity by retaining provenance, confidence, and preprocessing metadata for every block and every chosen output.[cite:20][cite:25]
- Produce outputs suitable for search, review, reprocessing, and downstream ingestion, including searchable PDF, structured JSON, and OCR alignment metadata.[cite:19][cite:25]

## Non-Goals

- Replacing all OCR engines with a single end-to-end large vision model.[cite:16][cite:26]
- Applying the same preprocessing stack uniformly to every page regardless of content or degradation.[cite:19][cite:20]
- Trusting one engine's confidence score as the sole signal of OCR quality.[cite:20][cite:23]
- Flattening structured content such as tables or equations too early in the pipeline.[cite:14][cite:15]

## Problem Statement

Traditional OCR pipelines are too static for real-world archival and multilingual corpora. A single engine and a single preprocessing recipe perform poorly across mixed document types such as newspapers, books, reports, forms, technical documents, handwriting, and degraded scans.[cite:14][cite:15][cite:26]

Historical and multilingual corpora introduce additional variability: skew, bleed-through, uneven backgrounds, weak contrast, broken glyphs, script mixing, tabular structure, equations, and handwriting. Recent benchmarking and OCR quality work show that difficult layouts, Arabic handwriting, and structured content remain especially challenging, and that model disagreement can be an important quality signal.[cite:15][cite:20]

## Users and Use Cases

Primary users are engineers, archivists, researchers, digital humanities teams, and developers building OCR infrastructure for large corpora. These users need reproducible, inspectable pipelines that can be tuned per corpus rather than opaque black-box OCR.[cite:20][cite:23]

Representative use cases include:

- 19th century newspapers with bleed-through, broken columns, irregular headlines, and marginal notes.[cite:15][cite:23]
- English, Spanish, and German printed reports with mixed scan quality and occasional tables.[cite:14][cite:26]
- 20th century technical reports with equations, tables, diagrams, and multi-column layouts where structure preservation matters.[cite:14][cite:15]
- Multilingual archival collections that mix printed Latin text with handwritten annotations or non-Latin scripts.[cite:15][cite:26]

## Product Principles

- Local-first execution: cheap sensing and preprocessing should happen before expensive model invocation.[cite:19][cite:20]
- Policy over monolith: routing decisions should be made by explicit policy and lightweight learned models, not unrestricted agentic reasoning.[cite:20][cite:26]
- Evidence-based escalation: expensive models should run only when quality signals indicate that local strategies are insufficient.[cite:16][cite:20]
- Full provenance: every block result should retain engine, preprocessing, confidence, and selection rationale.[cite:20][cite:25]
- Structure preservation: layout, reading order, tables, and equations should remain first-class outputs rather than post hoc recovery tasks.[cite:14][cite:15]

## Functional Requirements

### 1. Ingest and normalization

The system must ingest image PDFs and mixed PDFs, detect whether existing digital text is present, and decide whether to skip, redo, or force OCR. OCRmyPDF documents support for skip, redo, and force-style workflows as part of advanced OCR control, which makes it a strong PDF wrapper layer.[cite:19][cite:25][cite:27]

The system must rasterize pages at configurable resolution, preserve original page geometry, and store intermediate render artifacts when debug mode is enabled. It must support page-level normalization operations such as autorotation, deskew, background removal, and cleaning, but these must remain policy-controlled rather than mandatory defaults.[cite:19][cite:22][cite:25]

### 2. Page diagnostics

Before OCR, the system must compute cheap page-level diagnostics to inform routing. At minimum this includes page orientation, skew angle, blur, contrast, color mode, noise level, image size, and basic text density estimates.[cite:19][cite:20]

The system should also estimate document archetype at the page level, such as book page, newspaper page, form, report, technical page, handwritten note, or mixed-content page. This estimate is used only for routing and policy selection and does not need to be perfect.[cite:14][cite:26]

### 3. Layout segmentation

The system must segment pages into logical blocks before block-level OCR. Blocks may include paragraph text, headings, tables, equations, captions, handwritten notes, footnotes, marginalia, and figures.[cite:14][cite:15]

The segmentation stage must preserve coordinates, page order, and reading-order candidates. For technical and historical material, the system should be able to represent uncertainty in reading order instead of assuming a single deterministic flow too early.[cite:14][cite:15]

### 4. Block diagnostics and routing features

For each block, the system must compute routing features including likely script, likely language, printed versus handwritten classification, block type, image-quality metrics, and estimated OCR difficulty. A lightweight learned classifier may be used here if it improves over fixed heuristics for issue detection and block typing.[cite:15][cite:20]

Required block-level issue signals include skew, low contrast, uneven illumination, background texture, speckle noise, blur, stroke breakage, component fragmentation, and probable bleed-through. These signals are used to select candidate preprocessing strategies.[cite:19][cite:20][cite:23]

### 5. Strategy generation

The system must generate one or more candidate strategies per block. A strategy consists of preprocessing recipe, OCR engine set, execution order, expected cost tier, and acceptance threshold.[cite:20][cite:26]

The strategy generator should primarily be driven by deterministic rules and lightweight classifiers. An LLM may optionally propose a strategy for novel or ambiguous blocks, but it must work from structured features and remain bounded by allowed engines, transforms, and budget limits.[cite:16][cite:20]

### 6. Preprocessing policies

The system must support conditional preprocessing, including but not limited to deskew, denoise, despeckle, contrast normalization, adaptive thresholding, grayscale preservation, background removal, and selective sharpening. OCRmyPDF's advanced documentation confirms support for deskew, clean, and remove-background style operations, reinforcing these as practical baseline transformations.[cite:19][cite:25][cite:27]

Preprocessing must be configurable at page or block scope. The pipeline must also support branching experiments where two or more preprocessing paths are tried in parallel for uncertain blocks, with downstream scoring used to pick the best result.[cite:20][cite:25]

### 7. OCR engine orchestration

The system must support multiple open-source OCR engines and choose among them by block type. Candidate baseline engines include Tesseract, PaddleOCR, EasyOCR, and corpus-specific specialists such as historical OCR stacks where needed.[cite:14][cite:26]

For clean printed English or other well-supported printed Latin blocks, the pipeline should be able to run a multi-engine ensemble and compare outputs. For handwriting, Arabic, structured technical blocks, or low-quality regions, the pipeline should use a narrower specialist set or escalate directly to structure-aware and vision-language OCR as policy dictates.[cite:14][cite:15][cite:16]

### 8. Output scoring and quality judgment

The system must score OCR candidates using more than raw engine confidence. Scoring must combine engine confidence, confidence variance, language plausibility, inter-engine agreement entropy, structural validity, and block-type-specific heuristics.[cite:20][cite:23]

Consensus disagreement must be treated as a first-class signal. Research on OCR quality assessment indicates that disagreement across models can reveal risk even when individual systems provide confident outputs.[cite:20]

### 9. Acceptance, retry, branching, and escalation

Each block must end in one of four control states:

- Accept: candidate quality exceeds the configured threshold.[cite:20]
- Retry: the same or similar engines should rerun with a different preprocessing recipe.[cite:20][cite:25]
- Branch: the block should test two or more candidate strategies in parallel and compare outcomes.[cite:20]
- Escalate: the block should route to more expensive structure-aware or vision-language models, or to human review when required.[cite:16][cite:20]

Escalation must be budget-aware and value-aware. High-value low-confidence blocks in structured or handwritten content should escalate sooner than low-value boilerplate content.[cite:16][cite:20]

### 10. Synthesis and fusion

The system must preserve raw OCR outputs from every engine and then produce a canonical fused result. Fusion should align candidate strings, normalize conservatively, vote where engines agree, and prefer higher-quality candidates when outputs diverge.[cite:20][cite:23]

For structured content such as tables and equations, fusion must operate on structural units such as cells, rows, or equation blocks rather than flattening the content into prose. Benchmarks and model comparisons show that structured content remains a major weakness for generic OCR systems, so structural integrity must be preserved throughout selection and fusion.[cite:14][cite:15]

### 11. Output formats

The system must emit at least the following outputs:

- Searchable PDF or PDF/A suitable for archival workflows.[cite:19][cite:25]
- Structured JSON for page, block, line, token, and provenance metadata.[cite:20][cite:25]
- Optional hOCR, ALTO XML, or equivalent layout-preserving export.[cite:25]
- Review manifests containing block confidence, disagreement metrics, and escalation history.[cite:20][cite:23]

## System Architecture

The system should be implemented as a modular orchestration platform rather than a single script. Recommended top-level services are listed below.

| Module | Responsibility | Key notes |
|---|---|---|
| Ingestor | Open PDF, rasterize pages, inspect existing text layer | Supports skip/redo/force OCR behaviors.[cite:19][cite:25] |
| Diagnostics | Compute page and block quality metrics | Includes skew, blur, contrast, noise, density, and degradation signals.[cite:19][cite:20][cite:23] |
| Segmenter | Detect and label blocks, reading order candidates, and structures | Must preserve coordinates and uncertainty where needed.[cite:14][cite:15] |
| Router | Choose preprocessing and engine sets | Primarily rules plus lightweight learned classifiers.[cite:20][cite:26] |
| OCR Workers | Run local OCR engines in parallel | Baseline open-source engines plus specialists.[cite:14][cite:26] |
| Judge | Score, compare, and rank candidate outputs | Uses confidence, entropy, plausibility, and structural checks.[cite:20][cite:23] |
| Escalator | Invoke higher-cost vision models or human review | Budget-aware and threshold-driven.[cite:16][cite:20] |
| Synthesizer | Produce canonical block and page outputs | Keeps provenance and unresolved spans.[cite:20] |
| Publisher | Write searchable PDFs and structured exports | Should support archival and reprocessing needs.[cite:19][cite:25] |

## Routing Policy Design

The routing system should use structured features rather than unconstrained natural-language prompts. Each page and block should be represented as a typed record containing layout class, script probabilities, language probabilities, handwriting score, quality metrics, degradation flags, estimated value, and remaining cost budget.[cite:20][cite:26]

Policy output should be explicit and machine-readable. A route decision must include selected preprocessors, OCR engines, branch count, score thresholds, and escalation triggers.[cite:20]

Illustrative routing rules:

- Clean printed Latin paragraph: run multi-engine local ensemble, then fuse by agreement and confidence.[cite:14][cite:26]
- Historical degraded print with heavy skew or bleed-through: try a small number of preprocessing branches before expensive escalation.[cite:19][cite:23]
- Handwritten Arabic or similarly specialized content: skip generic ensemble paths that are unlikely to help and route directly to the best specialist subset and, if needed, escalation.[cite:15]
- Table or equation-heavy technical block: preserve structure and favor structure-aware OCR or vision-language fallback earlier.[cite:14][cite:15]

## AI Usage Model

AI should be used in four places only when deterministic methods are insufficient:

1. Lightweight block typing and issue classification.[cite:20]
2. Strategy suggestion for ambiguous or novel blocks using structured features and strict action bounds.[cite:16][cite:20]
3. High-cost OCR escalation for hard blocks, structured pages, and handwriting that fails cheaper methods.[cite:14][cite:16]
4. Controlled synthesis or reconciliation of close OCR alternatives under visible diffing and provenance retention.[cite:16][cite:20]

Large language models must not silently rewrite OCR outputs without traceability. Historical OCR evaluation indicates that LLMs can be inconsistent and may hallucinate, especially on difficult or non-standard documents, so all generative steps require constraint, scoring, and auditability.[cite:16]

## Data Model Requirements

Each block record should store:

- Page ID and block ID
- Bounding box and reading-order candidates
- Block type and script/language probabilities
- Preprocessing variants attempted
- OCR engine outputs with confidences
- Candidate quality scores and disagreement metrics
- Chosen canonical output and rationale
- Escalation history
- Reviewer overrides and corrected text when available

This data model is required both for runtime decisions and for future learning loops, corpus tuning, and regression testing.[cite:20][cite:23]

## Learning and Optimization

The product should support offline evaluation and online policy improvement. Over time, the system should learn which preprocessing and OCR strategies work best for each feature pattern instead of keeping fixed heuristics forever.[cite:20][cite:26]

A contextual bandit or similar bounded experimentation framework is a good fit for uncertain routing. It can choose among a small number of candidate strategies, observe quality outcomes, and improve future selection without turning the entire pipeline into an opaque agentic system.[cite:20]

Corrected outputs from human review should flow back into evaluation sets and corpus-specific tuning. This is especially important for historical or specialized corpora, where generic OCR models often underperform without adaptation.[cite:15][cite:23]

## Observability and Debugging

The system must expose rich diagnostics for every page and block. OCRmyPDF documentation highlights debug and advanced controls, and the broader pipeline should extend that philosophy by storing intermediate images, selected strategies, score breakdowns, and escalation reasons.[cite:25][cite:27]

Minimum observability requirements:

- Per-page and per-block logs
- Intermediate artifact retention in debug mode
- Score decomposition by confidence, agreement, plausibility, and structure
- Comparison views across engine outputs
- Retry and escalation traces
- Exportable review queue for manual inspection

## Success Metrics

The product should measure success across quality, cost, speed, and transparency.

### Quality metrics

- Character error rate and word error rate on evaluation sets where ground truth exists.[cite:20][cite:23]
- Structural accuracy for tables, reading order, and equation block preservation.[cite:14][cite:15]
- Escalation precision, meaning the fraction of escalated blocks that genuinely benefited from more expensive processing.[cite:20]
- Review yield, meaning how often flagged low-confidence blocks are truly problematic.[cite:20][cite:23]

### Efficiency metrics

- Percentage of blocks resolved in local low-cost tiers.[cite:19][cite:20]
- Average cost per page and per accepted block after policy optimization.[cite:20]
- CPU and GPU time by document archetype and block class.[cite:20][cite:26]

### Trust and operability metrics

- Percentage of outputs with full provenance retained.[cite:20][cite:25]
- Regression stability across corpus updates and policy changes.[cite:20]
- Debug completeness for failed or escalated cases.[cite:25]

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Overuse of expensive vision models | Cost explosion and lower throughput | Gate escalation by confidence, disagreement, and value tiers.[cite:16][cite:20] |
| Over-aggressive preprocessing damages text | Lower OCR quality on some pages | Use policy-based conditional transforms and bounded branching instead of universal cleanup.[cite:19][cite:25] |
| Single-score quality judgment misses failures | Silent bad output | Combine confidence, agreement entropy, plausibility, and structural checks.[cite:20][cite:23] |
| LLM synthesis hallucinates text | Archival integrity risk | Keep raw candidates, constrain rewriting, require provenance and score-backed acceptance.[cite:16][cite:20] |
| Structured content gets flattened too early | Loss of tables and reading order | Preserve block structure and fuse at structural units.[cite:14][cite:15] |
| Corpus drift makes routing stale | Quality regressions over time | Add offline evaluation and contextual bandit or policy retraining loops.[cite:20][cite:26] |

## Rollout Plan

### Phase 1: Deterministic foundation

Implement ingest, diagnostics, segmentation, preprocessing, OCR worker orchestration, scoring, and structured output without any large-model decision layer. Use explicit routing rules and local ensemble OCR to establish a strong baseline.[cite:19][cite:20][cite:26]

### Phase 2: Lightweight learned routing

Add small learned classifiers for block typing, issue detection, and route priors. Keep all actions bounded by explicit policy and budget controls.[cite:20]

### Phase 3: Selective escalation

Integrate structure-aware OCR and higher-cost vision-language fallback for blocks that fail deterministic and low-cost ensemble paths. Track escalation precision and cost carefully.[cite:14][cite:16][cite:20]

### Phase 4: Learning loop

Add review feedback, offline evaluation datasets, and contextual routing optimization. Use observed results to reduce unnecessary branching and improve corpus-specific performance.[cite:15][cite:20][cite:23]

## Open Questions

- Which specialist historical and handwritten OCR engines should be included in the first production stack for the highest-value target corpora?[cite:15][cite:23]
- What score thresholds produce the best balance between false accepts, false escalations, and human review load?[cite:20]
- How should value tiers be assigned at the block level for different archival or technical workflows?[cite:20]
- Which structured export format should be the canonical ground truth for downstream search and reprocessing: JSON-first, ALTO-first, or dual export?[cite:25]
- What corpus-specific lexicons or language models should be incorporated for post-OCR plausibility scoring?[cite:20]

## Recommended Next Step

The next implementation artifact should be a technical design package that defines the block schema, routing DSL, score formulas, worker interface contract, and example policies for at least four block classes: clean printed Latin, degraded historical print, handwritten block, and technical table/equation block.[cite:20][cite:25][cite:26]
