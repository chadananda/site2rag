// resourceCleanup.js
// Utility for cleaning up resources and preventing memory leaks

import fs from 'fs';
import path from 'path';
import logger from '../services/logger_service.js';

/**
 * Resource cleanup manager for handling database connections, file handles, and temporary files
 */
export class ResourceCleanupManager {
  constructor() {
    this.resources = new Set();
    this.cleanupHandlers = new Map();
    this.isShuttingDown = false;
    
    // Register process exit handlers
    this.registerExitHandlers();
  }

  /**
   * Register a resource for cleanup
   * @param {string} resourceId - Unique identifier for the resource
   * @param {Function} cleanupHandler - Function to call for cleanup
   */
  register(resourceId, cleanupHandler) {
    if (this.isShuttingDown) {
      // If we're already shutting down, clean up immediately
      try {
        cleanupHandler();
      } catch (error) {
        logger.error(`Error cleaning up resource ${resourceId} during shutdown:`, error);
      }
      return;
    }
    
    this.resources.add(resourceId);
    this.cleanupHandlers.set(resourceId, cleanupHandler);
  }

  /**
   * Unregister a resource (already cleaned up)
   * @param {string} resourceId - Resource identifier
   */
  unregister(resourceId) {
    this.resources.delete(resourceId);
    this.cleanupHandlers.delete(resourceId);
  }

  /**
   * Clean up a specific resource
   * @param {string} resourceId - Resource identifier
   */
  async cleanup(resourceId) {
    const handler = this.cleanupHandlers.get(resourceId);
    if (handler) {
      try {
        await handler();
        this.unregister(resourceId);
      } catch (error) {
        logger.error(`Error cleaning up resource ${resourceId}:`, error);
      }
    }
  }

  /**
   * Clean up all registered resources
   */
  async cleanupAll() {
    this.isShuttingDown = true;
    const promises = [];
    
    for (const [resourceId, handler] of this.cleanupHandlers) {
      promises.push(
        Promise.resolve(handler())
          .catch(error => logger.error(`Error cleaning up resource ${resourceId}:`, error))
      );
    }
    
    await Promise.all(promises);
    this.resources.clear();
    this.cleanupHandlers.clear();
  }

  /**
   * Register process exit handlers
   */
  registerExitHandlers() {
    const cleanup = async (signal) => {
      if (this.isShuttingDown) return;
      
      logger.info(`Received ${signal}, cleaning up resources...`);
      await this.cleanupAll();
      process.exit(0);
    };

    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('exit', () => {
      if (!this.isShuttingDown) {
        logger.info('Process exiting, cleaning up resources...');
        // Synchronous cleanup only on exit
        for (const [resourceId, handler] of this.cleanupHandlers) {
          try {
            const result = handler();
            if (result && typeof result.then === 'function') {
              logger.warn(`Async cleanup handler for ${resourceId} called during exit - may not complete`);
            }
          } catch (error) {
            logger.error(`Error cleaning up resource ${resourceId} on exit:`, error);
          }
        }
      }
    });
  }
}

// Global instance
export const globalCleanupManager = new ResourceCleanupManager();

/**
 * Clean up temporary test files
 * @param {string} testTmpDir - Path to test temp directory
 * @returns {Promise<void>}
 */
export async function cleanupTestTempFiles(testTmpDir = 'tests/tmp') {
  try {
    if (!fs.existsSync(testTmpDir)) return;
    
    const stats = await fs.promises.stat(testTmpDir);
    if (!stats.isDirectory()) return;
    
    // Get all items in temp directory
    const items = await fs.promises.readdir(testTmpDir);
    
    for (const item of items) {
      const itemPath = path.join(testTmpDir, item);
      const itemStats = await fs.promises.stat(itemPath);
      
      // Skip if file is less than 1 hour old (might be in use)
      const ageMs = Date.now() - itemStats.mtime.getTime();
      if (ageMs < 3600000) continue; // 1 hour
      
      try {
        if (itemStats.isDirectory()) {
          await fs.promises.rm(itemPath, { recursive: true, force: true });
        } else {
          await fs.promises.unlink(itemPath);
        }
        logger.info(`Cleaned up old temp file: ${itemPath}`);
      } catch (error) {
        logger.warn(`Failed to clean up ${itemPath}:`, error.message);
      }
    }
  } catch (error) {
    logger.error('Error cleaning up test temp files:', error);
  }
}

/**
 * Create a database connection with automatic cleanup
 * @param {Function} databaseFactory - Function that creates database connection
 * @param {string} resourceId - Unique identifier for this connection
 * @returns {Object} Database connection
 */
export function createManagedDatabase(databaseFactory, resourceId) {
  const db = databaseFactory();
  
  globalCleanupManager.register(resourceId, () => {
    try {
      if (db && typeof db.close === 'function') {
        db.close();
      }
    } catch (error) {
      logger.error(`Error closing database ${resourceId}:`, error);
    }
  });
  
  return db;
}

/**
 * Memory usage monitor
 */
export class MemoryMonitor {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.8; // 80% of heap limit
    this.checkInterval = options.checkInterval || 30000; // 30 seconds
    this.onThresholdExceeded = options.onThresholdExceeded || this.defaultHandler;
    this.intervalId = null;
  }

  /**
   * Start monitoring memory usage
   */
  start() {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(() => {
      const usage = process.memoryUsage();
      const heapUsed = usage.heapUsed;
      const heapTotal = usage.heapTotal;
      const external = usage.external;
      const rss = usage.rss;
      
      // Check if we're exceeding threshold
      const heapUsageRatio = heapUsed / heapTotal;
      
      if (heapUsageRatio > this.threshold) {
        logger.warn(`Memory usage high: ${(heapUsageRatio * 100).toFixed(2)}% of heap`);
        logger.warn(`Heap: ${(heapUsed / 1024 / 1024).toFixed(2)}MB / ${(heapTotal / 1024 / 1024).toFixed(2)}MB`);
        logger.warn(`RSS: ${(rss / 1024 / 1024).toFixed(2)}MB, External: ${(external / 1024 / 1024).toFixed(2)}MB`);
        
        this.onThresholdExceeded({
          heapUsed,
          heapTotal,
          external,
          rss,
          heapUsageRatio
        });
      }
    }, this.checkInterval);
    
    // Register for cleanup
    globalCleanupManager.register('memory-monitor', () => this.stop());
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Default handler for threshold exceeded
   * @param {Object} usage - Memory usage details
   */
  defaultHandler(usage) {
    // Force garbage collection if available
    if (global.gc) {
      logger.info('Forcing garbage collection...');
      global.gc();
    }
    
    // Log detailed memory stats
    logger.warn('Memory threshold exceeded:', {
      heapUsedMB: (usage.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (usage.heapTotal / 1024 / 1024).toFixed(2),
      rssMB: (usage.rss / 1024 / 1024).toFixed(2),
      externalMB: (usage.external / 1024 / 1024).toFixed(2)
    });
  }
}

// Export a global memory monitor instance
export const memoryMonitor = new MemoryMonitor();