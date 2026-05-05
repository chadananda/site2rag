#!/usr/bin/env node
// Pipeline service entry point. Run as a standalone process or via PM2.
// Config via environment variables — no flags needed for simple deploys.
//
//   PIPELINE_PORT=49900          HTTP port (default 49900)
//   PIPELINE_DB=/path/jobs.db    Job store SQLite path
//   PIPELINE_CONCURRENCY=1       Parallel pipeline runs (GPU-bound: keep at 1)
//   PIPELINE_API_KEY=secret      Optional bearer token for auth
//   ANTHROPIC_API_KEY=...        Passed through to pipeline stages
//   LOCAL_LLM=http://...         Boss vision model URL

import { startPipelineServer } from '../src/pipeline/server.js';

const port        = parseInt(process.env.PIPELINE_PORT        ?? '49900', 10);
const dbPath      = process.env.PIPELINE_DB                   ?? '/tmp/site2rag-pipeline-jobs.db';
const concurrency = parseInt(process.env.PIPELINE_CONCURRENCY ?? '1', 10);
const apiKey      = process.env.PIPELINE_API_KEY              ?? null;

// Pipeline config passed down into runPipeline() for every job
const baseConfig = {
  apiKey:   process.env.ANTHROPIC_API_KEY ?? null,
  bossUrl:  process.env.LOCAL_LLM         ?? 'http://boss.taile945b3.ts.net:49800/v1',
};

process.on('unhandledRejection', (r) => console.error('[pipeline-server] unhandledRejection:', r));
process.on('uncaughtException',  (e) => console.error('[pipeline-server] uncaughtException:',  e.message));

const { close } = await startPipelineServer({ port, dbPath, concurrency, config: baseConfig, apiKey });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[pipeline-server] ${sig} — shutting down`);
    await close();
    process.exit(0);
  });
}
