// SLP service client — public SearchLayerPDF API (SLP_API_URL, e.g. https://searchlayerpdf.com/v1).
// Upload-based flow (the public API does NOT fetch by URL — we upload the bytes):
//   submitJob({pdfPath|pdfBuffer, filename, meta}) → job_id
//     1) POST /jobs {filename, meta}        → { job_id, upload_url, upload_method, process_url }
//     2) PUT  upload_url  (raw PDF bytes)   → { uploaded: true }
//     3) POST process_url {}                → { status: 'processing', orch_job_id }
//   getJob(jobId)      → status record { status, current_stage, score_before, score_after,
//                                        pages_processed, page_count, cost_cents, failure_code, ... }
//   getMarkdown(jobId) → structured RAG markdown (Accept: text/markdown), with <!-- pdf:N --> page anchors
//   getPdf(jobId)      → upgraded searchable PDF bytes (Accept: application/pdf)
//   getResult(jobId)   → JSON envelope (Accept: application/json) → { download_url, score_before, score_after }
// Auth: Bearer SLP_API_KEY on every request.

import { readFile } from 'fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PipelineClient {
  /**
   * @param {object} opts
   * @param {string}  opts.baseUrl        SLP API base (required; no localhost default)
   * @param {string} [opts.apiKey]        Bearer token
   * @param {number} [opts.pollInterval]  ms between status polls (default 3000)
   * @param {number} [opts.timeout]       ms before waitForJob gives up (default 30 min)
   */
  constructor({ baseUrl, apiKey = null, pollInterval = 3000, timeout = 1_800_000 } = {}) {
    if (!baseUrl) throw new Error('PipelineClient requires baseUrl (set SLP_API_URL)');
    this.baseUrl      = baseUrl.replace(/\/$/, '');
    this.apiKey       = apiKey;
    this.pollInterval = pollInterval;
    this.timeout      = timeout;
  }

  /**
   * Create → upload → process. Returns the SLP job_id.
   * @param {object} o
   * @param {string} [o.pdfPath]    local PDF to upload
   * @param {Buffer} [o.pdfBuffer]  PDF bytes (takes precedence over pdfPath)
   * @param {string} [o.filename]   original filename hint
   * @param {object} [o.meta]       extra metadata passed to SLP
   */
  async submitJob({ pdfPath, pdfBuffer, filename, meta = {} } = {}) {
    const bytes = pdfBuffer ?? (pdfPath ? await readFile(pdfPath) : null);
    if (!bytes) throw new Error('submitJob requires pdfPath or pdfBuffer');
    const name = filename || (pdfPath ? pdfPath.split('/').pop() : 'document.pdf');

    const job = await this._json('POST', '/jobs', { filename: name, meta });
    const jobId = job.job_id;
    if (!jobId) throw new Error(`SLP create returned no job_id: ${JSON.stringify(job).slice(0, 200)}`);

    const up = await fetch(this._url(job.upload_url), {
      method: job.upload_method || 'PUT',
      headers: this._headers({ 'Content-Type': 'application/pdf' }),
      body: bytes,
    });
    if (!up.ok) throw new Error(`SLP upload (job ${jobId}): HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);

    await this._json('POST', job.process_url, {});
    return jobId;
  }

  /** Current job status record. */
  getJob(jobId) { return this._json('GET', `/jobs/${jobId}`); }

  /** Completed-job result envelope (Accept: application/json) → { download_url, expires_at, score_before, score_after }. */
  getResult(jobId) { return this._json('GET', `/jobs/${jobId}/result`); }

  /** Structured RAG markdown for a completed job (Accept: text/markdown). Returns the markdown text directly. */
  async getMarkdown(jobId) {
    const res = await fetch(this._url(`/jobs/${jobId}/result`), { headers: this._headers({ Accept: 'text/markdown' }) });
    if (!res.ok) throw new Error(`SLP markdown ${jobId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.text();
  }

  /** Upgraded searchable PDF for a completed job (Accept: application/pdf). Returns a Buffer. */
  async getPdf(jobId) {
    const res = await fetch(this._url(`/jobs/${jobId}/result`), { headers: this._headers({ Accept: 'application/pdf' }) });
    if (!res.ok) throw new Error(`SLP pdf ${jobId}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Raw bytes/text of an absolute or relative sub-resource. */
  async getRaw(pathOrUrl, returnType = 'text') {
    const res = await fetch(this._url(pathOrUrl), { headers: this._headers() });
    if (!res.ok) throw new Error(`SLP GET ${pathOrUrl}: HTTP ${res.status}`);
    return returnType === 'buffer' ? Buffer.from(await res.arrayBuffer()) : await res.text();
  }

  /** Poll until terminal state; returns the final job record (throws on failure/timeout). */
  async waitForJob(jobId, { timeout } = {}) {
    const deadline = Date.now() + (timeout ?? this.timeout);
    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);
      if (PipelineClient.isDone(job.status))   return job;
      if (PipelineClient.isFailed(job.status)) throw new Error(`SLP job ${jobId} failed: ${job.failure_code || job.status}`);
      await sleep(this.pollInterval);
    }
    throw new Error(`SLP job ${jobId} timed out after ${this.timeout}ms`);
  }

  static isDone(status)   { return ['done', 'completed', 'succeeded', 'complete'].includes(status); }
  static isFailed(status) { return ['failed', 'error', 'cancelled', 'canceled'].includes(status); }

  // --- private ---

  _headers(extra = {}) {
    const h = { Accept: 'application/json', ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  // upload_url / process_url come back absolute; relative paths get baseUrl prepended.
  _url(p) { return /^https?:\/\//i.test(p) ? p : this.baseUrl + p; }

  async _json(method, p, body) {
    const res = await fetch(this._url(p), {
      method,
      headers: this._headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SLP ${method} ${p}: HTTP ${res.status} ${text.slice(0, 200)}`);
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`SLP ${method} ${p}: invalid JSON`); }
  }
}
