/**
 * Logger Service - Centralized logging for site2rag
 * Controls all console output based on debug settings
 */

class LoggerService {
  constructor(options = {}) {
    this.debug = options.debug || false;
    this.verbose = options.verbose || false;
    this.logPrefix = options.prefix || '[SITE2RAG]';
    // Define log types with their properties
    this.logTypes = {
      // Always enabled in all modes
      INFO: { 
        prefix: '[INFO]', 
        color: '\x1b[36m', // Cyan
        enabled: true,
        // Hide info messages in production mode by default
        productionLevel: 'none' // 'all', 'critical', 'none'
      },
      WARN: { 
        prefix: '[WARN]', 
        color: '\x1b[33m', // Yellow
        enabled: true,
        productionLevel: 'all'
      },
      ERROR: { 
        prefix: '[ERROR]', 
        color: '\x1b[31m', // Red
        enabled: true,
        productionLevel: 'all'
      },
      
      // Debug-only log types - disabled in production mode
      DEBUG: { 
        prefix: '[DEBUG]', 
        color: '\x1b[35m', // Magenta
        enabled: false,
        productionLevel: 'none'
      },
      DOMAIN_FILTER: { 
        prefix: '[DOMAIN_FILTER]', 
        color: '\x1b[32m', // Green
        enabled: false,
        productionLevel: 'none'
      },
      CRAWL: { 
        prefix: '[CRAWL]', 
        color: '\x1b[34m', // Blue
        enabled: false,
        productionLevel: 'critical'
      },
      LINKS: { 
        prefix: '[LINKS]', 
        color: '\x1b[36m', // Cyan
        enabled: false,
        productionLevel: 'none'
      },
      CONTENT: { 
        prefix: '[CONTENT]', 
        color: '\x1b[35m', // Magenta
        enabled: false,
        productionLevel: 'none'
      },
      DECISION: { 
        prefix: '[DECISION]', 
        color: '\x1b[33m', // Yellow
        enabled: false,
        productionLevel: 'none'
      },
      CACHE: { 
        prefix: '[CACHE]', 
        color: '\x1b[90m', // Gray
        enabled: false,
        productionLevel: 'none'
      },
      MARKDOWN: { 
        prefix: '[MARKDOWN]', 
        color: '\x1b[36m', // Cyan
        enabled: false,
        productionLevel: 'none'
      },
      TEST: { 
        prefix: '[TEST]', 
        color: '\x1b[35m', // Magenta
        enabled: false,
        productionLevel: 'none'
      },
      DEBUG_FLAG: { 
        prefix: '[DEBUG FLAG]', 
        color: '\x1b[35m', // Magenta
        enabled: false,
        productionLevel: 'none'
      }
    };
    
    // If debug mode is enabled, enable all debug-related log types
    if (this.debug) {
      Object.keys(this.logTypes).forEach(type => {
        if (type !== 'INFO' && type !== 'WARN' && type !== 'ERROR') {
          this.logTypes[type].enabled = true;
        }
      });
    }
    
    // If verbose mode is enabled, enable all log types
    if (this.verbose) {
      Object.keys(this.logTypes).forEach(type => {
        this.logTypes[type].enabled = true;
      });
    }
  }

  /**
   * Configure logger settings
   * @param {Object} options - Configuration options
   */
  configure(options = {}) {
    if (options.debug !== undefined) this.debug = options.debug;
    if (options.verbose !== undefined) this.verbose = options.verbose;
    if (options.prefix) this.logPrefix = options.prefix;
    
    // Update log type settings based on new debug/verbose settings
    if (this.debug || this.verbose) {
      Object.keys(this.logTypes).forEach(type => {
        if (type !== 'INFO' && type !== 'WARN' && type !== 'ERROR') {
          this.logTypes[type].enabled = true;
        }
      });
    } else {
      Object.keys(this.logTypes).forEach(type => {
        if (type !== 'INFO' && type !== 'WARN' && type !== 'ERROR') {
          this.logTypes[type].enabled = false;
        }
      });
    }
  }

  /**
   * Log a message with the specified type
   * @param {string} type - Log type (INFO, WARN, ERROR, DEBUG, etc.)
   * @param {string} message - Message to log
   * @param {string} level - Importance level ('critical' or undefined for normal)
   */
  log(type, message, level = undefined) {
    const logType = this.logTypes[type] || this.logTypes.INFO;
    
    // Skip logging if:
    // 1. Log type is not enabled (based on debug/verbose settings)
    // 2. In production mode (debug=false) and either:
    //    a. productionLevel is 'none' (never show in production)
    //    b. productionLevel is 'critical' but this message isn't critical
    if (!logType.enabled) {
      return;
    }
    
    if (!this.debug && !this.verbose) {
      // We're in production mode
      if (logType.productionLevel === 'none') {
        return;
      }
      if (logType.productionLevel === 'critical' && level !== 'critical') {
        return;
      }
    }
    
    const reset = '\x1b[0m';
    console.log(`${logType.color}${this.logPrefix} ${logType.prefix}${reset} ${message}`);
  }

  /**
   * Log an info message
   * @param {string} message - Message to log
   * @param {boolean} critical - Whether this is a critical info message (shown in production)
   */
  info(message, critical = false) {
    this.log('INFO', message, critical ? 'critical' : undefined);
  }

  /**
   * Log a warning message
   * @param {string} message - Message to log
   */
  warn(message) {
    this.log('WARN', message);
  }

  /**
   * Log an error message
   * @param {string} message - Message to log
   */
  error(message) {
    this.log('ERROR', message);
  }

  /**
   * Log a debug message
   * @param {string} message - Message to log
   */
  debug(message) {
    this.log('DEBUG', message);
  }

  /**
   * Log a domain filter message
   * @param {string} message - Message to log
   */
  domainFilter(message) {
    this.log('DOMAIN_FILTER', message);
  }

  /**
   * Log a crawl message
   * @param {string} message - Message to log
   * @param {boolean} critical - Whether this is a critical crawl message (shown in production)
   */
  crawl(message, critical = false) {
    this.log('CRAWL', message, critical ? 'critical' : undefined);
  }

  /**
   * Log a links message
   * @param {string} message - Message to log
   */
  links(message) {
    this.log('LINKS', message);
  }

  /**
   * Log a content message
   * @param {string} message - Message to log
   */
  content(message) {
    this.log('CONTENT', message);
  }

  /**
   * Log a decision message
   * @param {string} message - Message to log
   */
  decision(message) {
    this.log('DECISION', message);
  }

  /**
   * Log a cache message
   * @param {string} message - Message to log
   */
  cache(message) {
    this.log('CACHE', message);
  }

  /**
   * Log a markdown message
   * @param {string} message - Message to log
   */
  markdown(message) {
    this.log('MARKDOWN', message);
  }

  /**
   * Log a test message
   * @param {string} message - Message to log
   */
  test(message) {
    this.log('TEST', message);
  }

  /**
   * Log a debug flag message
   * @param {string} message - Message to log
   */
  debugFlag(message) {
    this.log('DEBUG_FLAG', message);
  }
}

// Create a singleton instance
const logger = new LoggerService();

export default logger;
