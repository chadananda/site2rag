// performance.js
// Performance optimization utilities
/**
 * Pre-compiled regex patterns for better performance
 */
export const COMPILED_PATTERNS = {
  // Content cleaning patterns
  codeBlocks: /```[\s\S]*?```/g,
  indentedCode: /^(\s{4}|\t).+$/gm,
  images: /!\[([^\]]*)\]\([^)]+\)/g,
  links: /\[([^\]]+)\]\([^)]+\)/g,
  htmlTags: /<[^>]+>/g,
  whitespace: /\s+/g,
  // Validation patterns
  contextMarkers: /\[\[.*?\]\]/g,
  headerStart: /^#/,
  codeStart: /^```/,
  indentStart: /^(\s{4}|\t)/
};
/**
 * Performance metrics tracker
 */
export class PerformanceTracker {
  constructor() {
    this.metrics = {
      windowProcessing: [],
      blockMatching: [],
      validation: [],
      aiCalls: [],
      totalTime: 0
    };
    this.startTime = Date.now();
  }
  /**
   * Start timing an operation
   * @param {string} operation - Operation name
   * @returns {Function} End timer function
   */
  startTimer(operation) {
    const start = Date.now();
    return () => {
      const elapsed = Date.now() - start;
      if (!this.metrics[operation]) {
        this.metrics[operation] = [];
      }
      this.metrics[operation].push(elapsed);
      return elapsed;
    };
  }
  /**
   * Get performance summary
   * @returns {Object} Performance metrics summary
   */
  getSummary() {
    const summary = {
      totalTime: Date.now() - this.startTime,
      operations: {}
    };
    for (const [operation, times] of Object.entries(this.metrics)) {
      if (Array.isArray(times) && times.length > 0) {
        summary.operations[operation] = {
          count: times.length,
          total: times.reduce((a, b) => a + b, 0),
          average: times.reduce((a, b) => a + b, 0) / times.length,
          min: Math.min(...times),
          max: Math.max(...times)
        };
      }
    }
    return summary;
  }
}
/**
 * Block matcher using hash map for O(1) lookup
 */
export class BlockMatcher {
  constructor() {
    this.originalBlocks = new Map();
    this.normalizedToOriginal = new Map();
  }
  /**
   * Add original blocks to the matcher
   * @param {Object} blocks - Object with block keys and content
   */
  addOriginalBlocks(blocks) {
    for (const [key, content] of Object.entries(blocks)) {
      this.originalBlocks.set(key, content);
      // Create normalized version for matching
      const normalized = this.normalizeForMatching(content);
      this.normalizedToOriginal.set(normalized, key);
    }
  }
  /**
   * Normalize text for matching (remove extra whitespace, lowercase)
   * @param {string} text - Text to normalize
   * @returns {string} Normalized text
   */
  normalizeForMatching(text) {
    return text
      .replace(COMPILED_PATTERNS.whitespace, ' ')
      .trim()
      .toLowerCase()
      .substring(0, 100); // Use first 100 chars as key
  }
  /**
   * Find matching original block for enhanced text
   * @param {string} enhancedText - Enhanced text with [[context]] markers
   * @returns {Object} {key, originalText} or null
   */
  findMatch(enhancedText) {
    // Remove context markers for matching
    const withoutMarkers = enhancedText.replace(COMPILED_PATTERNS.contextMarkers, '');
    const normalized = this.normalizeForMatching(withoutMarkers);
    const key = this.normalizedToOriginal.get(normalized);
    if (key) {
      return {
        key,
        originalText: this.originalBlocks.get(key)
      };
    }
    // Fallback: Try fuzzy matching if exact match fails
    const enhancedWords = normalized.split(' ').slice(0, 10); // First 10 words
    for (const [origNormalized, origKey] of this.normalizedToOriginal) {
      const origWords = origNormalized.split(' ').slice(0, 10);
      // Check if at least 70% of words match
      const matchCount = enhancedWords.filter(word => origWords.includes(word)).length;
      if (matchCount >= enhancedWords.length * 0.7) {
        return {
          key: origKey,
          originalText: this.originalBlocks.get(origKey)
        };
      }
    }
    return null;
  }
}
/**
 * Validation cache to avoid duplicate validation calls
 */
export class ValidationCache {
  constructor() {
    this.cache = new Map();
  }
  /**
   * Generate cache key for validation
   * @param {string} original - Original text
   * @param {string} enhanced - Enhanced text
   * @returns {string} Cache key
   */
  getCacheKey(original, enhanced) {
    // Use first 50 chars of each for the key
    const origKey = original.substring(0, 50);
    const enhKey = enhanced.substring(0, 50);
    return `${origKey}::${enhKey}`;
  }
  /**
   * Get cached validation result
   * @param {string} original - Original text
   * @param {string} enhanced - Enhanced text
   * @returns {Object|null} Cached result or null
   */
  get(original, enhanced) {
    const key = this.getCacheKey(original, enhanced);
    return this.cache.get(key) || null;
  }
  /**
   * Set validation result in cache
   * @param {string} original - Original text
   * @param {string} enhanced - Enhanced text
   * @param {Object} result - Validation result
   */
  set(original, enhanced, result) {
    const key = this.getCacheKey(original, enhanced);
    this.cache.set(key, result);
  }
  /**
   * Clear cache (for memory management)
   */
  clear() {
    this.cache.clear();
  }
}
/**
 * Memory-efficient text accumulator for sliding windows
 */
export class TextAccumulator {
  constructor(maxWords = 2000) {
    this.words = [];
    this.maxWords = maxWords;
  }
  /**
   * Add text to accumulator
   * @param {string} text - Text to add
   */
  add(text) {
    if (!text) return;
    const newWords = text.split(COMPILED_PATTERNS.whitespace).filter(w => w.length > 0);
    this.words.push(...newWords);
    // Trim to max size
    if (this.words.length > this.maxWords) {
      this.words = this.words.slice(-this.maxWords);
    }
  }
  /**
   * Get recent context
   * @param {number} wordCount - Number of words to get
   * @returns {string} Recent context
   */
  getContext(wordCount) {
    const start = Math.max(0, this.words.length - wordCount);
    return this.words.slice(start).join(' ');
  }
  /**
   * Clear accumulator
   */
  clear() {
    this.words = [];
  }
}