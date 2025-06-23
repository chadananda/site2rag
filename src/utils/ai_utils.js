import fetch from 'node-fetch';
import logger from '../services/logger_service.js';

export async function aiServiceAvailable({provider = 'ollama', host} = {}) {
  if (provider === 'ollama') {
    const ollamaHost = host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    try {
      const res = await fetch(`${ollamaHost}/api/tags`, {timeout: 2000});
      return res.ok;
    } catch {
      return false;
    }
  }
  // Add future checks for other providers here
  return false;
}

// Store the last prompt for debugging purposes
export let lastPrompt = null;
export let lastModel = null;

/**
 * Classifies HTML blocks using AI to identify which ones are not main content
 * @param {Array<string>} blocks - Array of HTML block strings
 * @param {Object} opts - AI configuration options
 * @returns {Promise<Array<number>>} - Array of indices of blocks to remove
 */
export async function classifyBlocksWithAI(blocks, opts = {}) {
  const provider = opts.provider || 'ollama';
  if (provider === 'ollama') {
    const model = opts.model || process.env.OLLAMA_MODEL || 'llama3.2:latest';
    const host = opts.host || process.env.OLLAMA_HOST || 'http://localhost:11434';

    // Create a concise representation of each block for the AI using the agreed format: index, selector, summary
    const cheerio = await import('cheerio');
    const conciseBlocks = blocks.map((html, i) => {
      const $ = cheerio.load(html);
      const text = $.text().trim().substring(0, 150); // Get first 150 chars of text

      // Get the actual element, not the html root
      // First get all top-level elements in the fragment
      const topElements = $('body').children();

      // If there's only one top element, use that
      let el;
      if (topElements.length === 1) {
        el = topElements.first();
      } else {
        // If there are multiple elements, find the most significant one
        // (this is a simplification - we could improve this with more logic)
        el = topElements.first();
      }

      // Get element properties
      const tagName = el.prop('tagName') || 'div';
      const className = el.attr('class') || '';
      const id = el.attr('id') || '';

      // Create a full CSS-like selector with all classes
      let selector = tagName.toLowerCase();
      if (id) selector += `#${id}`;
      if (className) {
        // Add all classes, not just the first one
        className.split(' ').forEach(cls => {
          if (cls.trim()) selector += `.${cls.trim()}`;
        });
      }

      // Get up to 200 characters of text for the summary
      const summary = $.text().trim().substring(0, 200);

      // Format as [index] <selector> summary...
      return `[${i}] <${selector}> ${summary}${summary.length >= 200 ? '...' : ''}`;
    });

    const prompt =
      `Given an array of HTML content blocks, return an array of block numbers (indices) that are NOT main content and should be deleted. Only return the array of numbers.\nBlocks:\n` +
      conciseBlocks.join('\n');

    // Store the prompt and model for debugging
    lastPrompt = prompt;
    lastModel = model;

    logger.info(`[AI] Sending ${blocks.length} blocks to AI for classification`);

    try {
      const ollamaRes = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model, prompt, stream: false})
      });
      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        const out = data.response || '';
        // Try to parse array of numbers
        const match = out.match(/\[(.*?)\]/);
        if (match) {
          return match[1]
            .split(',')
            .map(x => parseInt(x.trim()))
            .filter(x => !isNaN(x));
        }
      }
    } catch (e) {
      /* fallback: ignore errors */
    }
    return [];
  }
  // Add future logic for Anthropic, GPT, etc. here.
  return [];
}

// Alias for compatibility with older code
export const classifyBlocksWithOllama = classifyBlocksWithAI;

// Alias for compatibility with site_processor.js
export const ollamaAvailable = aiServiceAvailable;
