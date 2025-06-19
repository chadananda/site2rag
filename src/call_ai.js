// call_ai.js
// Centralized AI call abstraction for site2rag
// Accepts a prompt, a Zod schema, and aiConfig; returns validated JSON result.
import { z } from 'zod';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import logger from './services/logger_service.js';

// Global limiter: only 3 concurrent AI calls at a time
export const aiLimiter = pLimit(3);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model, 
        prompt, 
        stream: false,
        options: {
          temperature: 0.7
        }
      }),
      timeout: 60000 // 60 second timeout for context processing
    });
    
    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.response || '';
  }
  
  // TODO: Add other providers (OpenAI, Anthropic, etc.)
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
        
        const parsed = JSON.parse(jsonText);
        return schema.parse(parsed);
      } catch (e) {
        lastError = e;
        if (attempt < 3) {
          logger.debug(`AI call attempt ${attempt} failed: ${e.message}, retrying...`);
          await delay(1000 * attempt); // Exponential backoff
        } else {
          logger.error(`AI response validation failed after 3 attempts: ${e.message}`);
        }
      }
    }
    return null;
  });
}
