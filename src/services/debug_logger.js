/**
 * Centralized debug logging service for site2rag
 * Automatically handles test mode, debug mode, and production filtering
 */
export class DebugLogger {
  constructor() {
    this.isTestMode = process.env.NODE_ENV === 'test';
    this.isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
    this.isProduction = !this.isTestMode && !this.isDebugMode;
    
    // Support namespace-based debugging like DEBUG=ai
    this.debugNamespaces = process.env.DEBUG ? process.env.DEBUG.split(',').map(n => n.trim().toLowerCase()) : [];
  }

  /**
   * Log debug information (only in test/debug mode)
   * @param {string} category - Log category (e.g., 'BATCHING', 'KEYED', 'AI')
   * @param {string} message - Log message
   */
  debug(category, message) {
    const categoryLower = category.toLowerCase();
    const shouldLog = this.isTestMode || 
                     this.isDebugMode || 
                     this.debugNamespaces.includes(categoryLower) ||
                     this.debugNamespaces.includes('*');
                     
    if (shouldLog) {
      console.log(`[${category}] ${message}`);
    }
  }

  /**
   * Log informational messages (all modes except production silenced)
   * @param {string} category - Log category
   * @param {string} message - Log message
   */
  info(category, message) {
    if (!this.isProduction) {
      console.log(`[${category}] ${message}`);
    }
  }

  /**
   * Log warnings (always shown)
   * @param {string} category - Log category
   * @param {string} message - Log message
   */
  warn(category, message) {
    console.warn(`[${category}] ⚠️  ${message}`);
  }

  /**
   * Log errors (always shown)
   * @param {string} category - Log category
   * @param {string} message - Log message
   */
  error(category, message) {
    console.error(`[${category}] ❌ ${message}`);
  }

  /**
   * Log success messages (always shown)
   * @param {string} category - Log category
   * @param {string} message - Log message
   */
  success(category, message) {
    console.log(`[${category}] ✓ ${message}`);
  }

  /**
   * Shorthand methods for common categories
   */
  batching(message) {
    this.debug('BATCHING', message);
  }
  keyed(message) {
    this.debug('KEYED', message);
  }
  ai(message) {
    this.debug('AI', message);
  }
  context(message) {
    this.debug('CONTEXT', message);
  }
  cache(message) {
    this.debug('CACHE', message);
  }
  validation(message) {
    this.debug('VALIDATION', message);
  }
  entities(message) {
    this.debug('ENTITIES', message);
  }
  insertions(message) {
    this.debug('INSERTIONS', message);
  }
  crawl(message) {
    this.debug('CRAWL', message);
  }
  progress(message) {
    this.debug('PROGRESS', message);
  }
  direct(message) {
    this.debug('DIRECT_PROCESSING', message);
  }
  sliding(message) {
    this.debug('SLIDING_CACHE', message);
  }
  batch(message) {
    this.debug('BATCH', message);
  }
  disambiguation(message) {
    this.debug('DISAMBIGUATION', message);
  }
}

// Export singleton instance
export const debugLogger = new DebugLogger();

// Export default for convenience
export default debugLogger;
