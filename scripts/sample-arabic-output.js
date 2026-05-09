#!/usr/bin/env node
// Run arabic_16 with haiku_ara_lang AND output enabled (s8) to read actual text.
// The md_path in the receipt will point to the saved markdown file.

import { PipelineClient } from '../../src/pipeline/client.js';
import { buildCorpus } from './corpus.js';
import { readFileSync } from 'fs';

const PIPELINE_URL = process.env.PIPELINE_URL ?? 'http://localhost:49900';
const client = new PipelineClient({ baseUrl: PIPELINE_URL });

const log = (msg) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }
  const corpus = await buildCorpus({ domain: 'bahai-library.com' });
  const arabic16 = corpus.find(d => d.id.includes('contents_16'));
  if (!arabic16) { console.error('arabic_16 not found in corpus'); process.exit(1); }

  log(`Running arabic_16 (${arabic16.pages}pp) with output enabled...`);

  // Skip s2 (Marker-pdf), s4 (escalation), s7 (archival PDF) but INCLUDE s8 (markdown export)
  const jobId = await client.submitJob({
    pdfPath: arabic16.localPath, sourceUrl: arabic16.url,
    meta: { language: arabic16.language, title: arabic16.id },
    config: { skip: ['s2','s4','s7'], s5Mode: 'haiku', s3Lang: 'ara' },
    importance: 5,
  });

  log(`Submitted job ${jobId}, waiting...`);
  const job = await client.waitForJob(jobId, { timeout: 15 * 60 * 1000 });
  const receipt = job.receipt ? (typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt) : null;
  const score = receipt?.quality?.final ?? 0;
  const mdPath = receipt?.outputs?.mdPath;

  log(`Score: ${score.toFixed(3)}, mdPath: ${mdPath}`);

  if (mdPath) {
    try {
      const text = readFileSync(mdPath, 'utf8');
      log(`\n${'='.repeat(60)}`);
      log('ARABIC OUTPUT (first 3000 chars):');
      log('='.repeat(60));
      process.stdout.write(text.slice(0, 3000) + '\n');
      log('='.repeat(60));
    } catch (e) {
      log(`Could not read mdPath: ${e.message}`);
    }
  } else {
    log('No mdPath in receipt — s8 may not have run');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
