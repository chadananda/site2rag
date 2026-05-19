#!/usr/bin/env node
// Pipeline service entry point. Run as a standalone process or via PM2.
// Config via environment variables — no flags needed for simple deploys.
//
//   PIPELINE_PORT=49900          HTTP port (default 49900)
//   PIPELINE_DB=/path/jobs.db    Job store SQLite path
//   PIPELINE_CONCURRENCY=1       Parallel pipeline runs
//   PIPELINE_API_KEY=secret      Optional bearer token for auth
//   ANTHROPIC_API_KEY=...        Passed through to pipeline stages
//   LOCAL_LLM=http://...         Boss vision model URL
//   WORKER_URLS=http://boss:49910,...  Comma-separated worker URLs seeded at startup

import { startPipelineServer } from '../src/pipeline/server.js';

const port        = parseInt(process.env.PIPELINE_PORT        ?? '49900', 10);
const dbPath      = process.env.PIPELINE_DB                   ?? '/tmp/site2rag-pipeline-jobs.db';
const concurrency = parseInt(process.env.PIPELINE_CONCURRENCY ?? '1', 10);
const apiKey      = process.env.PIPELINE_API_KEY              ?? null;

// Heavy OCR tools route to the worker pool (boss + any registered workers) instead of
// running locally on the orchestrator. The pool picks the least-loaded GPU-capable worker.
const REGISTRY = 'http://localhost:49900';
const workerPoolBackend = (tool) => ({ type: 'workerPool', registryUrl: REGISTRY });

const baseConfig = {
  apiKey:   process.env.ANTHROPIC_API_KEY ?? null,
  bossUrl:  process.env.LOCAL_LLM         ?? 'http://boss.taile945b3.ts.net:49800/v1',
  toolBackends: {
    easyocr_ocr: workerPoolBackend('easyocr_ocr'),
    paddle_ocr:  workerPoolBackend('paddle_ocr'),
    doctr_ocr:   workerPoolBackend('doctr_ocr'),
    kraken_ocr:  workerPoolBackend('kraken_ocr'),
    // surya_ocr excluded — 3-way concurrent GPU (easyocr+doctr+surya) exceeds 120s torch timeout; 2-way parallel stays fast
    // tesseract runs locally on tower-nas (80 cores, 0.3s, no network) — routing to boss overwhelms it with 9 concurrent requests
    preprocess_image: workerPoolBackend('preprocess_image'),
  },
};

process.on('unhandledRejection', (r) => console.error('[pipeline-server] unhandledRejection:', r));
process.on('uncaughtException',  (e) => console.error('[pipeline-server] uncaughtException:',  e.message));

const { close } = await startPipelineServer({ port, dbPath, concurrency, config: baseConfig, apiKey });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log('[pipeline-server] ' + sig + ' — shutting down');
    await close();
    process.exit(0);
  });
}
