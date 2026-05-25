# Pipeline Monitor State
last_tick: 2026-05-09T00:00:00Z
tick_number: 3
status: COMPLETE
current_task: LOOP STOPPED — user requested session restart

## Key Finding This Session
The actual s3-ocr.js being loaded by pipeline-server is:
  /tank/site2rag/app/src/pipeline/stages/s3-ocr.js  (1038 lines)
NOT:
  /tank/site2rag/app/src/pipeline/s3-ocr.js  (this was the wrong file)

All previous session's patches were applied to the WRONG file.

## Architecture (stages/s3-ocr.js)
- Pages: parallel (Promise.all at line 639)
- Blocks per page: parallel
- Engines per page: parallel (easyocr/paddle/doctr via Promise.all at line 897)
- runEngineBatch: single batch call per page per engine (no chunking)
- Decision format: `${engine.label}_p${page.pageNo}` → paddle_p1, paddle_p2, etc.

## What Still Needs Doing
1. Apply patches to the CORRECT file: /tank/site2rag/app/src/pipeline/stages/s3-ocr.js
   - Chunked runEngineBatch (split per-page crops into chunks hitting different pool instances)
   - Confidence filter (skip high-confidence crops from batch engines)
2. Patches to wrong file can be reverted or left (they don't run)
3. Current best timing: 159s for 5p English scan (target: <40s)
