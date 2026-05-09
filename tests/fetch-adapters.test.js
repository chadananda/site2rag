// fetch-adapters.js unit tests. Mocks undici fetch — no real HTTP.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', () => ({ fetch: vi.fn() }));
vi.mock('../src/playwright-fetch.js', () => ({
  createPlaywrightPool: vi.fn(async () => null),
  isHtmlShell: vi.fn(() => false),
  isWorthRendering: vi.fn(() => false),
}));

import { fetch } from 'undici';
import { createMediaWikiAdapter, getAdapter } from '../src/fetch-adapters.js';

const WIKI_ORIGIN = 'https://en.wikipedia.org';
const WIKI_CONFIG = { url: WIKI_ORIGIN, domain: 'en.wikipedia.org', mediawiki: { wiki_path: '/wiki/' } };

describe('createMediaWikiAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an object with fetch and close methods', () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    expect(typeof adapter.fetch).toBe('function');
    expect(typeof adapter.close).toBe('function');
  });

  it('close() resolves without error', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it('returns status 200 with html for a valid wiki article', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ parse: { title: 'Test Article', text: { '*': '<p>Content</p>' } } }),
      headers: { get: () => null }
    });
    const result = await adapter.fetch(`${WIKI_ORIGIN}/wiki/Test_Article`, null);
    expect(result.status).toBe(200);
    expect(result.mimeType).toBe('text/html');
    expect(result.buf.toString()).toContain('Test Article');
  });

  it('returns 404 when API returns missingtitle error', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: 'missingtitle', info: 'page does not exist' } }),
      headers: { get: () => null }
    });
    const result = await adapter.fetch(`${WIKI_ORIGIN}/wiki/NonExistentPage`, null);
    expect(result.status).toBe(404);
  });

  it('returns 500 when API returns unexpected error code', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: 'permissiondenied', info: 'blocked' } }),
      headers: { get: () => null }
    });
    const result = await adapter.fetch(`${WIKI_ORIGIN}/wiki/ProtectedPage`, null);
    expect(result.status).toBe(500);
  });

  it('returns 404 when API returns invalidtitle error', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: 'invalidtitle', info: 'bad title' } }),
      headers: { get: () => null }
    });
    const result = await adapter.fetch(`${WIKI_ORIGIN}/wiki/Bad<Title>`, null);
    expect(result.status).toBe(404);
  });

  it('returns status 0 when fetch throws a non-retried error', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    // Use a generic error (not timeout/ECONNRESET/ECONNREFUSED) so fetchWithRetry throws immediately
    fetch.mockRejectedValue(new Error('DNS lookup failed'));
    const result = await adapter.fetch(`${WIKI_ORIGIN}/wiki/Some_Article`, null);
    expect(result.status).toBe(0);
  });

  it('falls back to plain HTTP for non-wiki URLs (e.g. image files)', async () => {
    const adapter = createMediaWikiAdapter(WIKI_CONFIG);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      headers: { get: (h) => h === 'content-type' ? 'image/png' : null }
    });
    const result = await adapter.fetch(`${WIKI_ORIGIN}/static/images/logo.png`, null);
    expect(result.status).toBe(200);
    expect(result.mimeType).toBe('image/png');
  });
});

describe('getAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mediawiki adapter when fetch_adapter=mediawiki_api', async () => {
    const adapter = await getAdapter({ ...WIKI_CONFIG, fetch_adapter: 'mediawiki_api' });
    expect(typeof adapter.fetch).toBe('function');
  });

  it('default (no fetch_adapter) returns http adapter', async () => {
    const adapter = await getAdapter({ url: 'https://example.com', domain: 'example.com', playwright: { enabled: false } });
    expect(typeof adapter.fetch).toBe('function');
    await adapter.close();
  });
});
