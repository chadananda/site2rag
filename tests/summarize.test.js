import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-summarize-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';
import { summarizeTopPending } from '../src/pdf-upgrade/summarize.js';

const DOMAIN = 'summarize.example.com';

describe('summarizeTopPending', () => {
  let db;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    db = openDb(DOMAIN);
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns undefined immediately when ANTHROPIC_API_KEY is not set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await summarizeTopPending(db, DOMAIN);
      expect(result).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('returns undefined immediately when ANTHROPIC_API_KEY is empty string', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '';
    try {
      const result = await summarizeTopPending(db, DOMAIN);
      expect(result).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns undefined immediately when no pending rows exist (even with API key)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake-key';
    try {
      // No pdf_quality rows inserted — rows.length === 0, so returns undefined
      const result = await summarizeTopPending(db, DOMAIN);
      expect(result).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
