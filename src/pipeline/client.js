// HTTP client for the pipeline service. Change baseUrl to move the service anywhere.
// Exports: PipelineClient. Deps: node:http, node:https
//
// Usage:
//   const client = new PipelineClient({ baseUrl: process.env.PIPELINE_URL ?? 'http://localhost:49900' });
//   const jobId = await client.submitJob({ pdfPath, sourceUrl, meta, importance });
//   const job   = await client.waitForJob(jobId);   // polls until done
//   const md    = await client.getMarkdown(jobId);

import { request as httpRequest }  from 'http';
import { request as httpsRequest } from 'https';

export class PipelineClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl='http://localhost:49900']
   * @param {string} [opts.apiKey]       - added as Bearer token if provided
   * @param {number} [opts.pollInterval] - ms between status polls (default 3000)
   * @param {number} [opts.timeout]      - ms before waitForJob gives up (default 600000 = 10 min)
   */
  constructor({ baseUrl = 'http://localhost:49900', apiKey = null, pollInterval = 3000, timeout = 600_000 } = {}) {
    this.baseUrl      = baseUrl.replace(/\/$/, '');
    this.apiKey       = apiKey;
    this.pollInterval = pollInterval;
    this.timeout      = timeout;
  }

  /** Check service health. Returns { status, version, queue_depth } or throws on unreachable. */
  health() { return this._get('/health'); }

  /**
   * Submit a job. Returns jobId string.
   * @param {object} opts
   * @param {string} opts.pdfPath    - absolute path the server can read (same machine or shared fs)
   * @param {string} [opts.sourceUrl]
   * @param {object} [opts.meta]     - { title, author, language, anchorText, ... }
   * @param {object} [opts.config]   - pipeline config overrides
   * @param {number} [opts.importance=1]
   */
  async submitJob({ pdfPath, sourceUrl, meta, config, importance = 1 }) {
    const { jobId } = await this._post('/jobs', { pdfPath, sourceUrl, meta, config, importance });
    return jobId;
  }

  /** Get current job status. Returns job record or throws 404. */
  getJob(jobId) { return this._get(`/jobs/${jobId}`); }

  /**
   * Submit and wait for completion. Returns the finished job record.
   * Throws if the job fails or the timeout is exceeded.
   */
  async runJob(opts) {
    const jobId = await this.submitJob(opts);
    return this.waitForJob(jobId);
  }

  /** Poll until the job is done or failed. Returns the final job record. */
  async waitForJob(jobId) {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);
      if (job.status === 'done')   return job;
      if (job.status === 'failed') throw new Error(`pipeline job failed: ${job.error}`);
      await sleep(this.pollInterval);
    }
    throw new Error(`pipeline job ${jobId} timed out after ${this.timeout}ms`);
  }

  /** Returns the corrected markdown string for a completed job. */
  getMarkdown(jobId) { return this._getRaw(`/jobs/${jobId}/md`, 'text'); }

  /** Returns the upgraded PDF as a Buffer for a completed job. */
  getPdf(jobId) { return this._getRaw(`/jobs/${jobId}/pdf`, 'buffer'); }

  /** Delete a job record (cleanup after consuming outputs). */
  deleteJob(jobId) { return this._delete(`/jobs/${jobId}`); }

  // --- private ---

  _headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  _get(path)          { return this._req('GET',    path); }
  _post(path, body)   { return this._req('POST',   path, body); }
  _delete(path)       { return this._req('DELETE', path); }

  _req(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url      = new URL(this.baseUrl + path);
      const reqFn    = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const payload  = body ? JSON.stringify(body) : null;
      const headers  = this._headers();
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

      const req = reqFn({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let msg = `HTTP ${res.statusCode}`;
            try { const body = JSON.parse(data); if (body.error) msg = `HTTP ${res.statusCode} ${body.error}`; } catch {}
            return reject(new Error(`pipeline ${method} ${path}: ${msg}`));
          }
          try {
            const ct = res.headers['content-type'] ?? '';
            resolve(ct.includes('json') ? JSON.parse(data) : data);
          } catch { reject(new Error(`invalid JSON from ${path}`)); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  _getRaw(path, returnType = 'text') {
    return new Promise((resolve, reject) => {
      const url   = new URL(this.baseUrl + path);
      const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;

      const req = reqFn({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'GET',
        headers:  this._headers(),
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`pipeline GET ${path}: HTTP ${res.statusCode}`));
          }
          const buf = Buffer.concat(chunks);
          resolve(returnType === 'buffer' ? buf : buf.toString('utf8'));
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
