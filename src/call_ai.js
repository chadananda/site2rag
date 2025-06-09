// call_ai.js
// Centralized AI call abstraction for site2rag
// Accepts a prompt, a Zod schema, and aiConfig; returns validated JSON result.
import { z } from 'zod';
import { classifyBlocksWithAI } from './ai_assist.js';
import pLimit from 'p-limit';

// Global limiter: only 3 concurrent AI calls at a time
export const aiLimiter = pLimit(3);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        const responseText = await classifyBlocksWithAI([prompt], aiConfig);
        const parsed = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
        return schema.parse(parsed);
      } catch (e) {
        lastError = e;
        if (attempt < 3) {
          // Optionally log retry info
          await delay(500); // Wait a bit longer before retry
        } else {
          console.error('AI response validation failed after 3 attempts:', e);
        }
      }
    }
    return null;
  });
}
