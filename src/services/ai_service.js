import fetch from 'node-fetch';
import logger from './logger_service.js';

/**
 * Service for integrating with AI providers (defaults to Ollama)
 */
export class AIService {
  /**
   * Creates a new AI service instance
   * @param {Object} options - Configuration options
   * @param {string} options.provider - AI provider ('ollama', 'openai', 'anthropic')
   * @param {string} options.host - API host URL
   * @param {string} options.model - Default model to use
   * @param {number} options.timeout - Request timeout in milliseconds
   */
  constructor(options = {}) {
    this.provider = options.provider || 'ollama';
    this.host = options.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = options.model || process.env.OLLAMA_MODEL || 'qwen2.5:14b';
    this.fallbackModel = options.fallbackModel || 'llama3.1:8b';
    this.timeout = options.timeout || 60000; // 60 seconds for context analysis
    this.lastPrompt = null;
    this.lastModel = null;
  }

  /**
   * Checks if AI service is available and returns available models
   * @returns {Promise<{available: boolean, models: Array<string>}>}
   */
  async checkAvailability() {
    if (this.provider === 'ollama') {
      try {
        const res = await fetch(`${this.host}/api/tags`, { 
          timeout: 5000,
          signal: AbortSignal.timeout(5000)
        });
        
        if (!res.ok) {
          return { available: false, models: [] };
        }
        
        const data = await res.json();
        const models = data.models?.map(m => m.name) || [];
        
        return { available: true, models };
      } catch (error) {
        logger.debug(`AI service (${this.provider}) unavailable: ${error.message}`);
        return { available: false, models: [] };
      }
    }
    
    // TODO: Add checks for other providers (OpenAI, Anthropic, etc.)
    return { available: false, models: [] };
  }

  /**
   * Generates a response from the AI provider
   * @param {string} prompt - The prompt to send
   * @param {Object} options - Generation options
   * @returns {Promise<string>} - The generated response
   */
  async generate(prompt, options = {}) {
    const model = options.model || this.model;
    
    this.lastPrompt = prompt;
    this.lastModel = model;
    
    if (this.provider === 'ollama') {
      return await this._generateOllama(prompt, model, options);
    }
    
    // TODO: Add other providers
    throw new Error(`Provider ${this.provider} not implemented`);
  }

  /**
   * Generates response using Ollama
   * @private
   */
  async _generateOllama(prompt, model, options = {}) {
    const stream = options.stream || false;
    
    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream,
          options: {
            temperature: options.temperature || 0.7,
            ...options.modelOptions
          }
        }),
        timeout: this.timeout,
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!res.ok) {
        throw new Error(`AI request failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      return data.response || '';
    } catch (error) {
      logger.error(`AI generation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Classifies HTML content blocks using AI
   * @param {Array<string>} blocks - Array of HTML block strings
   * @param {Object} options - Classification options
   * @returns {Promise<Array<number>>} - Array of indices of blocks to remove
   */
  async classifyBlocks(blocks, options = {}) {
    if (!blocks || blocks.length === 0) {
      return [];
    }

    // Create concise representations of blocks
    const cheerio = await import('cheerio');
    const conciseBlocks = blocks.map((html, i) => {
      const $ = cheerio.load(html);
      const topElements = $('body').children();
      
      let el = topElements.length === 1 ? topElements.first() : topElements.first();
      
      const tagName = el.prop('tagName') || 'div';
      const className = el.attr('class') || '';
      const id = el.attr('id') || '';
      
      let selector = tagName.toLowerCase();
      if (id) selector += `#${id}`;
      if (className) {
        className.split(' ').forEach(cls => {
          if (cls.trim()) selector += `.${cls.trim()}`;
        });
      }
      
      const summary = $.text().trim().substring(0, 200);
      return `[${i}] <${selector}> ${summary}${summary.length >= 200 ? '...' : ''}`;
    });

    const prompt = `Given an array of HTML content blocks, return an array of block numbers (indices) that are NOT main content and should be deleted. Only return the array of numbers.

Blocks:
${conciseBlocks.join('\n')}`;

    try {
      const response = await this.generate(prompt, options);
      
      // Try to parse array of numbers from response
      const match = response.match(/\[(.*?)\]/);
      if (match) {
        return match[1]
          .split(',')
          .map(x => parseInt(x.trim()))
          .filter(x => !isNaN(x) && x >= 0 && x < blocks.length);
      }
      
      return [];
    } catch (error) {
      logger.error(`Block classification failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Enhances content with context injection
   * @param {string} content - Original content
   * @param {Object} context - Context information
   * @param {Object} options - Enhancement options
   * @returns {Promise<string>} - Enhanced content
   */
  async enhanceContent(content, context = {}, options = {}) {
    const prompt = `Enhance this content by adding helpful context and improving readability while preserving the original meaning:

${content}

Context: ${JSON.stringify(context, null, 2)}

Return only the enhanced content, no explanations.`;

    try {
      return await this.generate(prompt, options);
    } catch (error) {
      logger.error(`Content enhancement failed: ${error.message}`);
      return content; // Return original content on failure
    }
  }

  /**
   * Gets the best available model for a task
   * @param {string} task - The task type ('classification', 'enhancement', etc.)
   * @returns {Promise<string>} - The best model name
   */
  async getBestModel(task = 'general') {
    const availability = await this.checkAvailability();
    
    if (!availability.available || availability.models.length === 0) {
      throw new Error(`No AI models available for provider: ${this.provider}`);
    }

    // Prefer the configured model if available
    if (availability.models.includes(this.model)) {
      return this.model;
    }

    // Fall back to fallback model
    if (availability.models.includes(this.fallbackModel)) {
      return this.fallbackModel;
    }

    // Use the first available model
    return availability.models[0];
  }
}