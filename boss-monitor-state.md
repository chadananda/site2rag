# Boss Monitor State
last_tick: 2026-05-05T18:05:00Z
tick_number: 85
status: IN_PROGRESS
current_task: Pipeline-v2 first job in progress, monitoring completion
current_task_detail: |
  PIPELINE STATUS:
    First job (7ea5231c): mazandarani_tarikh_zuhur_haqq_3.pdf (461 pages, importance=1)
      s0-s3: done (s3 took 28.7 min for 461 pages, ~3.7s/page)
      s4: running as of 18:00:30 (stub — should be near-instant)
      s5-s8: pending
    Queue: BL done=0, pending=9526, proc=14; Ocean done=0, pending=11902, proc=4

  CHANGES DEPLOYED (v0.2.106):
    - /api/sites cached 30s (was 10s per request)
    - /api/docs/tabs fast endpoint for tab counts
    - Upgraded tab: shows processing+done, sorted processing-first then hardest
    - Admin Prioritize button: boosts site's pending queue to 1,000,000+ priority

  BOSS ROUTER: alive (last confirmed tick 82)

next_priority: Check for first job completion (done > 0). Verify s4-s8 run correctly.
project_dir: /Users/chad/Dropbox/Public/JS/Projects/site2rag
