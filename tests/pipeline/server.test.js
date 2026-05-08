import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startPipelineServer } from '../../src/pipeline/server.js';
import { makeTempDir, makeTextPdf } from './helpers.js';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

let tempDir, cleanup, service;
const PORT = 49955;  // test port, distinct from production 49900 and worker-agent 49910

beforeEach(async () => {
  ({ dir: tempDir, cleanup } = makeTempDir());
  service = await startPipelineServer({
    port: PORT,
    dbPath: join(tempDir, 'jobs.db'),
    concurrency: 1,
  });
});

afterEach(async () => {
  await service.close();
  cleanup();
});

// Disable keep-alive to prevent connection reuse across beforeEach/afterEach server restarts
const NO_KEEPALIVE = { headers: { Connection: 'close' } };
const get  = (path) => fetch(`http://localhost:${PORT}${path}`, NO_KEEPALIVE);
const post = (path, body) => fetch(`http://localhost:${PORT}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify(body),
});
const del = (path) => fetch(`http://localhost:${PORT}${path}`, { method: 'DELETE', ...NO_KEEPALIVE });

describe('GET /health', () => {
  it('returns health response with version and queue_depth', async () => {
    const res  = await get('/health');
    const body = await res.json();
    expect([200, 503]).toContain(res.status); // 503 when tools missing in test env
    expect(body).toMatchObject({ status: expect.any(String), version: expect.any(String), queue_depth: 0 });
    expect(body.deps).toBeDefined();
  });
});

describe('POST /jobs', () => {
  it('returns 202 with jobId when pdfPath exists', async () => {
    const pdfPath = join(tempDir, 'test.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const res  = await post('/jobs', { pdfPath, sourceUrl: 'https://example.com/test.pdf', importance: 2 });
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 400 when pdfPath missing from body', async () => {
    const res = await post('/jobs', { sourceUrl: 'https://example.com/test.pdf' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when pdfPath file does not exist', async () => {
    const res = await post('/jobs', { pdfPath: '/nonexistent/file.pdf' });
    expect(res.status).toBe(400);
  });

  it('increments queue_depth after submission', async () => {
    const pdfPath = join(tempDir, 'a.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    await post('/jobs', { pdfPath });
    const res  = await get('/health');
    const body = await res.json();
    expect(body.queue_depth).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /jobs/:id', () => {
  it('returns job status with has_markdown and has_pdf flags', async () => {
    const pdfPath = join(tempDir, 'b.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const { jobId } = await (await post('/jobs', { pdfPath })).json();
    const res  = await get(`/jobs/${jobId}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id: jobId, status: expect.any(String) });
    expect(body.has_markdown).toBe(false);
    expect(body.has_pdf).toBe(false);
    // Internal paths must not be exposed
    expect(body.pdf_path).toBeUndefined();
    expect(body.md_path).toBeUndefined();
  });

  it('returns 404 for unknown job id', async () => {
    const res = await get('/jobs/no-such-job');
    expect(res.status).toBe(404);
  });
});

describe('GET /jobs/:id/md and /pdf before done', () => {
  it('returns 404 for md when job is not done', async () => {
    const pdfPath = join(tempDir, 'c.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const { jobId } = await (await post('/jobs', { pdfPath })).json();
    const res = await get(`/jobs/${jobId}/md`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for pdf when job is not done', async () => {
    const pdfPath = join(tempDir, 'd.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const { jobId } = await (await post('/jobs', { pdfPath })).json();
    const res = await get(`/jobs/${jobId}/pdf`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /jobs/:id', () => {
  it('deletes job and subsequent GET returns 404', async () => {
    const pdfPath = join(tempDir, 'e.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const { jobId } = await (await post('/jobs', { pdfPath })).json();
    const delRes = await del(`/jobs/${jobId}`);
    expect(delRes.status).toBe(200);
    const getRes = await get(`/jobs/${jobId}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting unknown job id', async () => {
    const res = await del('/jobs/no-such-job');
    expect(res.status).toBe(404);
  });
});

describe('POST /jobs — field passthrough', () => {
  it('stores sourceUrl and importance in the job', async () => {
    const pdfPath = join(tempDir, 'f.pdf');
    writeFileSync(pdfPath, makeTextPdf());
    const { jobId } = await (await post('/jobs', {
      pdfPath,
      sourceUrl: 'https://example.com/f.pdf',
      importance: 4,
    })).json();
    const jobRes = await get(`/jobs/${jobId}`);
    const job = await jobRes.json();
    expect(job.source_url).toBe('https://example.com/f.pdf');
    expect(job.importance).toBe(4);
  });
});

describe('Unknown routes', () => {
  it('returns 404 for unrecognized path', async () => {
    const res = await get('/no-such-endpoint');
    expect(res.status).toBe(404);
  });
});

describe('API key auth', () => {
  it('returns 401 when apiKey is set and Authorization header is missing', async () => {
    const authService = await startPipelineServer({
      port: PORT + 1,
      dbPath: join(tempDir, 'auth-jobs.db'),
      apiKey: 'test-secret',
    });
    try {
      const res = await fetch(`http://localhost:${PORT + 1}/health`);
      expect(res.status).toBe(401);
    } finally {
      await authService.close();
    }
  });

  it('returns 200 with correct Bearer token', async () => {
    const authService = await startPipelineServer({
      port: PORT + 2,
      dbPath: join(tempDir, 'auth-jobs2.db'),
      apiKey: 'test-secret',
    });
    try {
      const res = await fetch(`http://localhost:${PORT + 2}/health`, {
        headers: { Authorization: 'Bearer test-secret' },
      });
      expect([200, 503]).toContain(res.status); // 503 when tools missing in test env
    } finally {
      await authService.close();
    }
  });
});
