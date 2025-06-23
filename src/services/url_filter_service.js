/**
 * url_filter_service.js - Service for filtering URLs and content based on configured rules
 * Provides URL path filtering, pattern matching, and language-based content filtering
 */

import {hasTargetLanguage} from '../utils/language_detector.js';
import logger from './logger_service.js';

/**
 * Service for filtering URLs and content based on configuration rules
 */
export class UrlFilterService {
  /**
   * Create URL filter service with filtering configuration
   * @param {Object} filterConfig - Filtering configuration
   * @param {string[]} filterConfig.excludePaths - URL paths to exclude
   * @param {string[]} filterConfig.excludePatterns - Regex patterns to exclude
   * @param {string} filterConfig.includeLanguage - Required language code
   * @param {string[]} filterConfig.includePatterns - Regex patterns to include (if specified, only these are included)
   */
  constructor(filterConfig = {}) {
    this.excludePaths = filterConfig.excludePaths || [];
    this.excludePatterns = filterConfig.excludePatterns || [];
    this.includeLanguage = filterConfig.includeLanguage || null;
    this.includePatterns = filterConfig.includePatterns || [];
    // Compile regex patterns for better performance
    this.compiledExcludeRegex = this.compilePatterns(this.excludePatterns);
    this.compiledIncludeRegex = this.compilePatterns(this.includePatterns);
    // Log filter configuration
    this.logFilterConfig();
  }
  /**
   * Check if URL should be crawled based on URL-level filtering rules
   * @param {string} url - URL to check
   * @returns {boolean} - True if URL should be crawled
   */
  shouldCrawlUrl(url) {
    // 1. Check exclude paths
    if (this.isPathExcluded(url)) {
      logger.info(`URL excluded by path filter: ${url}`);
      return false;
    }
    // 2. Check exclude patterns  
    if (this.isPatternExcluded(url)) {
      logger.info(`URL excluded by pattern filter: ${url}`);
      return false;
    }
    // 3. Check include patterns (if specified, only these are included)
    if (this.includePatterns.length > 0 && !this.isPatternIncluded(url)) {
      logger.info(`URL excluded by include pattern filter: ${url}`);
      return false;
    }
    return true;
  }
  /**
   * Check if content should be processed based on content-level filtering rules
   * @param {string} html - HTML content
   * @param {string} url - URL of the content (for logging)
   * @returns {boolean} - True if content should be processed
   */
  shouldProcessContent(html, url) {
    // Language filtering
    if (this.includeLanguage && !hasTargetLanguage(html, this.includeLanguage)) {
      logger.info(`Content excluded by language filter (expected: ${this.includeLanguage}): ${url}`);
      return false;
    }
    return true;
  }
  /**
   * Check if URL path is excluded
   * @param {string} url - URL to check
   * @returns {boolean} - True if path is excluded
   */
  isPathExcluded(url) {
    if (this.excludePaths.length === 0) {
      return false;
    }
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      return this.excludePaths.some(excludePath => {
        // Exact match or starts with path (treating path as directory)
        return pathname === excludePath || pathname.startsWith(excludePath + '/');
      });
    } catch {
      return false; // Invalid URL, let other validation handle it
    }
  }
  /**
   * Check if URL matches exclude patterns
   * @param {string} url - URL to check
   * @returns {boolean} - True if URL matches exclude pattern
   */
  isPatternExcluded(url) {
    return this.compiledExcludeRegex.some(regex => regex && regex.test(url));
  }
  /**
   * Check if URL matches include patterns
   * @param {string} url - URL to check
   * @returns {boolean} - True if URL matches include pattern
   */
  isPatternIncluded(url) {
    if (this.compiledIncludeRegex.length === 0) {
      return true; // No include patterns specified
    }
    return this.compiledIncludeRegex.some(regex => regex && regex.test(url));
  }
  /**
   * Compile pattern strings into regex objects
   * @param {string[]} patterns - Array of regex pattern strings
   * @returns {RegExp[]} - Array of compiled regex objects
   */
  compilePatterns(patterns) {
    return patterns.map(pattern => {
      try {
        return new RegExp(pattern, 'i'); // Case-insensitive
      } catch (e) {
        logger.warn(`Invalid regex pattern: ${pattern} - ${e.message}`);
        return null;
      }
    }).filter(Boolean);
  }
  /**
   * Get current filter configuration for debugging
   * @returns {Object} - Current filter configuration
   */
  getFilterConfig() {
    return {
      excludePaths: this.excludePaths,
      excludePatterns: this.excludePatterns,
      includeLanguage: this.includeLanguage,
      includePatterns: this.includePatterns
    };
  }
  /**
   * Log filter configuration on initialization
   */
  logFilterConfig() {
    const hasFilters = this.excludePaths.length > 0 || 
                      this.excludePatterns.length > 0 || 
                      this.includeLanguage || 
                      this.includePatterns.length > 0;
    if (hasFilters) {
      logger.info('URL filtering enabled:');
      if (this.excludePaths.length > 0) {
        logger.info(`  Exclude paths: ${this.excludePaths.join(', ')}`);
      }
      if (this.excludePatterns.length > 0) {
        logger.info(`  Exclude patterns: ${this.excludePatterns.join(', ')}`);
      }
      if (this.includeLanguage) {
        logger.info(`  Include language: ${this.includeLanguage}`);
      }
      if (this.includePatterns.length > 0) {
        logger.info(`  Include patterns: ${this.includePatterns.join(', ')}`);
      }
    } else {
      logger.info('No URL filtering configured - all URLs will be processed');
    }
  }
}