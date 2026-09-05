<!-- PROPOSED by goal-propose.py. Inferred from repo evidence, not
     confirmed by Chad. Raise at the next planning meeting. -->

# Goal (PROPOSED)

## What this is for

site2rag exists so that one person — Chad, as operator — never has to hand-assemble the OceanLibrary corpus again. It serves two users. The direct user is the operator: adding a new institutional site should mean adding ten lines to `websites.yaml` and nothing else, ever. The indirect user is a researcher on OceanLibrary.com who searches a phrase and gets a hit inside page 214 of a 1978 scanned conference proceedings, with a link back to the original host's URL and a working copy if that host is gone. I inferred the researcher; the evidence names OceanLibrary and Meilisearch but never describes who queries them. I also inferred that the mirrored organizations themselves are beneficiaries via `{domain}.lnker.com` — a readable archive of sites that are one hosting-bill lapse from disappearing.

## What success looks like

The corpus is a pure function of `websites.yaml` plus time. Delete every derived artifact — SQLite, exports, S3 — and a re-run rebuilds a byte-equivalent corpus without a human making a single judgment call. The invariants in `prd.md` (URL → path deterministic, slug pure, mirror = archive) hold under audit, not just by intent. A new site goes from config line to indexed Markdown with no code change and no per-site special case. Chad's involvement drops to reading the report dashboard when something goes red, and the honest measure is months elapsed since the last manual intervention on an already-onboarded site.

## What would falsify this

Every PDF in the corpus has a text layer, `pdf_upgrade_queue` is empty, and OceanLibrary search *still* returns bad results — because the actual bottleneck was chunking, context disambiguation, and embedding quality, not missing text. The recent commits point at this already: `slp-context`, hosting-page context extraction via DeepSeek, "metadata from SLP frontmatter only, never guess title from OCR body." Those are not OCR-availability problems. They are *the text is present but semantically naked* problems. If the next six months of work keeps drifting toward supplying context to the OCR layer, then text extraction was the easy half and the goal above targets the wrong constraint.

Two cheaper falsifiers: if a full crawl cycle across all sites yields near-zero changed pages, this should be a one-shot ingest, not a long-running PM2 service. If the site list stays under ~20 domains and each still needs bespoke handling, a per-site script is cheaper than a pipeline and the abstraction is not paying for itself.

## Explicitly not the goal

Owning OCR. `CLAUDE.md` states site2rag owns none of it and calls SLP over HTTP, but the repo has not caught up: the README still documents an in-repo upgrade pipeline (`identify.js` / `reocr.js` / `rebuild.js`), `docs/universal_ocr_pipeline_prd.md` specifies an entire adaptive OCR orchestration layer, and a 5MB `eng.traineddata` sits in the project root. That PRD is SearchLayerPDF's job description, sitting in the wrong repo. **These two projects overlap and the boundary is currently only asserted, not enforced.** Either the PRD moves to SearchLayerPDF or site2rag is quietly re-absorbing the hard problem.

Also not the goal: semantic enrichment. `prd.md` is explicit — heavy LLM context work is downstream batch. The recent DeepSeek context-extraction commits are the leading edge of that line being crossed.

Also not the goal: becoming a general-purpose crawler. The value here is a curated, closed set of institutional archives with known licensing posture.

## Where I am guessing

- **That OceanLibrary is the only consumer.** If site2rag is meant to become a product other institutions run against their own archives, the whole goal inverts — multi-tenancy, isolation, and support burden dominate, and "Chad stops touching it" becomes irrelevant. The Cloudflare Pages dashboard, the tunnel, and the `lnker.com` domain all read like productization groundwork. This is my weakest inference and it changes the most.
- **What `lnker.com` is.** I treated it as a public preservation front-end. If it's an internal debug viewer, drop the archive-for-the-public framing entirely.
- **That mirroring is legally settled.** Republishing third-party institutional sites at `{domain}.lnker.com`, plus S3 copies of their PDFs, is redistribution. If permission is per-site rather than assumed, that constraint belongs in the goal, not in a footnote.
- **That the site list is closed and small.** "Add a line to `websites.yaml`" is only a success criterion if new sites are rare and similar. If the target is hundreds of heterogeneous domains, onboarding cost is the goal, not a side effect.
- **That the README's in-repo OCR pipeline is dead code.** I assumed `CLAUDE.md` is current and the README is stale. If the local path is a live fallback for when SLP is down, my "not the goal" section is wrong about the boundary.
- **That "Mirror = Archive" means system of record.** I read it as: site2rag is the durable preservation copy, not a cache. If S3 is just a convenience mirror and preservation lives elsewhere, the retention and 90-day-grace machinery is over-built for the actual goal.
- **That the OCR quality bar is already met.** I have no evidence about accuracy on Arabic/Persian scans — only that SLP claims to handle them. If accuracy is still bad, the goal should be about quality, not automation.
