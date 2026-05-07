import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openJobStore, parseJobRow } from '../../src/pipeline/job-store.js';
import { makeTempDir } from './helpers.js';
import { join } from 'path';

let tempDir, cleanup, store;

beforeEach(async () => {
  ({ dir: tempDir, cleanup } = makeTempDir());
  store = await openJobStore(join(tempDir, 'jobs.db'));
});

afterEach(() => {
  store.close();
  cleanup();
});

describe('JobStore — create / get', () => {
  it('creates a job and returns a uuid', () => {
    const id = store.create({ pdfPath: '/tmp/test.pdf' });
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('get returns the created job with pending status', () => {
    const id = store.create({ pdfPath: '/tmp/test.pdf', sourceUrl: 'https://example.com/test.pdf', importance: 3 });
    const job = store.get(id);
    expect(job).toMatchObject({ id, status: 'pending', pdf_path: '/tmp/test.pdf', importance: 3 });
    expect(job.source_url).toBe('https://example.com/test.pdf');
  });

  it('parses meta and config from JSON', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf', meta: { title: 'Hello' }, config: { apiKey: 'x' } });
    const job = store.get(id);
    expect(job.meta).toEqual({ title: 'Hello' });
    expect(job.config).toEqual({ apiKey: 'x' });
  });

  it('returns null for unknown id', () => {
    expect(store.get('no-such-id')).toBeNull();
  });
});

describe('JobStore — status transitions', () => {
  it('setProcessing sets status and started_at', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setProcessing(id);
    const job = store.get(id);
    expect(job.status).toBe('processing');
    expect(job.started_at).toBeTruthy();
  });

  it('setDone sets status, paths, and receipt', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setProcessing(id);
    store.setDone(id, { mdPath: '/out/a.md', pdfOutPath: '/out/a.pdf', receipt: { quality: { gain: 0.2 } } });
    const job = store.get(id);
    expect(job.status).toBe('done');
    expect(job.md_path).toBe('/out/a.md');
    expect(job.pdf_out_path).toBe('/out/a.pdf');
    expect(job.receipt.quality.gain).toBe(0.2);
    expect(job.finished_at).toBeTruthy();
  });

  it('setFailed sets status and truncates long error messages', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setFailed(id, 'A'.repeat(600));
    const job = store.get(id);
    expect(job.status).toBe('failed');
    expect(job.error.length).toBeLessThanOrEqual(500);
  });
});

describe('JobStore — nextPending', () => {
  it('returns oldest pending job', async () => {
    const id1 = store.create({ pdfPath: '/tmp/a.pdf' });
    await new Promise(r => setTimeout(r, 5));
    const id2 = store.create({ pdfPath: '/tmp/b.pdf' });
    const next = store.nextPending();
    expect(next.id).toBe(id1);
  });

  it('returns null when no pending jobs', () => {
    expect(store.nextPending()).toBeNull();
  });

  it('skips processing/done/failed jobs', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setProcessing(id);
    expect(store.nextPending()).toBeNull();
  });
});

describe('JobStore — progress and queueDepth', () => {
  it('setProgress stores progress JSON', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setProgress(id, { stage: 's3', pages_affected: 5, total_pages: 20 });
    const job = store.get(id);
    expect(job.progress).toEqual({ stage: 's3', pages_affected: 5, total_pages: 20 });
  });

  it('queueDepth counts pending and processing, not done/failed', () => {
    const id1 = store.create({ pdfPath: '/tmp/a.pdf' });
    const id2 = store.create({ pdfPath: '/tmp/b.pdf' });
    store.setProcessing(id1);
    store.setDone(id2, {});
    expect(store.queueDepth()).toBe(1);  // only id1 still in queue
  });
});

describe('JobStore — delete', () => {
  it('delete removes the job', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.delete(id);
    expect(store.get(id)).toBeNull();
  });
});

describe('JobStore — getProgress', () => {
  it('returns null when no progress set', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    expect(store.getProgress(id)).toBeNull();
  });

  it('returns parsed progress after setProgress', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setProgress(id, { stage: 's5', pages_affected: 3, total_pages: 10 });
    expect(store.getProgress(id)).toEqual({ stage: 's5', pages_affected: 3, total_pages: 10 });
  });
});

describe('JobStore — importance ordering', () => {
  it('nextPending returns higher-importance job first when submitted at same time', async () => {
    const idLow  = store.create({ pdfPath: '/tmp/low.pdf',  importance: 1 });
    await new Promise(r => setTimeout(r, 5));
    const idHigh = store.create({ pdfPath: '/tmp/high.pdf', importance: 5 });
    const next = store.nextPending();
    expect(next.id).toBe(idHigh);
  });
});

describe('JobStore — resetStuck', () => {
  it('resets processing jobs back to pending', () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    store.setProcessing(id);
    const count = store.resetStuck(null);
    expect(count).toBe(1);
    expect(store.get(id).status).toBe('pending');
  });

  it('does not reset jobs started after the cutoff time', async () => {
    const id = store.create({ pdfPath: '/tmp/a.pdf' });
    const cutoff = new Date().toISOString();  // cutoff before setProcessing
    await new Promise(r => setTimeout(r, 5));
    store.setProcessing(id);
    const count = store.resetStuck(cutoff);
    expect(count).toBe(0);  // started_at is after cutoff, so not reset
    expect(store.get(id).status).toBe('processing');
  });

  it('returns 0 when no stuck jobs exist', () => {
    store.create({ pdfPath: '/tmp/a.pdf' });  // still pending
    expect(store.resetStuck(null)).toBe(0);
  });
});

describe('parseJobRow', () => {
  it('parses meta JSON string to object', () => {
    const row = { meta: '{"title":"Test Doc"}', config: null, progress: null, receipt: null };
    const result = parseJobRow(row);
    expect(result.meta).toEqual({ title: 'Test Doc' });
  });

  it('returns empty object for null meta', () => {
    const row = { meta: null, config: null, progress: null, receipt: null };
    expect(parseJobRow(row).meta).toEqual({});
  });

  it('parses config JSON string to object', () => {
    const row = { meta: null, config: '{"failFast":true}', progress: null, receipt: null };
    expect(parseJobRow(row).config).toEqual({ failFast: true });
  });

  it('returns empty object for null config', () => {
    const row = { meta: null, config: null, progress: null, receipt: null };
    expect(parseJobRow(row).config).toEqual({});
  });

  it('parses progress JSON string', () => {
    const row = { meta: null, config: null, progress: '{"stage":"s3","page":2}', receipt: null };
    expect(parseJobRow(row).progress).toEqual({ stage: 's3', page: 2 });
  });

  it('returns null for null progress', () => {
    const row = { meta: null, config: null, progress: null, receipt: null };
    expect(parseJobRow(row).progress).toBeNull();
  });

  it('parses receipt JSON string', () => {
    const row = { meta: null, config: null, progress: null, receipt: '{"cost_usd":0.01}' };
    expect(parseJobRow(row).receipt).toEqual({ cost_usd: 0.01 });
  });

  it('preserves other row fields via spread', () => {
    const row = { id: 'abc123', status: 'done', meta: null, config: null, progress: null, receipt: null };
    const result = parseJobRow(row);
    expect(result.id).toBe('abc123');
    expect(result.status).toBe('done');
  });
});
