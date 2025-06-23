import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {aiServiceAvailable, classifyBlocksWithAI} from '../../../src/utils/ai_utils.js';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn()
}));

// Mock logger
vi.mock('../../../src/services/logger_service.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}));

describe('AI Utils', () => {
  let mockFetch;

  beforeEach(async () => {
    mockFetch = vi.mocked((await import('node-fetch')).default);
    vi.clearAllMocks();
    
    // Reset environment variables
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('aiServiceAvailable', () => {
    it('should return true when Ollama service is available', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200
      });

      const result = await aiServiceAvailable({provider: 'ollama'});
      
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', {timeout: 2000});
    });

    it('should return false when Ollama service is not available', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await aiServiceAvailable({provider: 'ollama'});
      
      expect(result).toBe(false);
    });

    it('should return false when Ollama responds with error status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500
      });

      const result = await aiServiceAvailable({provider: 'ollama'});
      
      expect(result).toBe(false);
    });

    it('should use custom host when provided', async () => {
      mockFetch.mockResolvedValue({ok: true});

      await aiServiceAvailable({
        provider: 'ollama', 
        host: 'http://custom-host:11434'
      });
      
      expect(mockFetch).toHaveBeenCalledWith('http://custom-host:11434/api/tags', {timeout: 2000});
    });

    it('should use OLLAMA_HOST environment variable when set', async () => {
      process.env.OLLAMA_HOST = 'http://env-host:11434';
      mockFetch.mockResolvedValue({ok: true});

      await aiServiceAvailable({provider: 'ollama'});
      
      expect(mockFetch).toHaveBeenCalledWith('http://env-host:11434/api/tags', {timeout: 2000});
    });

    it('should default to localhost when no host provided', async () => {
      mockFetch.mockResolvedValue({ok: true});

      await aiServiceAvailable();
      
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', {timeout: 2000});
    });

    it('should return false for unknown providers', async () => {
      const result = await aiServiceAvailable({provider: 'unknown-provider'});
      
      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle missing provider gracefully', async () => {
      mockFetch.mockResolvedValue({ok: true});

      const result = await aiServiceAvailable({});
      
      expect(result).toBe(true); // Should default to ollama
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('classifyBlocksWithAI', () => {
    const mockBlocks = [
      '<nav><ul><li>Home</li><li>About</li></ul></nav>',
      '<main><h1>Article Title</h1><p>Main content here</p></main>',
      '<aside>Related articles</aside>',
      '<footer>Copyright 2024</footer>'
    ];

    it('should classify blocks and return indices to remove', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: JSON.stringify([0, 2, 3]) // Remove nav, aside, footer - keep main
        })
      });

      const result = await classifyBlocksWithAI(mockBlocks, {
        provider: 'ollama',
        model: 'llama2'
      });
      
      expect(result).toEqual([0, 2, 3]);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle empty blocks array', async () => {
      const result = await classifyBlocksWithAI([], {provider: 'ollama'});
      
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle AI service errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('AI service unavailable'));

      const result = await classifyBlocksWithAI(mockBlocks, {provider: 'ollama'});
      
      expect(result).toEqual([]); // Should return empty array on error
    });

    it('should handle invalid JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: 'invalid json response'
        })
      });

      const result = await classifyBlocksWithAI(mockBlocks, {provider: 'ollama'});
      
      expect(result).toEqual([]); // Should return empty array on parse error
    });

    it('should handle non-ok HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const result = await classifyBlocksWithAI(mockBlocks, {provider: 'ollama'});
      
      expect(result).toEqual([]);
    });

    it('should use default provider when not specified', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: JSON.stringify([])
        })
      });

      await classifyBlocksWithAI(mockBlocks);
      
      expect(mockFetch).toHaveBeenCalled();
      // Should use ollama as default provider
    });

    it('should validate returned indices are within bounds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: JSON.stringify([0, 5, 10]) // Indices 5,10 are out of bounds for 4 blocks
        })
      });

      const result = await classifyBlocksWithAI(mockBlocks, {provider: 'ollama'});
      
      // Should filter out out-of-bounds indices
      expect(result).toEqual([0]);
    });

    it('should handle malformed response data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: JSON.stringify(['invalid', 'indices', null])
        })
      });

      const result = await classifyBlocksWithAI(mockBlocks, {provider: 'ollama'});
      
      expect(result).toEqual([]); // Should handle non-numeric indices gracefully
    });

    it('should construct proper prompt for AI classification', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: JSON.stringify([])
        })
      });

      await classifyBlocksWithAI(mockBlocks, {
        provider: 'ollama',
        model: 'test-model'
      });

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);
      
      expect(requestBody.prompt).toContain('navigation');
      expect(requestBody.prompt).toContain('main content');
      expect(requestBody.model).toBe('test-model');
    });
  });
});