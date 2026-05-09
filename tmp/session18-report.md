# Session 18: Distributed OCR Diagnostic Report
Generated: 2026-05-08T19:45:14.087Z

## Summary
- Docs tested: 8 (8 ok, 0 failed)
- Avg gain: 40.6%  Total cost: $0.0101  Avg time: 53s

## 1. Worker Load Distribution
- surya_ocr@boss: 4 calls
- LOCAL_FALLBACK: 2 calls

## 2. Stage Bottlenecks (avg ms)
- s5: 43978ms avg
- s4: 42700ms avg
- s1: 9280ms avg
- s3: 7000ms avg
- s7: 3832ms avg
- s0: 2673ms avg
- s2: 1801ms avg
- s6: 931ms avg

## 3. Quality by Language
- unknown (n=3): avg final=1.000 avg gain=+1.000
- arabic (n=2): avg final=0.600 avg gain=+0.000
- english (n=3): avg final=0.897 avg gain=+0.083

## 4. Per-Document Results
### inba-v095-toc (1pp Arabic TOC)
baseline=0.000 → final=1.000 (+1.000) cost=$0.0007 time=61s pages=1
chain: s0(0.000) → s1(?) → s2(?) → s3(0.044+0.044 [fas]) → s4(?) → s5(1.000+1.000) → s6(1.000) → s7(? [method:ocrmypdf-pdfa3]) → s8(1.000+1.000 [bbox_words:1p])
routing:  routing surya_ocr → boss (cpu=3.7%) |  routing surya_ocr → boss (cpu=3.7%)

### inba-v073-toc (1pp Arabic TOC)
baseline=0.000 → final=1.000 (+1.000) cost=$0.0008 time=139s pages=1
chain: s0(0.000) → s1(?) → s2(?) → s3(0.000 [fas]) → s4(?) → s5(1.000+1.000) → s6(1.000) → s7(? [method:ocrmypdf-pdfa3]) → s8(1.000+1.000 [bbox_words:1p])
routing:  no available worker for surya_ocr, running locally |  no available worker for surya_ocr, running locally

### bab-inba-060 (1pp Arabic index)
baseline=0.600 → final=0.600 (+0.000) cost=$0.0015 time=6s pages=1
chain: s0(0.600 [text_layer_skip: no OCR needed]) → s6(?) → s7(? [method:ocrmypdf-pdfa3]) → s8(? [no_words_from_s3])

### bab-inba-043 (1pp Arabic index)
baseline=0.600 → final=0.600 (+0.000) cost=$0.0014 time=10s pages=1
chain: s0(0.600 [text_layer_skip: no OCR needed]) → s6(?) → s7(? [method:ocrmypdf-pdfa3]) → s8(? [no_words_from_s3])

### inba-v011-toc (3pp landscape Persian)
baseline=0.000 → final=1.000 (+1.000) cost=$0.0012 time=136s pages=3
chain: s0(0.000) → s1(?) → s2(?) → s3(0.000 [fas, ara]) → s4(?) → s5(1.000+1.000) → s6(1.000) → s7(? [method:ocrmypdf-pdfa3]) → s8(1.000+1.000 [bbox_words:3p])
routing:  routing surya_ocr → boss (cpu=5%) |  routing surya_ocr → boss (cpu=5%)

### uk-journal-9 (English journal ~5pp)
baseline=0.940 → final=0.940 (+0.000) cost=$0.0010 time=9s pages=3
chain: s0(0.940 [early_exit: doc already good enough; tex]) → s6(?) → s7(? [method:ocrmypdf-pdfa3]) → s8(? [no_words_from_s3])

### uk-journal-12 (English journal ~5pp)
baseline=0.550 → final=0.800 (+0.250) cost=$0.0027 time=55s pages=4
chain: s0(0.550) → s1(?) → s2(?) → s3(0.697+0.147 [eng]) → s6(0.706+0.009) → s7(? [method:ocrmypdf-pdfa3]) → s8(0.800+0.250 [bbox_words:4p])

### monajjem-help (Unknown script, small)
baseline=0.950 → final=0.950 (+0.000) cost=$0.0010 time=7s pages=5
chain: s0(0.950 [early_exit: doc already good enough; tex]) → s6(?) → s7(? [method:ocrmypdf-pdfa3]) → s8(? [no_words_from_s3])

## 5. Pipeline Analysis
### Optimization Opportunities
(See per-doc timings above — stages with avg >5s are candidates)

### Is This the Best OCR Pipeline Ever Built?
Strengths:
- Multi-engine cascade: Tesseract → Surya → Boss vision → Azure/Google/Claude
- Language-adaptive: auto-detects script, routes to appropriate OCR engine
- Quality-gated early exit: cheap baseline check avoids processing good docs
- Distributed: surya routed to GPU workers; fallback to local if all busy
- Cost-controlled: cloud LLM only when local pipeline can't get clean result

Weaknesses to investigate (from this session):
- Timeout race condition (tool-runner 5s vs /workers response time with dead nodes) — FIXED
- Worker health TTL (60s) may be too long if a node goes down mid-batch
- No feedback loop: pipeline doesn't tell the upgrader which docs need re-try with diff config
- surya on Arabic: results pending from this session