// reocr.js unit tests for availability checks (pure HTTP status).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = join(tmpdir(), `site2rag-reocr-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { bossAvailable, ocrAvailableBackend, bossPrewarm } from '../src/pdf-upgrade/reocr.js';

describe('bossAvailable', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns false when fetch throws (network error)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await bossAvailable()).toBe(false);
  });

  it('returns false when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 });
    expect(await bossAvailable()).toBe(false);
  });

  it('returns false when model is not in the list', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'other-model', _alias: 'other' }] })
    });
    expect(await bossAvailable()).toBe(false);
  });

  it('returns true when model id matches LOCAL_LLM_MODEL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'vision', _alias: null }] })
    });
    expect(await bossAvailable()).toBe(true);
  });

  it('returns true when _alias matches LOCAL_LLM_MODEL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'some-other-id', _alias: 'vision' }] })
    });
    expect(await bossAvailable()).toBe(true);
  });
});

describe('ocrAvailableBackend', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns null when boss unavailable and no API key', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('unreachable'));
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await ocrAvailableBackend()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('returns "claude" when boss unavailable but API key exists', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('unreachable'));
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    try {
      expect(await ocrAvailableBackend()).toBe('claude');
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns "boss" when boss is available', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'vision', _alias: 'vision' }] })
    });
    expect(await ocrAvailableBackend()).toBe('boss');
  });
});

describe('bossPrewarm', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns true when prewarm endpoint returns ok', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 });
    expect(await bossPrewarm()).toBe(true);
  });

  it('returns true when prewarm endpoint returns 202 (accepted)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 202 });
    expect(await bossPrewarm()).toBe(true);
  });

  it('returns false when prewarm endpoint returns non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 });
    expect(await bossPrewarm()).toBe(false);
  });

  it('returns false when fetch throws (boss unreachable)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await bossPrewarm()).toBe(false);
  });
});
