// ai_request_tracker.js
// Shared tracker for AI request counting across all processors
import debugLogger from '../services/debug_logger.js';

/**
 * Global AI request tracker that coordinates counting between parallel and batch processors
 */
export class AIRequestTracker {
  constructor() {
    this.totalExpected = 0;
    this.totalCompleted = 0;
    this.documentEstimates = new Map(); // docId -> estimated requests
    this.documentActuals = new Map(); // docId -> actual requests
    this.progressCallback = null;
    this.isInitialized = false;
    // Token tracking
    this.totalTokensUsed = 0;
    this.totalCost = 0;
    this.tokenDetails = []; // Array of {prompt_tokens, completion_tokens, cost}
    this.currentModel = null; // Track current model for pricing
    // Simple mutex implementation for critical sections
    this._lockPromise = Promise.resolve();
  }

  /**
   * Acquire lock for critical section
   * @private
   */
  async _acquireLock() {
    const prevLock = this._lockPromise;
    let releaseLock;
    this._lockPromise = new Promise(resolve => {
      releaseLock = resolve;
    });
    await prevLock;
    return releaseLock;
  }

  /**
   * Initialize the tracker with documents to process
   * @param {Array} documents - Array of documents with blocks
   * @param {Function} progressCallback - Progress callback(completed, total)
   */
  async initialize(documents, progressCallback) {
    const release = await this._acquireLock();
    try {
      this.progressCallback = progressCallback;
      this.isInitialized = true;
      // Preserve completed count for cumulative tracking
      const previousCompleted = this.totalCompleted || 0;
      this.totalExpected = 0;
      this.totalCompleted = previousCompleted; // Keep cumulative count
      this.documentEstimates.clear();
      this.documentActuals.clear();

      // Calculate expected requests for each document
      for (const doc of documents) {
        const eligibleBlocks = this.countEligibleBlocks(doc.blocks);
        // Estimate windows based on ~5 blocks per window (600 word windows)
        // Only create windows if there are eligible blocks
        const estimatedWindows = eligibleBlocks > 0 ? Math.max(1, Math.ceil(eligibleBlocks / 5)) : 0;
        this.documentEstimates.set(doc.docId || doc.url, estimatedWindows);
        this.totalExpected += estimatedWindows;
      }

      // Ensure initial total is at least as high as cumulative completed
      if (this.totalExpected < this.totalCompleted) {
        this.totalExpected = this.totalCompleted;
      }

      debugLogger.ai(
        `[AI-TRACKER] Initialized with ${documents.length} documents, expecting ~${this.totalExpected} AI requests (${this.totalCompleted} already completed)`
      );

      // Notify initial progress with cumulative counts
      if (this.progressCallback) {
        this.progressCallback(this.totalCompleted, this.totalExpected);
      }
    } finally {
      release();
    }
  }

  /**
   * Count eligible blocks that will be processed
   * @param {Array} blocks - Document blocks
   * @returns {number} Number of eligible blocks
   */
  countEligibleBlocks(blocks) {
    if (!blocks || !Array.isArray(blocks)) return 0;

    return blocks.filter(block => {
      const text = typeof block === 'string' ? block : block.text || '';
      // Ensure text is a string before calling trim
      if (typeof text !== 'string') return false;
      const trimmed = text.trim();

      // Skip empty blocks
      if (!trimmed) return false;

      // Skip headers
      if (trimmed.startsWith('#')) return false;

      // Skip code blocks
      if (trimmed.startsWith('```') || trimmed.match(/^(\s{4}|\t)/)) return false;

      // Skip very short blocks (less than 20 chars) - match MIN_BLOCK_CHARS in processor
      if (trimmed.length < 20) return false;

      // Skip image blocks
      if (trimmed.startsWith('![')) return false;

      return true;
    }).length;
  }

  /**
   * Update the actual request count for a document
   * @param {string} docId - Document ID
   * @param {number} actualRequests - Actual number of requests for this document
   */
  updateDocumentActual(docId, actualRequests) {
    // Store the docId for reference
    const previousActual = this.documentActuals.get(docId) || 0;
    this.documentActuals.set(docId, actualRequests);

    // If this is a new document or the count changed, recalculate total
    if (previousActual !== actualRequests) {
      this.recalculateTotal();
    }
  }

  /**
   * Recalculate the total expected requests based on actual counts
   */
  recalculateTotal() {
    let newTotal = 0;

    // Add up all actual counts we know
    for (const [, actual] of this.documentActuals) {
      newTotal += actual;
    }

    // Add estimates for documents we haven't processed yet
    for (const [docId, estimate] of this.documentEstimates) {
      if (!this.documentActuals.has(docId)) {
        newTotal += estimate;
      }
    }

    // Always ensure total is at least as high as completed count
    // This prevents the absurd situation of showing more completed than total
    newTotal = Math.max(newTotal, this.totalCompleted);

    // Only update if the new total is higher than current
    // This prevents the total from jumping down as we get actuals
    if (newTotal > this.totalExpected) {
      this.totalExpected = newTotal;
      debugLogger.ai(`[AI-TRACKER] Updated total expected requests to ${this.totalExpected}`);

      // Notify progress with new total
      if (this.progressCallback) {
        this.progressCallback(this.totalCompleted, this.totalExpected);
      }
    }
  }

  /**
   * Track a completed AI request
   * @param {string} docId - Document ID (optional)
   * @param {Object} usage - Token usage data from AI response
   */
  async trackCompletion(_docId = null, usage = null) {
    const release = await this._acquireLock();
    try {
      // docId parameter kept for future use
      this.totalCompleted++;
      
      // Track token usage if provided
      if (usage) {
        const cost = this.calculateCost(usage);
        this.totalTokensUsed += (usage.total_tokens || 0);
        this.totalCost += cost;
        this.tokenDetails.push({
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          cost: cost
        });
      }

      // If we've exceeded our expected total, update it
      if (this.totalCompleted > this.totalExpected) {
        this.totalExpected = this.totalCompleted;
        debugLogger.ai(`[AI-TRACKER] Adjusting total to match completed: ${this.totalExpected}`);
      }

      debugLogger.ai(`[AI-TRACKER] Request completed: ${this.totalCompleted}/${this.totalExpected}`);

      // Notify progress
      if (this.progressCallback) {
        this.progressCallback(this.totalCompleted, this.totalExpected);
      }
    } finally {
      release();
    }
  }

  /**
   * Calculate cost based on token usage
   * @param {Object} usage - Token usage data
   * @returns {number} Cost in dollars
   */
  calculateCost(usage) {
    if (!usage || !usage.total_tokens) return 0;
    
    // Pricing per 1K tokens (add more models as needed)
    const pricing = {
      'gpt-4o': { prompt: 0.005, completion: 0.015 },
      'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
      'claude-3-haiku-20240307': { prompt: 0.00025, completion: 0.00125 },
      'claude-3-5-sonnet-20241022': { prompt: 0.003, completion: 0.015 },
      'mistral-large-latest': { prompt: 0.004, completion: 0.012 },
      'llama-3.1-sonar-large-128k-online': { prompt: 0.001, completion: 0.001 },
      'grok-beta': { prompt: 0.005, completion: 0.015 }
    };
    
    // Default pricing if model not found
    const defaultPrice = { prompt: 0.001, completion: 0.002 };
    const price = pricing[this.currentModel] || defaultPrice;
    
    const promptCost = (usage.prompt_tokens || 0) * price.prompt / 1000;
    const completionCost = (usage.completion_tokens || 0) * price.completion / 1000;
    
    return promptCost + completionCost;
  }

  /**
   * Set the current model being used (for pricing)
   * @param {string} model - Model name
   */
  setCurrentModel(model) {
    this.currentModel = model;
  }

  /**
   * Get current statistics
   * @returns {Object} Current tracking stats
   */
  getStats() {
    return {
      totalExpected: this.totalExpected,
      totalCompleted: this.totalCompleted,
      documentsProcessed: this.documentActuals.size,
      documentsTotal: this.documentEstimates.size,
      percentComplete: this.totalExpected > 0 ? Math.round((this.totalCompleted / this.totalExpected) * 100) : 0
    };
  }

  /**
   * Reset the tracker
   */
  reset() {
    this.totalExpected = 0;
    this.totalCompleted = 0;
    this.documentEstimates.clear();
    this.documentActuals.clear();
    this.progressCallback = null;
    this.isInitialized = false;
  }
}

// Export singleton instance
export const aiRequestTracker = new AIRequestTracker();
