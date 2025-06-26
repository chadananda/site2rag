// tests/unit/core/ai-client.test.js
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {z} from 'zod';
import fetch from 'node-fetch';
import {callAI, getAISession, closeAISession, cleanupInactiveSessions} from '../../../src/core/ai_client.js';
// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn()
}));
// Mock debug logger
vi.mock('../../../src/services/debug_logger.js', () => ({
  default: {
    ai: vi.fn()
  }
}));
describe('ai_client', () => {
  let mockFetch;
  beforeEach(() => {
    mockFetch = vi.mocked(fetch);
    vi.clearAllMocks();
  });
  afterEach(() => {
    // Clean up any active sessions
    cleanupInactiveSessions();
  });
  describe('callAI', () => {
    describe('plain text responses', () => {
      it('should handle plain text schema responses', async () => {
        const PlainTextSchema = z.string();
        const expectedResponse = `I [[Sarah Chen]] completed the analysis.

The team [[the dev team]] launched it [[the mobile app]].

This [[the product launch]] was amazing.`;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: expectedResponse
          })
        });
        const result = await callAI('test prompt', PlainTextSchema, {provider: 'ollama'});
        expect(result).toBe(expectedResponse.trim());
      });
      it('should trim whitespace from plain text responses', async () => {
        const PlainTextSchema = z.string();
        const responseWithWhitespace = '  \n\nSome text with whitespace\n\n  ';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: responseWithWhitespace
          })
        });
        const result = await callAI('test prompt', PlainTextSchema, {provider: 'ollama'});
        expect(result).toBe('Some text with whitespace');
      });
    });
    describe('JSON responses', () => {
      it('should parse JSON responses with object schema', async () => {
        const JsonSchema = z.object({
          blocks: z.array(z.string())
        });
        const jsonResponse = {
          blocks: ['block1', 'block2']
        };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: JSON.stringify(jsonResponse)
          })
        });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toEqual(jsonResponse);
      });
      it('should extract JSON from markdown code blocks', async () => {
        const JsonSchema = z.object({
          result: z.string()
        });
        const responseWithCodeBlock = '```json\n{"result": "success"}\n```';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: responseWithCodeBlock
          })
        });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toEqual({result: 'success'});
      });
      it('should handle JSON without space after ```json marker', async () => {
        const JsonSchema = z.object({
          result: z.string()
        });
        const responseWithCodeBlock = '```json{"result": "success"}```';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: responseWithCodeBlock
          })
        });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toEqual({result: 'success'});
      });
      it('should extract JSON object from mixed text', async () => {
        const JsonSchema = z.object({
          data: z.string()
        });
        const mixedResponse = 'Here is the result: {"data": "test value"} and some more text';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: mixedResponse
          })
        });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toEqual({data: 'test value'});
      });
    });
    describe('error handling', () => {
      it('should retry on failures up to 3 times', async () => {
        const JsonSchema = z.object({result: z.string()});
        // Fail twice, succeed on third
        mockFetch
          .mockRejectedValueOnce(new Error('Network error'))
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
              response: '{"result": "success"}'
            })
          });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toEqual({result: 'success'});
        expect(mockFetch).toHaveBeenCalledTimes(3);
      }, 10000); // Increase timeout for retry test
      it('should return null after 3 failed attempts', async () => {
        const JsonSchema = z.object({result: z.string()});
        mockFetch
          .mockRejectedValueOnce(new Error('Persistent error'))
          .mockRejectedValueOnce(new Error('Persistent error'))
          .mockRejectedValueOnce(new Error('Persistent error'));
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(3);
      }, 10000);
      it('should handle timeout errors', async () => {
        const JsonSchema = z.object({result: z.string()});
        // Create a promise that never resolves to simulate timeout
        mockFetch.mockImplementation(() => new Promise(() => {}));
        const result = await callAI('test prompt', JsonSchema, {
          provider: 'ollama',
          timeout: 100 // Very short timeout
        });
        expect(result).toBeNull();
      }, 10000);
      it('should handle malformed JSON responses', async () => {
        const JsonSchema = z.object({result: z.string()});
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: '{invalid json}'
          })
        });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toBeNull();
      }, 10000);
      it('should handle API errors with status codes', async () => {
        const JsonSchema = z.object({result: z.string()});
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve('Server error details')
        });
        const result = await callAI('test prompt', JsonSchema, {provider: 'ollama'});
        expect(result).toBeNull();
      }, 10000);
    });
    describe('schema type detection', () => {
      it('should detect string schema and skip JSON parsing', async () => {
        const StringSchema = z.string();
        const plainResponse = 'This is plain text, not JSON';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: plainResponse
          })
        });
        const result = await callAI('test prompt', StringSchema, {provider: 'ollama'});
        expect(result).toBe(plainResponse);
      });
      it('should detect object schema and parse JSON', async () => {
        const ObjectSchema = z.object({
          name: z.string(),
          value: z.number()
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: '{"name": "test", "value": 42}'
          })
        });
        const result = await callAI('test prompt', ObjectSchema, {provider: 'ollama'});
        expect(result).toEqual({name: 'test', value: 42});
      });
      it('should detect array schema and parse JSON', async () => {
        const ArraySchema = z.array(z.string());
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            response: '["item1", "item2", "item3"]'
          })
        });
        const result = await callAI('test prompt', ArraySchema, {provider: 'ollama'});
        expect(result).toEqual(['item1', 'item2', 'item3']);
      });
    });
    describe('provider support', () => {
      it('should support Anthropic provider', async () => {
        const StringSchema = z.string();
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            content: [{text: 'Anthropic response'}]
          })
        });
        const result = await callAI('test prompt', StringSchema, {
          provider: 'anthropic',
          apiKey: 'test-key'
        });
        expect(result).toBe('Anthropic response');
        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.anthropic.com/v1/messages',
          expect.objectContaining({
            headers: expect.objectContaining({
              'x-api-key': 'test-key'
            })
          })
        );
      });
      it('should support OpenAI provider', async () => {
        const StringSchema = z.string();
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            choices: [{message: {content: 'OpenAI response'}}]
          })
        });
        const result = await callAI('test prompt', StringSchema, {
          provider: 'openai',
          apiKey: 'test-key'
        });
        expect(result).toBe('OpenAI response');
        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.openai.com/v1/chat/completions',
          expect.objectContaining({
            headers: expect.objectContaining({
              'Authorization': 'Bearer test-key'
            })
          })
        );
      });
      it('should throw error for missing API key', async () => {
        const StringSchema = z.string();
        const result = await callAI('test prompt', StringSchema, {
          provider: 'openai'
          // No API key provided
        });
        expect(result).toBeNull();
      }, 10000);
    });
  });
  describe('AI Sessions', () => {
    it('should create and retrieve AI sessions', () => {
      const session1 = getAISession('test-session-1', {provider: 'ollama'});
      const session2 = getAISession('test-session-1', {provider: 'ollama'});
      expect(session1).toBe(session2); // Same instance
      expect(session1.sessionId).toBe('test-session-1');
    });
    it('should cache context in sessions', async () => {
      const session = getAISession('context-test', {provider: 'ollama'});
      const cachedContext = 'This is cached context that will be reused';
      session.setCachedContext(cachedContext);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          response: 'Response text'
        })
      });
      const StringSchema = z.string();
      await session.call('Additional prompt', StringSchema);
      // Check that the cached context was prepended
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.prompt).toContain(cachedContext);
      expect(callBody.prompt).toContain('Additional prompt');
    });
    it('should track session metrics', async () => {
      const session = getAISession('metrics-test', {provider: 'ollama'});
      session.setCachedContext('Cached context');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({response: 'test'})
      });
      const StringSchema = z.string();
      await session.call('Prompt 1', StringSchema);
      await session.call('Prompt 2', StringSchema);
      const metrics = session.getMetrics();
      expect(metrics.hits).toBe(2);
      expect(metrics.misses).toBe(0);
      expect(metrics.conversationLength).toBe(2);
      expect(metrics.hitRate).toBe('100.0');
    });
    it('should close and return session metrics', () => {
      const session = getAISession('close-test', {provider: 'ollama'});
      session.setCachedContext('Context');
      const metrics = closeAISession('close-test');
      expect(metrics).toBeDefined();
      expect(metrics.conversationLength).toBe(0);
      // Session should be removed
      const newSession = getAISession('close-test', {provider: 'ollama'});
      expect(newSession).not.toBe(session); // Different instance
    });
    it('should cleanup inactive sessions', () => {
      const session1 = getAISession('old-session', {provider: 'ollama'});
      const session2 = getAISession('new-session', {provider: 'ollama'});
      // Make session1 appear old
      session1.lastUsed = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      cleanupInactiveSessions();
      // Old session should be removed
      const retrievedOld = getAISession('old-session', {provider: 'ollama'});
      const retrievedNew = getAISession('new-session', {provider: 'ollama'});
      expect(retrievedOld).not.toBe(session1); // New instance
      expect(retrievedNew).toBe(session2); // Same instance
    });
  });
});