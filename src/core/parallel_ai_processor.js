// parallel_ai_processor.js
// Processes pages with AI enhancement in parallel with crawling
import {processDocumentsSimple} from './context_processor_simple.js';
import logger from '../services/logger_service.js';
import fs from 'fs';
import {aiRequestTracker} from './ai_request_tracker.js';

/**
 * Monitors database for new 'raw' pages and processes them immediately
 * @param {Object} db - Database instance
 * @param {Object} aiConfig - AI configuration
 * @param {number} checkInterval - How often to check for new pages (ms)
 * @returns {Object} Controller with start/stop methods
 */
export function createParallelAIProcessor(db, aiConfig, checkInterval = 2000) {
  let isRunning = false;
  let intervalId = null;
  let processedUrls = new Set();
  const processorId = `parallel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const pendingPromises = new Set(); // Track all pending AI processing promises
  const MAX_PENDING_PROMISES = 50; // Limit concurrent promises to prevent memory leaks

  async function processPage(page) {
    try {
      // Read the markdown file
      if (!page.file_path || !fs.existsSync(page.file_path)) {
        logger.warn(`[AI-PARALLEL] File not found for ${page.url}`);
        return false;
      }

      const markdown = await fs.promises.readFile(page.file_path, 'utf8');

      // Skip frontmatter if present
      let content = markdown;
      if (markdown.startsWith('---')) {
        const frontmatterEnd = markdown.indexOf('---', 3);
        if (frontmatterEnd > 0) {
          content = markdown.substring(frontmatterEnd + 3).trim();
        }
      }

      // Parse markdown into ALL blocks
      const allBlocks = content.split(/\n{2,}/).map((text, index) => ({text, originalIndex: index}));

      // Identify eligible blocks - use same criteria as main processor
      const eligibleBlocks = allBlocks.filter(block => {
        const trimmed = block.text.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('#')) return false; // Skip headers
        if (trimmed.startsWith('```') || trimmed.match(/^(\s{4}|\t)/)) return false; // Skip code blocks
        if (trimmed.length < 20) return false; // Match MIN_BLOCK_CHARS from context_processor_simple
        if (trimmed.startsWith('![')) return false; // Skip image blocks
        return true;
      });

      if (eligibleBlocks.length === 0) {
        logger.info(`[AI-PARALLEL] No eligible blocks for ${page.url}`);
        return false;
      }

      // Prepare document for processing
      const doc = {
        docId: page.url,
        blocks: eligibleBlocks,
        allBlocks: allBlocks,
        metadata: {title: page.title || '', url: page.url}
      };

      // Process with AI
      logger.info(`[AI-PARALLEL] Starting AI processing for ${page.url} with ${eligibleBlocks.length} eligible blocks`);

      // Use the shared tracker's progress callback if initialized
      const progressCallback = aiRequestTracker.isInitialized
        ? () => {
            const stats = aiRequestTracker.getStats();
            logger.info(`[AI-PARALLEL] Progress: ${stats.totalCompleted}/${stats.totalExpected} AI requests`);
          }
        : null;

      const results = await processDocumentsSimple([doc], aiConfig, progressCallback);

      // Write results back
      if (results[page.url]) {
        const enhancedBlocks = results[page.url];
        const contextedMarkdown = enhancedBlocks
          .map(block => (typeof block === 'string' ? block : block.text || block))
          .join('\n\n');

        // Preserve frontmatter
        let finalMarkdown = contextedMarkdown;
        if (markdown.startsWith('---')) {
          const frontmatterEnd = markdown.indexOf('---', 3);
          const frontmatter = markdown.substring(0, frontmatterEnd + 3);
          finalMarkdown = frontmatter + '\n\n' + contextedMarkdown;
        }

        await fs.promises.writeFile(page.file_path, finalMarkdown, 'utf8');

        // Update database - mark as successfully processed
        db.markPageContexted(page.url);

        const insertionsCount = contextedMarkdown.match(/\[\[.*?\]\]/g)?.length || 0;
        logger.info(`[AI-PARALLEL] Completed processing ${page.url} with ${insertionsCount} insertions`);

        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[AI-PARALLEL] Error processing ${page.url}: ${error.message}`);
      // Mark as failed so it can be retried later
      db.markPageFailed(page.url, error.message);
      return false;
    }
  }

  async function checkAndProcessNewPages() {
    if (!isRunning) return;

    // Don't start new processing if we're at the limit
    if (pendingPromises.size >= MAX_PENDING_PROMISES) {
      logger.info(`[AI-PARALLEL] At maximum capacity (${MAX_PENDING_PROMISES} pending), waiting...`);
      return;
    }

    try {
      // Reset any stuck processing pages first (older than 30 minutes)
      // Increased from 5 to 30 minutes to allow for longer AI processing times
      // For testing, use 0.1 minutes (6 seconds) to reset recently stuck pages
      const resetMinutes = process.env.NODE_ENV === 'test' ? 0.1 : 30;
      const resetCount = db.resetStuckProcessing(resetMinutes);
      if (resetCount > 0) {
        logger.info(`[AI-PARALLEL] Reset ${resetCount} stuck processing pages (> 30 min)`);
      }

      // Calculate how many pages we can claim based on current capacity
      const remainingCapacity = MAX_PENDING_PROMISES - pendingPromises.size;
      const pagesToClaim = Math.min(5, remainingCapacity);

      if (pagesToClaim <= 0) return;

      // Atomically claim pages for processing
      const claimedPages = db.claimPagesForProcessing(pagesToClaim, processorId);

      if (claimedPages.length > 0) {
        logger.info(`[AI-PARALLEL] Claimed ${claimedPages.length} pages for processing`);

        // Process each page independently
        const promises = claimedPages.map(async page => {
          try {
            const success = await processPage(page);
            if (success) {
              processedUrls.add(page.url);
            }
          } catch (error) {
            logger.error(`[AI-PARALLEL] Failed to process ${page.url}: ${error.message}`);
          }
        });

        // Process in parallel and track promises with proper cleanup
        promises.forEach(promise => {
          // Track individual promise and ensure cleanup
          pendingPromises.add(promise);
          promise.finally(() => pendingPromises.delete(promise));
        });

        // Create batch promise with cleanup
        const batchPromise = Promise.all(promises)
          .finally(() => {
            // Ensure batch promise is also cleaned up
            pendingPromises.delete(batchPromise);
          })
          .catch(error => {
            logger.error(`[AI-PARALLEL] Batch processing error: ${error.message}`);
          });

        // Track the batch promise too
        pendingPromises.add(batchPromise);
      }
    } catch (error) {
      logger.error(`[AI-PARALLEL] Check error: ${error.message}`);
    }
  }

  return {
    start() {
      if (isRunning) return;

      isRunning = true;
      logger.info('[AI-PARALLEL] Starting parallel AI processor');

      // Check immediately
      checkAndProcessNewPages();

      // Then check periodically
      intervalId = setInterval(checkAndProcessNewPages, checkInterval);
    },

    async stop() {
      if (!isRunning) return;

      isRunning = false;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }

      // Wait for all pending AI processing to complete
      if (pendingPromises.size > 0) {
        logger.info(`[AI-PARALLEL] Waiting for ${pendingPromises.size} pending AI requests to complete...`);
        try {
          await Promise.all(pendingPromises);
          logger.info(`[AI-PARALLEL] All pending AI requests completed`);
        } catch (error) {
          logger.error(`[AI-PARALLEL] Error waiting for pending requests: ${error.message}`);
        }
      }

      logger.info(`[AI-PARALLEL] Stopped. Processed ${processedUrls.size} pages`);
    },

    getStats() {
      return {
        processed: processedUrls.size,
        processorId,
        isRunning
      };
    }
  };
}
