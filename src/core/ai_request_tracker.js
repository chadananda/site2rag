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
  }

  /**
   * Initialize the tracker with documents to process
   * @param {Array} documents - Array of documents with blocks
   * @param {Function} progressCallback - Progress callback(completed, total)
   */
  initialize(documents, progressCallback) {
    this.progressCallback = progressCallback;
    this.isInitialized = true;
    this.totalExpected = 0;
    this.totalCompleted = 0;
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

    debugLogger.ai(`[AI-TRACKER] Initialized with ${documents.length} documents, expecting ~${this.totalExpected} AI requests`);
    
    // Notify initial progress
    if (this.progressCallback) {
      this.progressCallback(0, this.totalExpected);
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
      const text = typeof block === 'string' ? block : block.text || block;
      const trimmed = text.trim();
      
      // Skip empty blocks
      if (!trimmed) return false;
      
      // Skip headers
      if (trimmed.startsWith('#')) return false;
      
      // Skip code blocks
      if (trimmed.startsWith('```') || trimmed.match(/^(\s{4}|\t)/)) return false;
      
      // Skip very short blocks (less than 100 chars)
      if (trimmed.length < 100) return false;
      
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
    for (const [docId, actual] of this.documentActuals) {
      newTotal += actual;
    }
    
    // Add estimates for documents we haven't processed yet
    for (const [docId, estimate] of this.documentEstimates) {
      if (!this.documentActuals.has(docId)) {
        newTotal += estimate;
      }
    }
    
    // Update total if it changed
    if (newTotal !== this.totalExpected && newTotal > 0) {
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
   */
  trackCompletion(docId = null) {
    // docId parameter kept for future use
    this.totalCompleted++;
    
    debugLogger.ai(`[AI-TRACKER] Request completed: ${this.totalCompleted}/${this.totalExpected}`);
    
    // Notify progress
    if (this.progressCallback) {
      this.progressCallback(this.totalCompleted, this.totalExpected);
    }
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