/**
 * tests/unit/utils/ai-utils-timeout.test.js - Test coverage for AbortController timeout implementation
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {aiServiceAvailable} from '../../../src/utils/ai_utils.js';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn()
}));

describe('aiServiceAvailable with AbortController', () => {
  let mockFetch;

  beforeEach(async () => {
    mockFetch = vi.mocked((await import('node-fetch')).default);
    vi.clearAllMocks();
    vi.useFakeTimers();
    
    // Reset environment variables
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should use AbortController with signal instead of timeout property', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200
    });

    const resultPromise = aiServiceAvailable({provider: 'ollama'});
    
    // Allow microtasks to run
    await vi.runAllTimersAsync();
    
    const result = await resultPromise;

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
    
    // Verify timeout property is NOT present
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('timeout');
  });

  it('should abort request after 2 seconds timeout', async () => {
    // Create a promise that never resolves to simulate timeout
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const resultPromise = aiServiceAvailable({provider: 'ollama'});

    // Fast-forward time by 2 seconds
    vi.advanceTimersByTime(2000);

    const result = await resultPromise;
    
    expect(result).toBe(false);
    
    // Check that the signal was aborted
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
  });

  it('should clear timeout when request completes successfully', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200
    });

    await aiServiceAvailable({provider: 'ollama'});

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('should handle aborted requests gracefully', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const result = await aiServiceAvailable({provider: 'ollama'});

    expect(result).toBe(false);
  });

  it('should pass signal to fetch with custom host', async () => {
    mockFetch.mockResolvedValue({ok: true});

    await aiServiceAvailable({
      provider: 'ollama',
      host: 'http://custom-host:11434'
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://custom-host:11434/api/tags',
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('should use environment variable with AbortController', async () => {
    process.env.OLLAMA_HOST = 'http://env-host:11434';
    mockFetch.mockResolvedValue({ok: true});

    await aiServiceAvailable({provider: 'ollama'});

    expect(mockFetch).toHaveBeenCalledWith(
      'http://env-host:11434/api/tags',
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('should handle network errors with timeout', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await aiServiceAvailable({provider: 'ollama'});

    expect(result).toBe(false);
  });

  it('should return false when timeout expires before response', async () => {
    // Mock a slow response that takes longer than timeout
    mockFetch.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ok: true, status: 200});
        }, 3000); // 3 seconds - longer than 2 second timeout
      });
    });

    const resultPromise = aiServiceAvailable({provider: 'ollama'});
    
    // Advance time past timeout
    vi.advanceTimersByTime(2100);
    
    const result = await resultPromise;
    expect(result).toBe(false);
  });

  it('should not leak timeouts on successful requests', async () => {
    const activeTimeouts = new Set();
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    // Track active timeouts
    global.setTimeout = vi.fn((fn, delay) => {
      const id = originalSetTimeout(fn, delay);
      activeTimeouts.add(id);
      return id;
    });

    global.clearTimeout = vi.fn((id) => {
      activeTimeouts.delete(id);
      originalClearTimeout(id);
    });

    mockFetch.mockResolvedValue({ok: true});

    await aiServiceAvailable({provider: 'ollama'});

    expect(activeTimeouts.size).toBe(0);

    // Restore
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });
});