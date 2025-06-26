// call_ai.js
// Centralized AI call abstraction for site2rag
// Accepts a prompt, a Zod schema, and aiConfig; returns validated JSON result.
// Removed unused zod import
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import logger from '../services/logger_service.js';
import debugLogger from '../services/debug_logger.js';

// Global limiter: 10 concurrent AI calls at a time
export const aiLimiter = pLimit(10);
// Session management for context caching
const activeSessions = new Map();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * AI Session for context caching optimization
 */
export class AISession {
  constructor(sessionId, aiConfig) {
    this.sessionId = sessionId;
    this.aiConfig = aiConfig;
    this.conversationHistory = [];
    this.cachedContext = '';
    this.cacheMetrics = {hits: 0, misses: 0};
    this.lastUsed = Date.now();
  }
  /**
   * Add a cached context that will be reused across multiple calls
   * @param {string} context - Context to cache (metadata, rules, etc)
   */
  setCachedContext(context) {
    this.cachedContext = context;
    this.lastUsed = Date.now();
  }
  /**
   * Make an AI call with cached context automatically prepended
   * @param {string} prompt - Additional prompt content
   * @param {object} schema - Zod schema for validation
   * @returns {Promise<any>} - Parsed response
   */
  async call(prompt, schema) {
    this.lastUsed = Date.now();
    const fullPrompt = this.cachedContext ? `${this.cachedContext}\n\n${prompt}` : prompt;

    // Log prompt sizes for debugging
    debugLogger.ai(
      `Session ${this.sessionId} - Cached context: ${this.cachedContext ? this.cachedContext.length : 0} chars`
    );
    debugLogger.ai(`Session ${this.sessionId} - Additional prompt: ${prompt.length} chars`);
    debugLogger.ai(`Session ${this.sessionId} - Total prompt: ${fullPrompt.length} chars`);

    this.conversationHistory.push({prompt: fullPrompt, timestamp: Date.now()});
    try {
      const result = await callAI(fullPrompt, schema, this.aiConfig);
      if (this.cachedContext) this.cacheMetrics.hits++;
      return result;
    } catch (error) {
      if (this.cachedContext) this.cacheMetrics.misses++;
      throw error;
    }
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
      conversationLength: this.conversationHistory.length,
      lastUsed: this.lastUsed
    };
  }
}
/**
 * Create or get an AI session for context caching
 * @param {string} sessionId - Unique session identifier
 * @param {object} aiConfig - AI configuration
 * @returns {AISession} - AI session instance
 */
export function getAISession(sessionId, aiConfig) {
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, new AISession(sessionId, aiConfig));
  }
  return activeSessions.get(sessionId);
}
/**
 * Close and clean up an AI session
 * @param {string} sessionId - Session to close
 * @returns {object} - Final session metrics
 */
export function closeAISession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    const metrics = session.getMetrics();
    activeSessions.delete(sessionId);
    return metrics;
  }
  return null;
}
/**
 * Clean up inactive sessions (older than 5 minutes)
 */
export function cleanupInactiveSessions() {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.lastUsed < fiveMinutesAgo) {
      activeSessions.delete(sessionId);
    }
  }
}
/**
 * Low-level AI call function
 * @param {string} prompt - Prompt to send to the AI
 * @param {object} aiConfig - AI config (provider, host, model, etc)
 * @returns {Promise<string>} - Raw response text
 */
async function makeAICall(prompt, aiConfig, expectPlainText = false) {
  const provider = aiConfig.provider || 'ollama';

  debugLogger.ai(`makeAICall - Provider: ${provider}`);

  if (provider === 'ollama') {
    const model = aiConfig.model || process.env.OLLAMA_MODEL || 'llama3.2:latest';
    const host = aiConfig.host || process.env.OLLAMA_HOST || 'http://localhost:11434';

    debugLogger.ai(`Ollama - Model: ${model}, Host: ${host}`);

    // Create timeout promise
    const timeoutMs = aiConfig.timeout || 30000; // 30 second default timeout for Ollama
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const requestBody = {
      model,
      prompt,
      stream: false,
      ...(expectPlainText ? {} : {format: 'json'}), // Only request JSON format when not expecting plain text
      options: {
        temperature: 0.1, // Lower temperature for more structured output
        top_p: 0.9,
        repeat_penalty: 1.1
      }
    };

    debugLogger.ai(`Ollama - Request URL: ${host}/api/generate`);
    debugLogger.ai(`Ollama - Request body: ${JSON.stringify(requestBody, null, 2)}`);

    // Create the fetch promise
    const fetchPromise = fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(requestBody)
    }).catch(fetchError => {
      console.error(`[AI ERROR] Ollama - Network error:`, fetchError);
      throw new Error(`Ollama network error: ${fetchError.message}`);
    });

    // Race between fetch and timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]);

    debugLogger.ai(`Ollama - Response status: ${response.status}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[AI ERROR] Ollama - API error: ${response.status} ${response.statusText}`);
      console.error(`[AI ERROR] Ollama - Error body:`, errorBody);
      throw new Error(`Ollama AI request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    debugLogger.ai(`Ollama - Response data keys: ${Object.keys(data).join(', ')}`);
    debugLogger.ai(`Ollama - Response length: ${(data.response || '').length}`);

    if (!data.response) {
      console.error(`[AI ERROR] Ollama - No response field in data:`, data);
      throw new Error(`Ollama response missing 'response' field`);
    }

    return data.response;
  }

  if (provider === 'anthropic') {
    const model = aiConfig.model || 'claude-3-haiku-20240307';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('Anthropic API key is required for anthropic provider');
    }

    // Create timeout promise
    const timeoutMs = aiConfig.timeout || 15000; // 15 second default for API
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // Log large prompts for debugging
    if (prompt.length > 5000) {
      debugLogger.ai(`[ANTHROPIC] Large prompt detected: ${prompt.length} chars`);
    }

    // Create the fetch promise
    const fetchPromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        top_p: 0.9
      })
    });

    // Race between fetch and timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    return data.content[0].text || '';
  }

  if (provider === 'openai') {
    const model = aiConfig.model || 'gpt-4o';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('OpenAI API key is required for openai provider');
    }

    const timeoutMs = aiConfig.timeout || 30000; // 30 second default for OpenAI
    debugLogger.ai(`OpenAI - Timeout set to ${timeoutMs}ms (config: ${aiConfig.timeout}ms)`);
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
        messages: [{role: 'user', content: prompt}],
        max_tokens: 4000,
        temperature: 0.1,
        top_p: 0.9,
        ...(expectPlainText ? {} : {response_format: {type: 'json_object'}}) // Only request JSON format when not expecting plain text
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    return data.choices[0].message.content || '';
  }

  if (provider === 'mistral') {
    const model = aiConfig.model || 'mistral-large-latest';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('Mistral API key is required for mistral provider');
    }

    const timeoutMs = aiConfig.timeout || 30000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const fetchPromise = fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{role: 'user', content: prompt}],
        max_tokens: 4000,
        temperature: 0.1,
        top_p: 0.9
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Mistral API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    return data.choices[0].message.content || '';
  }

  if (provider === 'perplexity') {
    const model = aiConfig.model || 'llama-3.1-sonar-large-128k-online';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('Perplexity API key is required for perplexity provider');
    }

    const timeoutMs = aiConfig.timeout || 30000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const fetchPromise = fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{role: 'user', content: prompt}],
        max_tokens: 4000,
        temperature: 0.1,
        top_p: 0.9
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Perplexity API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    return data.choices[0].message.content || '';
  }

  if (provider === 'xai') {
    const model = aiConfig.model || 'grok-beta';
    const apiKey = aiConfig.apiKey;

    if (!apiKey) {
      throw new Error('xAI API key is required for xai provider');
    }

    const timeoutMs = aiConfig.timeout || 30000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const fetchPromise = fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{role: 'user', content: prompt}],
        max_tokens: 4000,
        temperature: 0.1,
        top_p: 0.9
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`xAI API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    return data.choices[0].message.content || '';
  }

  throw new Error(`Provider ${provider} not implemented`);
}

/**
 * callAI - Centralized AI call for the app
 * @param {string} prompt - Prompt to send to the AI
 * @param {ZodSchema} schema - Zod schema for response validation
 * @param {object} aiConfig - AI config (provider, host, model, etc)
 * @returns {Promise<any>} - Parsed/validated response or null
 */
export async function callAI(prompt, schema, aiConfig) {
  return aiLimiter(async () => {
    let lastError = null;

    debugLogger.ai(`Starting AI call with provider: ${aiConfig.provider || 'ollama'}`);
    debugLogger.ai(`Model: ${aiConfig.model || 'default'}`);
    debugLogger.ai(`Host: ${aiConfig.host || 'default'}`);
    debugLogger.ai(`Prompt length: ${prompt.length} characters`);

    // Log first 500 chars of prompt for debugging large prompts
    if (prompt.length > 5000) {
      debugLogger.ai(`Large prompt detected! First 500 chars: ${prompt.substring(0, 500)}...`);
      debugLogger.ai(`Last 500 chars: ...${prompt.substring(prompt.length - 500)}`);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Only delay on retries, not the first attempt
      if (attempt > 1) {
        await delay(1000 * attempt); // Exponential backoff on retries
      }
      try {
        // Check if we're expecting plain text before making the call
        const expectPlainText = schema._def && schema._def.typeName === 'ZodString';
        
        debugLogger.ai(`Attempt ${attempt}: Making AI call... (expectPlainText: ${expectPlainText})`);
        const responseText = await makeAICall(prompt, aiConfig, expectPlainText);
        debugLogger.ai(`Attempt ${attempt}: Received response, length: ${responseText.length}`);
        debugLogger.ai(`Raw response (first 200 chars): ${responseText.substring(0, 200)}...`);

        // Check if schema expects plain text (string) response
        if (schema._def && schema._def.typeName === 'ZodString') {
          debugLogger.ai(`Schema expects plain text response, skipping JSON parsing`);
          const validated = schema.parse(responseText.trim());
          debugLogger.ai(`Plain text validation successful`);
          return validated;
        }

        // For object schemas, try to extract JSON from the response
        let jsonText = responseText.trim();

        // Handle cases where AI returns JSON wrapped in markdown code blocks
        // Updated regex to handle ```json{ case without space/newline
        const codeBlockMatch = jsonText.match(/```(?:json)?(\s*)([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
          debugLogger.ai(`Found JSON in code blocks`);
          jsonText = codeBlockMatch[2].trim();
        }

        // Try to find JSON object in the response
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          debugLogger.ai(`Extracted JSON object`);
          jsonText = jsonMatch[0];
        }

        // Basic cleanup for control characters only
        // eslint-disable-next-line no-control-regex
        jsonText = jsonText.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

        debugLogger.ai(`Final JSON text (first 200 chars): ${jsonText.substring(0, 200)}...`);
        
        // Log more details when parsing fails
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch (parseError) {
          console.error(`[AI ERROR] JSON.parse failed with: ${parseError.message}`);
          console.error(`[AI ERROR] JSON length: ${jsonText.length} characters`);
          
          // Find the error position
          const match = parseError.message.match(/position (\d+)/);
          if (match) {
            const errorPos = parseInt(match[1]);
            const contextStart = Math.max(0, errorPos - 100);
            console.error(`[AI ERROR] Context around position ${errorPos}:`);
            console.error(`[AI ERROR] Before: "${jsonText.substring(contextStart, errorPos)}"`);
            console.error(`[AI ERROR] At error: "${jsonText.substring(errorPos, errorPos + 10)}..."`);
            console.error(`[AI ERROR] Character at position ${errorPos}: "${jsonText.charAt(errorPos)}" (code: ${jsonText.charCodeAt(errorPos)})`);
            
            // Log the full response for debugging
            if (jsonText.length < 5000) {
              console.error(`[AI ERROR] Full response:\n${jsonText}`);
            } else {
              console.error(`[AI ERROR] Response too long (${jsonText.length} chars), showing first 2000:\n${jsonText.substring(0, 2000)}...`);
            }
          }
          throw parseError;
        }
        debugLogger.ai(`JSON parsed successfully`);

        const validated = schema.parse(parsed);
        debugLogger.ai(`Schema validation successful`);
        return validated;
      } catch (e) {
        lastError = e;
        console.error(`[AI ERROR] Attempt ${attempt} failed:`);
        console.error(`[AI ERROR] Error type: ${e.constructor.name}`);
        console.error(`[AI ERROR] Error message: ${e.message}`);

        if (e.name === 'ZodError') {
          console.error(`[AI ERROR] Zod validation error details:`, JSON.stringify(e.errors, null, 2));
        }

        if (e.message.includes('Unexpected token') || e.message.includes('Expected')) {
          console.error(`[AI ERROR] JSON parsing failed - likely malformed JSON response`);
          console.error(`[AI ERROR] Error occurred at: ${e.message}`);
        }

        if (e.message.includes('timed out')) {
          console.error(`[AI ERROR] Request timed out - check network/model availability`);
          console.error(
            `[AI ERROR] Timeout occurred after ${aiConfig.timeout || 30000}ms for prompt of ${prompt.length} chars`
          );
        }

        if (e.message.includes('API request failed')) {
          console.error(`[AI ERROR] API request failed - check provider configuration`);
        }

        console.error(`[AI ERROR] Full error stack:`, e.stack);

        if (attempt < 3) {
          console.error(`[AI] Will retry attempt ${attempt + 1}...`);
          // Delay is handled at the start of the loop
        } else {
          console.error(`[AI FATAL] All 3 attempts failed. Unable to get valid AI response.`);
          logger.error(`AI response validation failed after 3 attempts: ${e.message}`);
        }
      }
    }

    console.error(`[AI FATAL] Returning null after all attempts failed`);
    console.error(`[AI FATAL] Last error was: ${lastError?.message || 'Unknown error'}`);
    return null;
  });
}
