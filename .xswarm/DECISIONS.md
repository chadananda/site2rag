# Decisions

_Append-only. Newest at the bottom. Format: date, decision, why,
what was rejected. Agents re-litigate settled questions when nothing records
that they were settled._

## SearchLayerPDF is the OCR; site2rag consumes it. Already true.
**Decided:** 2026-09-05 (Chad) · **Recorded:** 2026-09-05
SearchLayerPDF is the premium OCR product. site2rag is a client of it, not a
parallel implementation.

**Status check:** this is already implemented. `src/slp-client.js` is a live
client against the public API (`SLP_API_URL`, e.g. searchlayerpdf.com/v1),
wired into `bin/report-server.js`, deliberately with **no localhost fallback** —
an empty `SLP_API_URL` disables upgrade rather than reaching for a local
orchestrator. The `ocr_used` / `ocr_engines` columns record what SLP did; they
are not a second pipeline.

**Open:** whether the primary conversion path routes through SLP or only the
report path does. Worth one check before assuming full coverage.
**Rejected:** maintaining independent OCR in site2rag.
