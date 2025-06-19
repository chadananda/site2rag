import logger from './logger_service.js';

/**
 * Fast Change Detection Service
 * Implements speed-optimized change detection with multiple filter tiers
 * Designed to make re-crawls extremely fast by eliminating unchanged content early
 */
export class FastChangeDetector {
  /**
   * Creates a new FastChangeDetector instance
   * @param {Object} options - Configuration options
   * @param {Object} options.db - Database instance for page data
   * @param {number} options.minAgeHours - Minimum age in hours before checking for changes (default: 168 = 1 week)
   * @param {number} options.fastRecheckHours - Fast recheck interval for recently changed content (default: 24 = 1 day)
   * @param {boolean} options.enableTimeFilters - Enable time-based filtering (default: true)
   * @param {boolean} options.testMode - Enable detailed test mode logging (default: false)
   */
  constructor(options = {}) {
    this.db = options.db;
    this.minAgeHours = options.minAgeHours || 168; // 1 week default
    this.fastRecheckHours = options.fastRecheckHours || 24; // 1 day default
    this.enableTimeFilters = options.enableTimeFilters !== false;
    this.testMode = options.testMode || false;
    
    // Statistics for performance monitoring
    this.stats = {
      totalChecked: 0,
      skippedByAge: 0,
      skippedByETag: 0,
      skippedByLastModified: 0,
      skippedByHash: 0,
      newContent: 0,
      updatedContent: 0
    };
    
    logger.info(`[FAST_CHANGE] Initialized with minAge=${this.minAgeHours}h, fastRecheck=${this.fastRecheckHours}h`);
  }

  /**
   * Speed-optimized change detection using multi-tier filtering
   * Filters are applied in order of fastest to slowest checks
   * @param {string} url - URL to check for changes
   * @param {Response} response - HTTP response object
   * @param {string} extractedContent - Extracted content for hash comparison
   * @returns {Object} - Change detection result
   */
  async checkForChanges(url, response, extractedContent = null) {
    this.stats.totalChecked++;
    
    // Get existing page data from database
    const existingPage = this.db?.getPage(url);
    
    // Test mode: Log detailed decision process
    if (this.testMode) {
      logger.info(`[TEST] Checking ${url} for changes`);
      if (existingPage) {
        logger.info(`[TEST] - Found existing page (last crawled: ${existingPage.last_crawled})`);
        logger.info(`[TEST] - Existing ETag: ${existingPage.etag || 'none'}`);
        logger.info(`[TEST] - Existing Last-Modified: ${existingPage.last_modified || 'none'}`);
        logger.info(`[TEST] - Existing Content Hash: ${existingPage.content_hash || 'none'}`);
      } else {
        logger.info(`[TEST] - No existing page found - will download`);
      }
      logger.info(`[TEST] - Response ETag: ${response.headers.get('etag') || 'none'}`);
      logger.info(`[TEST] - Response Last-Modified: ${response.headers.get('last-modified') || 'none'}`);
    }
    
    // Tier 1: Age-based filtering (fastest - no network/computation)
    if (this.enableTimeFilters && existingPage) {
      const ageResult = this._checkAge(existingPage);
      if (ageResult.skip) {
        this.stats.skippedByAge++;
        const message = `too recent (${ageResult.ageHours.toFixed(1)}h < ${this.minAgeHours}h)`;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - ${message}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - Age filter: ${message}`);
        }
        return {
          hasChanged: false,
          reason: 'age_filter',
          ageHours: ageResult.ageHours,
          skipReason: `Content too recent (${ageResult.ageHours.toFixed(1)}h old, min age ${this.minAgeHours}h)`
        };
      }
    }
    
    // Tier 2: ETag comparison (very fast - header check)
    if (existingPage?.etag && response.headers.get('etag')) {
      const etagResult = this._checkETag(existingPage, response);
      if (!etagResult.hasChanged) {
        this.stats.skippedByETag++;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - ETag match: ${etagResult.etag}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - ETag match: ${etagResult.etag}`);
        }
        return {
          hasChanged: false,
          reason: 'etag_match',
          etag: etagResult.etag
        };
      } else if (this.testMode) {
        logger.info(`[TEST] - ETag changed: ${etagResult.previousETag} → ${etagResult.etag}`);
      }
    }
    
    // Tier 3: Last-Modified comparison (fast - header check)
    if (existingPage?.last_modified && response.headers.get('last-modified')) {
      const lastModResult = this._checkLastModified(existingPage, response);
      if (!lastModResult.hasChanged) {
        this.stats.skippedByLastModified++;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - Last-Modified match: ${lastModResult.lastModified}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - Last-Modified match: ${lastModResult.lastModified}`);
        }
        return {
          hasChanged: false,
          reason: 'last_modified_match',
          lastModified: lastModResult.lastModified
        };
      } else if (this.testMode) {
        logger.info(`[TEST] - Last-Modified changed: ${lastModResult.previousLastModified} → ${lastModResult.lastModified}`);
      }
    }
    
    // Tier 4: Content hash comparison (slower - requires content processing)
    if (extractedContent && existingPage?.content_hash) {
      const hashResult = this._checkContentHash(existingPage, extractedContent);
      if (!hashResult.hasChanged) {
        this.stats.skippedByHash++;
        logger.log('DEBUG', `[FAST_CHANGE] Skipped ${url} - content hash match: ${hashResult.hash}`);
        if (this.testMode) {
          logger.info(`[TEST] ❌ SKIPPED: ${url} - Content hash match: ${hashResult.hash}`);
        }
        return {
          hasChanged: false,
          reason: 'content_hash_match',
          hash: hashResult.hash
        };
      } else if (this.testMode) {
        logger.info(`[TEST] - Content hash changed: ${hashResult.previousHash} → ${hashResult.hash}`);
      }
    }
    
    // Content has changed or is new
    if (existingPage) {
      this.stats.updatedContent++;
      logger.info(`[FAST_CHANGE] Content updated: ${url}`);
      if (this.testMode) {
        logger.info(`[TEST] ✅ DOWNLOAD: ${url} - Content updated (will process through AI)`);
      }
      return {
        hasChanged: true,
        reason: 'content_updated',
        isNew: false
      };
    } else {
      this.stats.newContent++;
      logger.info(`[FAST_CHANGE] New content: ${url}`);
      if (this.testMode) {
        logger.info(`[TEST] ✅ DOWNLOAD: ${url} - New content (will process through AI)`);
      }
      return {
        hasChanged: true,
        reason: 'new_content',
        isNew: true
      };
    }
  }

  /**
   * Check if content is too recent to warrant a recheck
   * @param {Object} existingPage - Existing page data from database
   * @returns {Object} - Age check result
   * @private
   */
  _checkAge(existingPage) {
    const now = new Date();
    const lastCrawled = new Date(existingPage.last_crawled);
    const ageHours = (now - lastCrawled) / (1000 * 60 * 60);
    
    // Skip if content is too recent, unless it was recently updated (fast recheck window)
    const isInFastRecheckWindow = ageHours < this.fastRecheckHours;
    const isTooRecent = ageHours < this.minAgeHours;
    
    // Allow fast recheck for content that was recently updated
    const wasRecentlyUpdated = existingPage.last_updated && 
      (now - new Date(existingPage.last_updated)) / (1000 * 60 * 60) < this.fastRecheckHours;
    
    const skip = isTooRecent && !wasRecentlyUpdated;
    
    return {
      skip,
      ageHours,
      isInFastRecheckWindow,
      wasRecentlyUpdated: wasRecentlyUpdated || false
    };
  }

  /**
   * Check ETag for changes
   * @param {Object} existingPage - Existing page data
   * @param {Response} response - HTTP response
   * @returns {Object} - ETag check result
   * @private
   */
  _checkETag(existingPage, response) {
    const currentETag = response.headers.get('etag');
    const previousETag = existingPage.etag;
    
    return {
      hasChanged: currentETag !== previousETag,
      etag: currentETag,
      previousETag
    };
  }

  /**
   * Check Last-Modified header for changes
   * @param {Object} existingPage - Existing page data
   * @param {Response} response - HTTP response
   * @returns {Object} - Last-Modified check result
   * @private
   */
  _checkLastModified(existingPage, response) {
    const currentLastMod = response.headers.get('last-modified');
    const previousLastMod = existingPage.last_modified;
    
    return {
      hasChanged: currentLastMod !== previousLastMod,
      lastModified: currentLastMod,
      previousLastModified: previousLastMod
    };
  }

  /**
   * Check content hash for changes (hash of extracted content, not original HTML)
   * @param {Object} existingPage - Existing page data
   * @param {string} extractedContent - Current extracted content
   * @returns {Object} - Hash check result
   * @private
   */
  _checkContentHash(existingPage, extractedContent) {
    const currentHash = this._calculateContentHash(extractedContent);
    const previousHash = existingPage.content_hash;
    
    return {
      hasChanged: currentHash !== previousHash,
      hash: currentHash,
      previousHash
    };
  }

  /**
   * Calculate hash of extracted content (not original HTML)
   * This ensures we detect changes in the actual content that matters
   * @param {string} content - Extracted content to hash
   * @returns {string} - Content hash
   * @private
   */
  _calculateContentHash(content) {
    if (!content) return '';
    
    // Simple hash function optimized for speed
    // This hashes the extracted/processed content, not the original HTML
    let hash = 0;
    const str = content.toString().trim();
    
    if (str.length === 0) return '0';
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return hash.toString(16);
  }

  /**
   * Generate conditional HTTP headers for efficient requests
   * @param {string} url - URL to generate headers for
   * @returns {Object} - HTTP headers object
   */
  generateConditionalHeaders(url) {
    const existingPage = this.db?.getPage(url);
    const headers = {};
    
    if (existingPage?.etag) {
      headers['If-None-Match'] = existingPage.etag;
      logger.log('DEBUG', `[FAST_CHANGE] Added If-None-Match: ${existingPage.etag}`);
    }
    
    if (existingPage?.last_modified) {
      headers['If-Modified-Since'] = existingPage.last_modified;
      logger.log('DEBUG', `[FAST_CHANGE] Added If-Modified-Since: ${existingPage.last_modified}`);
    }
    
    return headers;
  }

  /**
   * Update page data in database with new information
   * Only newly downloaded content gets 'raw' status for AI processing
   * @param {string} url - URL to update
   * @param {Response} response - HTTP response
   * @param {string} extractedContent - Extracted content
   * @param {string} filePath - Path to saved markdown file
   * @param {boolean} isNewContent - Whether this is newly downloaded content
   */
  updatePageData(url, response, extractedContent, filePath = null, isNewContent = true) {
    if (!this.db) {
      logger.warn('[FAST_CHANGE] No database available for page update');
      return;
    }
    
    const now = new Date().toISOString();
    const pageData = {
      url,
      etag: response.headers.get('etag') || '',
      last_modified: response.headers.get('last-modified') || '',
      content_hash: this._calculateContentHash(extractedContent),
      last_crawled: now,
      last_updated: now, // Mark as updated for fast recheck window
      status: response.status,
      title: null, // Will be extracted from content
      file_path: filePath
    };
    
    // Only set content_status to 'raw' for new or updated content
    // This ensures AI post-processing only runs on newly downloaded content
    if (isNewContent) {
      pageData.content_status = 'raw';
      logger.log('DEBUG', `[FAST_CHANGE] Marked ${url} for AI processing (content_status=raw)`);
    }
    
    this.db.upsertPage(pageData);
    logger.log('DEBUG', `[FAST_CHANGE] Updated page data for ${url} with hash ${pageData.content_hash}`);
  }
  
  /**
   * Update only timestamp for unchanged content (no AI processing needed)
   * @param {string} url - URL to update
   */
  updateUnchangedPage(url) {
    if (!this.db) {
      logger.warn('[FAST_CHANGE] No database available for page update');
      return;
    }
    
    const now = new Date().toISOString();
    
    // Only update the last_crawled timestamp, preserve ALL other fields including content_status
    // This prevents unchanged content from being re-processed by AI
    const updateStmt = this.db.db.prepare(`
      UPDATE pages 
      SET last_crawled = ? 
      WHERE url = ?
    `);
    
    const result = updateStmt.run(now, url);
    
    if (result.changes === 0) {
      logger.warn(`[FAST_CHANGE] No rows updated for URL: ${url}`);
    } else {
      logger.log('DEBUG', `[FAST_CHANGE] Updated timestamp for unchanged page: ${url}`);
    }
  }

  /**
   * Get performance statistics
   * @returns {Object} - Performance stats with efficiency metrics
   */
  getStats() {
    const totalSkipped = this.stats.skippedByAge + this.stats.skippedByETag + 
                        this.stats.skippedByLastModified + this.stats.skippedByHash;
    const efficiency = this.stats.totalChecked > 0 ? 
                      (totalSkipped / this.stats.totalChecked * 100).toFixed(1) : 0;
    
    return {
      ...this.stats,
      totalSkipped,
      efficiency: `${efficiency}%`,
      efficiencyRatio: totalSkipped / Math.max(this.stats.totalChecked, 1)
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    Object.keys(this.stats).forEach(key => {
      this.stats[key] = 0;
    });
  }

  /**
   * Log performance summary
   */
  logPerformanceSummary() {
    const stats = this.getStats();
    logger.info(`[FAST_CHANGE] Performance Summary:`);
    logger.info(`  Total URLs checked: ${stats.totalChecked}`);
    logger.info(`  Skipped by age filter: ${stats.skippedByAge}`);
    logger.info(`  Skipped by ETag: ${stats.skippedByETag}`);
    logger.info(`  Skipped by Last-Modified: ${stats.skippedByLastModified}`);
    logger.info(`  Skipped by content hash: ${stats.skippedByHash}`);
    logger.info(`  New content: ${stats.newContent}`);
    logger.info(`  Updated content: ${stats.updatedContent}`);
    logger.info(`  Overall efficiency: ${stats.efficiency} (${stats.totalSkipped}/${stats.totalChecked} skipped)`);
  }
}

/**
 * Factory function to create FastChangeDetector with common configurations
 */
export const createFastChangeDetector = {
  /**
   * Conservative configuration - longer intervals, fewer checks
   */
  conservative: (db, testMode = false) => new FastChangeDetector({
    db,
    minAgeHours: 168, // 1 week
    fastRecheckHours: 72, // 3 days
    enableTimeFilters: true,
    testMode
  }),

  /**
   * Aggressive configuration - shorter intervals, more frequent checks
   */
  aggressive: (db, testMode = false) => new FastChangeDetector({
    db,
    minAgeHours: 24, // 1 day
    fastRecheckHours: 6, // 6 hours
    enableTimeFilters: true,
    testMode
  }),

  /**
   * Balanced configuration - reasonable intervals for most use cases
   */
  balanced: (db, testMode = false) => new FastChangeDetector({
    db,
    minAgeHours: 72, // 3 days
    fastRecheckHours: 24, // 1 day
    enableTimeFilters: true,
    testMode
  }),

  /**
   * No time filters - only use HTTP headers and content hashes
   */
  noTimeFilters: (db, testMode = false) => new FastChangeDetector({
    db,
    enableTimeFilters: false,
    testMode
  })
};