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
  let currentlyProcessing = new Set();
  let totalAIRequests = 0;
  let completedAIRequests = 0;

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

        // Update database
        db.db.prepare('UPDATE pages SET content_status = ? WHERE url = ?').run('contexted', page.url);

        const insertionsCount = contextedMarkdown.match(/\[\[.*?\]\]/g)?.length || 0;
        logger.info(`[AI-PARALLEL] Enhanced ${page.url} with ${insertionsCount} insertions`);

        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[AI-PARALLEL] Error processing ${page.url}: ${error.message}`);
      return false;
    }
  }

  async function checkAndProcessNewPages() {
    if (!isRunning) return;

    try {
      // Find new raw pages that haven't been processed yet
      const rawPages = db.db
        .prepare(
          `
        SELECT url, file_path, title 
        FROM pages 
        WHERE content_status = 'raw' 
        AND file_path IS NOT NULL
        LIMIT 5
      `
        )
        .all();

      // Filter out pages we've already processed or are currently processing
      const newPages = rawPages.filter(page => !processedUrls.has(page.url) && !currentlyProcessing.has(page.url));

      if (newPages.length > 0) {
        logger.info(`[AI-PARALLEL] Found ${newPages.length} new pages to process`);

        // Mark as processing to avoid duplicate work
        newPages.forEach(page => currentlyProcessing.add(page.url));

        // Process each page independently
        const promises = newPages.map(async page => {
          try {
            const success = await processPage(page);
            if (success) {
              processedUrls.add(page.url);
            }
          } finally {
            currentlyProcessing.delete(page.url);
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
        currentlyProcessing: currentlyProcessing.size,
        isRunning
      };
    }
  };
}
