// ai_client_v2.js
// Improved AI client with proper context handling for different providers
// Implements message-based approach for better context management
import fetch from 'node-fetch';
import pLimit from 'p-limit';
// import logger from '../services/logger_service.js'; // Currently unused
import debugLogger from '../services/debug_logger.js';
// Global limiter: only 3 concurrent AI calls at a time
export const aiLimiter = pLimit(3);
// Session management for context caching
const activeSessions = new Map();
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Improved AI Session with message-based context handling
 */
export class AISessionV2 {
  constructor(sessionId, aiConfig) {
    this.sessionId = sessionId;
    this.aiConfig = aiConfig;
    this.messages = []; // Message history for chat-based APIs
    this.systemContext = null; // System message for context
    this.cacheMetrics = {hits: 0, misses: 0, tokensSaved: 0};
    this.lastUsed = Date.now();
    this.contextTokens = 0; // Track context size
  }
  /**
   * Set the system context (metadata, rules, etc)
   * @param {string} context - Context to use as system message
   */
  setSystemContext(context) {
    this.systemContext = context;
    // Initialize messages with system context
    this.messages = [
      {
        role: 'system',
        content: context
      }
    ];
    // Estimate tokens (rough: 1 token ≈ 4 chars)
    this.contextTokens = Math.ceil(context.length / 4);
    this.lastUsed = Date.now();
    debugLogger.ai(
      `Session ${this.sessionId} - System context set: ${context.length} chars (~${this.contextTokens} tokens)`
    );
  }
  /**
   * Make an AI call using message-based approach
   * @param {string} userPrompt - User message content
   * @param {object} schema - Zod schema for validation
   * @returns {Promise<any>} - Parsed response
   */
  async call(userPrompt, schema) {
    this.lastUsed = Date.now();

    // Add user message to history
    const userMessage = {role: 'user', content: userPrompt};

    // Log what we're actually sending
    const userTokens = Math.ceil(userPrompt.length / 4);
    debugLogger.ai(`Session ${this.sessionId} - User prompt: ${userPrompt.length} chars (~${userTokens} tokens)`);
    debugLogger.ai(`Session ${this.sessionId} - Context already cached: ${this.contextTokens} tokens`);
    debugLogger.ai(
      `Session ${this.sessionId} - Total new tokens sent: ${userTokens} (saved ${this.contextTokens} tokens)`
    );

    try {
      // Call AI with message history
      const result = await this.callWithMessages(userMessage, schema);

      // Track metrics
      if (this.systemContext) {
        this.cacheMetrics.hits++;
        this.cacheMetrics.tokensSaved += this.contextTokens;
      }

      return result;
    } catch (error) {
      if (this.systemContext) this.cacheMetrics.misses++;
      throw error;
    }
  }
  /**
   * Internal method to handle provider-specific message formatting
   */
  async callWithMessages(userMessage, schema) {
    const provider = this.aiConfig.provider || 'ollama';

    // For Ollama, use chat endpoint with messages
    if (provider === 'ollama') {
      // Build messages array for this request
      const messages = [...this.messages, userMessage];

      const response = await makeAICallV2({
        provider: 'ollama',
        messages: messages,
        aiConfig: this.aiConfig
      });

      // Parse and validate response
      return await parseAndValidateResponse(response, schema);
    }

    // For API providers (OpenAI, Anthropic, etc), use message format
    if (['openai', 'anthropic', 'mistral', 'perplexity', 'xai'].includes(provider)) {
      const messages = [...this.messages, userMessage];

      const response = await makeAICallV2({
        provider: provider,
        messages: messages,
        aiConfig: this.aiConfig
      });

      return await parseAndValidateResponse(response, schema);
    }

    throw new Error(`Provider ${provider} not supported`);
  }
  /**
   * Get cache performance metrics
   */
  getMetrics() {
    const total = this.cacheMetrics.hits + this.cacheMetrics.misses;
    return {
      hits: this.cacheMetrics.hits,
      misses: this.cacheMetrics.misses,
      hitRate: total > 0 ? ((this.cacheMetrics.hits / total) * 100).toFixed(1) : 0,
      tokensSaved: this.cacheMetrics.tokensSaved,
      estimatedCostSaved: (this.cacheMetrics.tokensSaved * 0.00001).toFixed(4), // Rough estimate
      messagesInHistory: this.messages.length,
      lastUsed: this.lastUsed
    };
  }
}
/**
 * Improved AI call function with message-based approach
 */
async function makeAICallV2({provider, messages, aiConfig}) {
  debugLogger.ai(`makeAICallV2 - Provider: ${provider}, Messages: ${messages.length}`);

  // Set timeout based on provider (local models need more time)
  const isLocalModel = provider === 'ollama';
  const defaultTimeout = isLocalModel ? 120000 : 30000; // 2 min for local, 30s for API
  const timeoutMs = aiConfig.timeout || defaultTimeout;

  if (provider === 'ollama') {
    const model = aiConfig.model || process.env.OLLAMA_MODEL || 'llama3.2:latest';
    const host = aiConfig.host || process.env.OLLAMA_HOST || 'http://localhost:11434';

    debugLogger.ai(`Ollama - Using chat endpoint with ${messages.length} messages`);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const requestBody = {
      model,
      messages, // Send full message history
      stream: false,
      format: 'json',
      options: {
        temperature: 0.1,
        top_p: 0.9,
        repeat_penalty: 1.1
      }
    };

    debugLogger.ai(`Ollama - Request URL: ${host}/api/chat`);

    const fetchPromise = fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(requestBody)
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama API request failed: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();
    return data.message?.content || data.response || '';
  }

  if (provider === 'openai') {
    const model = aiConfig.model || 'gpt-4o';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const fetchPromise = fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages, // Send message array directly
        max_tokens: 4000,
        temperature: 0.1,
        top_p: 0.9,
        response_format: {type: 'json_object'} // Request JSON response
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API request failed: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();
    return data.choices[0].message.content || '';
  }

  if (provider === 'anthropic') {
    const model = aiConfig.model || 'claude-3-haiku-20240307';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('Anthropic API key is required');
    }

    // Convert messages to Anthropic format
    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const requestBody = {
      model: model,
      max_tokens: 4000,
      messages: nonSystemMessages,
      temperature: 0.1,
      top_p: 0.9
    };

    // Add system message if present
    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

    const fetchPromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API request failed: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();
    return data.content[0].text || '';
  }

  // Similar implementations for other providers...
  throw new Error(`Provider ${provider} not implemented in V2`);
}
/**
 * Parse and validate AI response
 */
async function parseAndValidateResponse(responseText, schema) {
  debugLogger.ai(`Parsing response, length: ${responseText.length}`);

  // Try to extract JSON from the response
  let jsonText = responseText.trim();

  // Handle cases where AI returns JSON wrapped in markdown code blocks
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    debugLogger.ai(`Found JSON in code blocks`);
    jsonText = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the response
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    debugLogger.ai(`Extracted JSON object`);
    jsonText = jsonMatch[0];
  }

  // Basic cleanup for control characters
  // eslint-disable-next-line no-control-regex
  jsonText = jsonText.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

  const parsed = JSON.parse(jsonText);
  debugLogger.ai(`JSON parsed successfully`);

  const validated = schema.parse(parsed);
  debugLogger.ai(`Schema validation successful`);

  return validated;
}
/**
 * Create or get an AI session for context caching
 * @param {string} sessionId - Unique session identifier
 * @param {object} aiConfig - AI configuration
 * @returns {AISessionV2} - AI session instance
 */
export function getAISessionV2(sessionId, aiConfig) {
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, new AISessionV2(sessionId, aiConfig));
  }
  return activeSessions.get(sessionId);
}
/**
 * Close and clean up an AI session
 * @param {string} sessionId - Session to close
 * @returns {object} - Final session metrics
 */
export function closeAISessionV2(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    const metrics = session.getMetrics();
    activeSessions.delete(sessionId);
    debugLogger.ai(`Session ${sessionId} closed - Metrics: ${JSON.stringify(metrics)}`);
    return metrics;
  }
  return null;
}
/**
 * Backwards-compatible callAI function using the new implementation
 */
export async function callAI(prompt, schema, aiConfig) {
  return aiLimiter(async () => {
    let lastError = null;

    debugLogger.ai(`callAI - Using V2 implementation`);
    debugLogger.ai(`Provider: ${aiConfig.provider || 'ollama'}`);
    debugLogger.ai(`Prompt length: ${prompt.length} characters`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await delay(300);
      try {
        // Create a temporary session for this call
        const tempSession = new AISessionV2(`temp-${Date.now()}`, aiConfig);

        // For backwards compatibility, treat the entire prompt as user message
        const result = await tempSession.call(prompt, schema);

        return result;
      } catch (e) {
        lastError = e;
        console.error(`[AI ERROR] Attempt ${attempt} failed: ${e.message}`);

        if (attempt < 3) {
          console.error(`[AI] Retrying in ${1000 * attempt}ms...`);
          await delay(1000 * attempt);
        }
      }
    }

    console.error(`[AI FATAL] All attempts failed. Last error: ${lastError?.message}`);
    return null;
  });
}
