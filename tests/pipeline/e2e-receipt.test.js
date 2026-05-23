// End-to-end test: submit a real image PDF, poll until done, verify status
// progression and receipt shape.  Uses the per-image-printed.pdf fixture
// (Persian printed scan — no text layer, exercises full s0→s8 path).
//
// Run individually: npx vitest run tests/pipeline/e2e-receipt.test.js
// Requires the full OCR toolstack (tesseract, easyocr, paddle, gs, etc.).
// Mark as slow — can take 60–120 s depending on hardware.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { startPipelineServer } from '../../src/pipeline/server.js';
import { makeTempDir } from './helpers.js';

// Skip the whole suite if the Python OCR stack isn't installed
const missingPython = ['easyocr', 'paddle', 'doctr'].filter(m => {
  try { execSync(`python3 -c "import ${m}"`, { stdio: 'pipe' }); return false; } catch { return true; }
});
const SKIP_REASON = missingPython.length
  ? `Python OCR modules missing: ${missingPython.join(', ')} — run on tower-nas`
  : null;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PDF = resolve(__dirname, '../fixtures/pdfs/per-image-printed.pdf');
const POLL_MS      = 2_000;
const HARD_CEILING = 600_000; // 10 min absolute maximum
const STALL_MS     = 90_000;  // fail if no progress change for 90s

let service, tempDir, cleanup, PORT;

// Shared state — populated once in beforeAll, read by all tests
let snapshots = [];
let receipt = null;
let finalJob = null;

/**
 * Poll GET /jobs/:id until done or failed.
 * Distinguishes between slow-but-progressing jobs (OK) and stalled jobs (fail).
 * A "stall" is when neither progress.stage nor progress.pages_done changes for STALL_MS.
 */
async function pollUntilDone(jobId) {
  const snaps = [];
  const hardDeadline  = Date.now() + HARD_CEILING;
  let lastProgressAt  = Date.now();
  let lastStage       = null;
  let lastPagesDone   = -1;

  while (Date.now() < hardDeadline) {
    const res  = await api(`/jobs/${jobId}`);
    const body = await res.json();
    snaps.push({ ts: Date.now(), ...body });

    if (body.status === 'done' || body.status === 'failed') return snaps;

    const stage     = body.progress?.stage ?? null;
    const pagesDone = body.progress?.pages_done ?? -1;

    if (stage !== lastStage || pagesDone > lastPagesDone) {
      lastProgressAt = Date.now();
      lastStage      = stage;
      lastPagesDone  = pagesDone;
    }

    if (Date.now() - lastProgressAt > STALL_MS) {
      throw new Error(
        `Job ${jobId} stalled — no progress for ${STALL_MS / 1000}s ` +
        `(stage=${stage}, pages_done=${pagesDone})`
      );
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`Job ${jobId} exceeded hard ceiling of ${HARD_CEILING / 1000}s`);
}

beforeAll(async () => {
  ({ dir: tempDir, cleanup } = makeTempDir());
  service = await startPipelineServer({
    port: 0,
    dbPath: join(tempDir, 'jobs.db'),
    concurrency: 1,
  });
  PORT = service.server.address().port;

  if (!existsSync(FIXTURE_PDF)) return; // fixture-missing test will catch this

  const res = await post('/jobs', {
    pdfPath: FIXTURE_PDF,
    sourceUrl: 'https://example.com/per-image-printed.pdf',
    importance: 2,
  });
  if (res.status !== 202) return;
  const { jobId } = await res.json();

  try {
    snapshots = await pollUntilDone(jobId);
  } catch {
    // timeout — leave snapshots empty; tests will fail with useful messages
    return;
  }
  finalJob  = snapshots.at(-1);

  if (finalJob?.status === 'done') {
    const rRes = await api(`/jobs/${jobId}/receipt`);
    if (rRes.status === 200) receipt = await rRes.json();
  }
}, HARD_CEILING + 10_000);

afterAll(async () => {
  await service?.close();
  cleanup?.();
});

const api = (path, opts = {}) =>
  fetch(`http://localhost:${PORT}${path}`, { headers: { Connection: 'close' }, ...opts });
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify(body),
});

describe.skipIf(SKIP_REASON)(`E2E: image PDF through full pipeline${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ''}`, () => {
  it('fixture PDF exists', () => {
    expect(existsSync(FIXTURE_PDF), `fixture not found: ${FIXTURE_PDF}`).toBe(true);
  });

  it('job completes with status=done', () => {
    expect(finalJob, 'job never completed — check pipeline tools').toBeTruthy();
    expect(finalJob.status).toBe('done');
  });

  it('progress snapshots include stage names in the expected s0→s8 sequence', () => {
    const stagesSeen = [];
    for (const snap of snapshots) {
      const stage = snap.progress?.stage;
      if (stage && stagesSeen.at(-1) !== stage) stagesSeen.push(stage);
    }
    expect(stagesSeen).toContain('s0');
    expect(stagesSeen).toContain('s8');

    const STAGE_ORDER = ['s0','s1','s2','s3','s4','s5','s6','s7','s8'];
    let lastIdx = -1;
    for (const s of stagesSeen) {
      const idx = STAGE_ORDER.indexOf(s);
      if (idx !== -1) {
        expect(idx, `stage ${s} appeared out of order`).toBeGreaterThanOrEqual(lastIdx);
        lastIdx = idx;
      }
    }
  });

  it('progress.pages_done increments monotonically within a stage', () => {
    const byStage = {};
    for (const snap of snapshots) {
      const { stage, pages_done } = snap.progress ?? {};
      if (!stage || pages_done == null) continue;
      if (!byStage[stage]) byStage[stage] = [];
      byStage[stage].push(pages_done);
    }
    for (const [stage, counts] of Object.entries(byStage)) {
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i], `pages_done decreased in ${stage}`).toBeGreaterThanOrEqual(counts[i - 1]);
      }
    }
  });

  it('receipt from GET /jobs/:id/receipt has required top-level fields', () => {
    expect(receipt, 'receipt fetch failed').not.toBeNull();
    expect(receipt).toMatchObject({
      doc_id:           expect.any(String),
      pipeline_version: expect.any(String),
      page_count:       expect.any(Number),
      source_url:       'https://example.com/per-image-printed.pdf',
      quality: expect.objectContaining({
        baseline: expect.objectContaining({ composite_score: expect.any(Number) }),
        per_stage: expect.any(Object),
        final:    expect.any(Number),
        gain:     expect.any(Number),
      }),
      stages:    expect.any(Array),
      decisions: expect.any(Array),
      totals: expect.objectContaining({
        cost_usd:    expect.any(Number),
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('receipt.stages has a record for each stage that ran, with duration_ms', () => {
    expect(receipt).not.toBeNull();
    const s0 = receipt.stages.find(s => s.stage === 's0');
    expect(s0).toBeDefined();
    expect(s0.duration_ms).toBeGreaterThanOrEqual(0);

    const s8 = receipt.stages.find(s => s.stage === 's8');
    expect(s8).toBeDefined();

    for (const stage of receipt.stages) {
      expect(stage).toMatchObject({
        stage:          expect.stringMatching(/^s[0-8]$/),
        pages_affected: expect.any(Number),
        duration_ms:    expect.any(Number),
      });
    }
  });

  it('receipt.quality.per_stage has a score entry for s0 (baseline)', () => {
    expect(receipt).not.toBeNull();
    expect(typeof receipt.quality.per_stage.s0).toBe('number');
    expect(receipt.quality.per_stage.s0).toBeGreaterThanOrEqual(0);
    expect(receipt.quality.per_stage.s0).toBeLessThanOrEqual(1);
  });

  it('receipt.decisions is non-empty; s3 must log block/engine decisions', () => {
    expect(receipt).not.toBeNull();
    expect(receipt.decisions.length).toBeGreaterThan(0);

    for (const d of receipt.decisions) {
      expect(d).toMatchObject({
        stage:    expect.stringMatching(/^s[0-8]$/),
        decision: expect.any(String),
      });
    }

    const s3Decisions = receipt.decisions.filter(d => d.stage === 's3');
    expect(s3Decisions.length).toBeGreaterThan(0);
  });

  it('receipt.quality.final is higher than baseline for an image PDF', () => {
    expect(receipt).not.toBeNull();
    const baseline = receipt.quality.baseline?.composite_score ?? 0;
    expect(receipt.quality.final).toBeGreaterThan(baseline);
  });

  it('GET /jobs/:id returns has_pdf=true and has_markdown=true after done', () => {
    expect(finalJob).toBeTruthy();
    expect(finalJob.has_pdf).toBe(true);
    expect(finalJob.has_markdown).toBe(true);
  });
});
