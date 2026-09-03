# Bahai-Library Monitor State
last_tick: 2026-06-04T03:06:00Z
tick_number: 115
status: PAUSED — user doing major SLP-side work (requested pause)

## Current State at pause
done: 445 | failed: 107 (mostly INBA blocks) | submitted: 10

## WHY PAUSED
Root blocker identified: SLP auto-retries failed attempts under NEW job IDs that
site2rag (polling original job id) never sees; SLP ages out the good output
(md/receipt → 404) before retrieval. So docs produce real output, it's deleted,
doc looks failed. done flat ~5h. User is fixing SLP side. PAUSE monitoring.

## TO RESUME
1. Verify SLP work done (ask user / check completions resuming).
2. Full sweep + recover:
   cd /tank/site2rag/app && SITE2RAG_ROOT=/tank/site2rag node scripts/recover-slp-metadata.js --filter "error LIKE 'incomplete:%' AND url NOT LIKE '%/inba/%'"
   DELETE FROM pdf_upgrade_queue WHERE status='failed' AND (error IN ('no workers available','fetch failed','socket hang up','connect ECONNREFUSED 127.0.0.1:49900','job expired') OR error LIKE '%HTTP 408%' OR error LIKE '%HTTP 5%');
3. Resume 30-min monitoring cadence.

## STAGED (committed, UNPUSHED) — bundle into next deploy
"Handle transient SLP errors in poller path too; add 408/429" (isTransientErr in both paths).
NOTE: this alone does NOT fix the retry/age-out race — needs poll-by-hash in poller
(or SLP-side retention/retry fix, which user is now doing).

## Recovery tool: scripts/recover-slp-metadata.js (committed+deployed)

## Genuine unrecoverable: hartz, French journal scan pages, INBA handwritten.
## Deploy notes: deploy:all UI step BROKEN (build:css) → deploy:backend. ecosystem reload restarts marker-service; stale entries pipeline-server/pdf-upgrade-worker.

## Session wins
UI count fix · poller re-check · submit-path transient fix (DEPLOYED) · poller-path fix (staged) · ~300 docs recovered · recovery script · identified multi-attempt + retry/age-out race
