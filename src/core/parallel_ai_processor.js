// parallel_ai_processor.js
// Processes pages with AI enhancement in parallel with crawling
import {processDocumentsSimple} from './context_processor_simple.js';
import logger from '../services/logger_service.js';
import fs from 'fs';

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
  let totalAIRequests = 0;
  let completedAIRequests = 0;
  const processorId = `parallel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

      // Identify eligible blocks
      const eligibleBlocks = allBlocks.filter(block => {
        const trimmed = block.text.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('```') || trimmed.match(/^ {4}/)) return false;
        if (trimmed.length < 200) return false;
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
      logger.info(`[AI-PARALLEL] Processing ${eligibleBlocks.length} eligible blocks from ${page.url}`);

      // Track AI requests for this document
      const estimatedRequests = Math.ceil(eligibleBlocks.length / 5);
      totalAIRequests += estimatedRequests;

      const results = await processDocumentsSimple([doc], aiConfig, (completed, total) => {
        completedAIRequests++;
        logger.info(`[AI-PARALLEL] Progress: ${completedAIRequests}/${totalAIRequests} AI requests`);
      });

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
        logger.info(`[AI-PARALLEL] Enhanced ${page.url} with ${insertionsCount} insertions`);

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

    try {
      // Reset any stuck processing pages first (older than 5 minutes)
      const resetCount = db.resetStuckProcessing(5);
      if (resetCount > 0) {
        logger.info(`[AI-PARALLEL] Reset ${resetCount} stuck processing pages`);
      }

      // Atomically claim pages for processing
      const claimedPages = db.claimPagesForProcessing(5, processorId);

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

        // Process in parallel but don't wait
        Promise.all(promises).catch(error => {
          logger.error(`[AI-PARALLEL] Batch processing error: ${error.message}`);
        });
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

    stop() {
      if (!isRunning) return;

      isRunning = false;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
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
