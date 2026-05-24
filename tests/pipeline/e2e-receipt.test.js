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

  // Progress stage assertions: jobs dispatched to a remote worker (boss) may complete
  // before the poll interval fires, leaving snapshots with no in-flight stage data.
  // Use receipt.stages as the authoritative stage record instead.

  it('receipt.stages shows s0 ran (and s8 for a successful run)', () => {
    expect(receipt, 'receipt fetch failed').not.toBeNull();
    const stageNames = receipt.stages.map(s => s.stage);
    expect(stageNames).toContain('s0');
    expect(stageNames).toContain('s8');
  });

  it('receipt.stages are in non-decreasing order (no backwards jumps)', () => {
    expect(receipt).not.toBeNull();
    // Stage names like s0, s1, s2, s2b, s3, s3b, s4 … s8 — sort by leading number + suffix
    const stageNum = s => { const m = s.match(/^s(\d+)([a-z]?)$/); return m ? parseInt(m[1]) * 100 + (m[2] ? m[2].charCodeAt(0) : 0) : 0; };
    const nums = receipt.stages.map(s => stageNum(s.stage));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i], `stage ${receipt.stages[i].stage} appears before ${receipt.stages[i-1].stage}`).toBeGreaterThanOrEqual(nums[i-1]);
    }
  });

  it('progress.pages_done increments monotonically within a stage (when snapshots available)', () => {
    const byStage = {};
    for (const snap of snapshots) {
      const { stage, pages_done } = snap.progress ?? {};
      if (!stage || pages_done == null) continue;
      if (!byStage[stage]) byStage[stage] = [];
      byStage[stage].push(pages_done);
    }
    // Only assert if we actually captured mid-job snapshots
    for (const [stage, counts] of Object.entries(byStage)) {
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i], `pages_done decreased in ${stage}`).toBeGreaterThanOrEqual(counts[i - 1]);
      }
    }
  });

  it('receipt from GET /jobs/:id/receipt has required top-level fields', () => {
    expect(receipt, 'receipt fetch failed').not.toBeNull();
    // Core identity fields
    expect(receipt.doc_id).toEqual(expect.any(String));
    expect(receipt.page_count).toEqual(expect.any(Number));
    expect(receipt.stages).toEqual(expect.any(Array));
    expect(receipt.quality).toEqual(expect.any(Object));
    expect(receipt.quality.final).toEqual(expect.any(Number));
    // cost accounting
    expect(receipt.cost_usd).toEqual(expect.any(Number));
    // human-readable narrative (added to pipeline output)
    expect(receipt.narrative).toEqual(expect.any(String));
    expect(receipt.narrative.length).toBeGreaterThan(20);
  });

  it('receipt.stages has a record for each stage that ran, with required fields', () => {
    expect(receipt).not.toBeNull();
    const s0 = receipt.stages.find(s => s.stage === 's0');
    expect(s0).toBeDefined();
    expect(s0.duration_ms).toBeGreaterThanOrEqual(0);

    const s8 = receipt.stages.find(s => s.stage === 's8');
    expect(s8).toBeDefined();

    // Stage names may have letter suffixes (s2b, s3b) — allow that
    for (const stage of receipt.stages) {
      expect(stage).toMatchObject({
        stage:          expect.stringMatching(/^s\d+[a-z]?$/),
        pages_affected: expect.any(Number),
        duration_ms:    expect.any(Number),
      });
    }
  });

  it('receipt.quality.final is a valid score (0–1)', () => {
    expect(receipt).not.toBeNull();
    expect(receipt.quality.final).toBeGreaterThanOrEqual(0);
    expect(receipt.quality.final).toBeLessThanOrEqual(1);
  });

  it('receipt.engines_used is a non-empty array', () => {
    expect(receipt).not.toBeNull();
    expect(Array.isArray(receipt.engines_used)).toBe(true);
    expect(receipt.engines_used.length).toBeGreaterThan(0);
  });

  it('GET /jobs/:id returns has_markdown=true after done', () => {
    expect(finalJob).toBeTruthy();
    expect(finalJob.has_markdown).toBe(true);
  });
});
