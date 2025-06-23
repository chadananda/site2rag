// call_ai.js
// Centralized AI call abstraction for site2rag
// Accepts a prompt, a Zod schema, and aiConfig; returns validated JSON result.
// Removed unused zod import
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import logger from '../services/logger_service.js';

// Global limiter: only 3 concurrent AI calls at a time
export const aiLimiter = pLimit(3);
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
async function makeAICall(prompt, aiConfig) {
  const provider = aiConfig.provider || 'ollama';

  if (provider === 'ollama') {
    const model = aiConfig.model || process.env.OLLAMA_MODEL || 'llama3.2:latest';
    const host = aiConfig.host || process.env.OLLAMA_HOST || 'http://localhost:11434';

    // Create timeout promise
    const timeoutMs = aiConfig.timeout || 20000; // 20 second default timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // Create the fetch promise
    const fetchPromise = fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json', // Request JSON format
        options: {
          temperature: 0.1, // Lower temperature for more structured output
          top_p: 0.9,
          repeat_penalty: 1.1
        }
      })
    });

    // Race between fetch and timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.response || '';
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
        top_p: 0.9
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
    for (let attempt = 1; attempt <= 3; attempt++) {
      await delay(300); // Spread out requests to avoid throttling
      try {
        const responseText = await makeAICall(prompt, aiConfig);

        // Try to extract JSON from the response
        let jsonText = responseText.trim();

        // Handle cases where AI returns JSON wrapped in markdown code blocks
        const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1].trim();
        }

        // Try to find JSON object in the response
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }

        // Basic cleanup for control characters only
        jsonText = jsonText.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

        const parsed = JSON.parse(jsonText);
        return schema.parse(parsed);
      } catch (e) {
        // lastError = e; // Removed unused variable
        if (attempt < 3) {
          console.log(`[AI] Call attempt ${attempt} failed: ${e.message}, retrying...`);
          await delay(1000 * attempt); // Exponential backoff
        } else {
          logger.error(`AI response validation failed after 3 attempts: ${e.message}`);
        }
      }
    }
    return null;
  });
}
