// context_enrichment.js
// Consolidated context enrichment using only the simple processor
import {processDocumentsSimple} from './context_processor_simple.js';
import {getDB} from '../db.js';
import logger from '../services/logger_service.js';
import fs from 'fs';
import {aiRequestTracker} from './ai_request_tracker.js';
import debugLogger from '../services/debug_logger.js';

// Global insertion tracking for test mode
export const insertionTracker = {
  enabled: false,
  sessions: new Map(), // sessionId -> session data
  currentSession: null,

  startSession(sessionId, llmConfig) {
    this.currentSession = sessionId;
    this.sessions.set(sessionId, {
      sessionId,
      llmConfig,
      startTime: Date.now(),
      files: new Map(), // filePath -> file data
      totalInsertions: 0,
      totalBlocks: 0,
      enhancedBlocks: []
    });
  },

  trackFile(filePath, insertions, allEnhancedBlocks = []) {
    if (!this.enabled || !this.currentSession) return;

    const session = this.sessions.get(this.currentSession);
    if (!session) return;

    // Update totals
    session.totalInsertions += insertions.length;
    session.totalBlocks += allEnhancedBlocks.length;

    // Store file data
    session.files.set(filePath, {
      insertions: insertions.length,
      blocks: allEnhancedBlocks.length,
      enhancedBlocks: allEnhancedBlocks
    });

    // Add to overall enhanced blocks list
    session.enhancedBlocks.push(...allEnhancedBlocks);
  },

  logSessionSummary() {
    if (!this.enabled || !this.currentSession) return;

    const session = this.sessions.get(this.currentSession);
    if (!session) return;

    const elapsedTime = ((Date.now() - session.startTime) / 1000).toFixed(1);
    const llmInfo = session.llmConfig ? `${session.llmConfig.provider}/${session.llmConfig.model}` : 'Unknown LLM';

    logger.info(`
================================================================================`);
    logger.info(`🤖 LLM ENHANCEMENT SUMMARY - ${llmInfo}`);
    logger.info(`================================================================================`);
    logger.info(`📊 Total files processed: ${session.files.size}`);
    logger.info(`📊 Total insertions: ${session.totalInsertions}`);
    logger.info(`📊 Total enhanced blocks: ${session.totalBlocks}`);
    logger.info(`⏱️  Processing time: ${elapsedTime}s`);
    logger.info(`================================================================================`);
  }
};

/**
 * Extract context insertions from enhanced text
 * @param {string} text - Enhanced text with [[...]] insertions
 * @returns {Array<string>} Array of insertion texts
 */
function extractContextInsertions(text) {
  if (!text) return [];
  // Handle both string and object blocks
  const textContent = typeof text === 'string' ? text : text.text || '';
  if (typeof textContent !== 'string') return [];
  const matches = textContent.match(/\[\[([^\]]+)\]\]/g) || [];
  return matches.map(m => m.slice(2, -2)); // Remove [[ and ]]
}

/**
 * Run context enrichment on all raw pages in database
 * @param {Object|string} dbOrPath - Database instance or path
 * @param {Object} aiConfig - AI configuration
 * @param {Function} progressCallback - Progress callback(completed, total)
 * @param {Object} options - Additional options (like test mode)
 * @returns {Promise<void>}
 */
export async function runContextEnrichment(dbOrPath, aiConfig, progressCallback = null, options = {}) {
  // Accept either a db instance (CrawlDB) or a path
  let db,
    shouldClose = false;
  if (typeof dbOrPath === 'string') {
    db = getDB(dbOrPath);
    shouldClose = true;
  } else {
    db = dbOrPath;
  }

  // Reset any stuck processing pages first (older than 30 minutes)
  // Increased from 5 to 30 minutes to allow for longer AI processing times
  // For testing, use 0.01 minutes (0.6 seconds) to reset recently stuck pages
  const isTestMode = process.env.NODE_ENV === 'test' || options.test;
  const resetMinutes = isTestMode ? 0.01 : 30;
  const resetCount = db.resetStuckProcessing(resetMinutes);
  if (resetCount > 0) {
    logger.info(`[CONTEXT] Reset ${resetCount} stuck processing pages (> ${resetMinutes} min) before batch processing`);
  } else {
    logger.info(`[CONTEXT] No stuck pages to reset (checking pages older than ${resetMinutes} minutes)`);
  }

  // Use the database's atomic claim mechanism for batch processing
  const batchProcessorId = `batch-${Date.now()}`;
  const allRawPages = [];

  // Claim pages in batches until no more are available
  while (true) {
    const batch = db.claimPagesForProcessing(50, batchProcessorId);
    if (batch.length === 0) {
      logger.info(`[CONTEXT] No more pages to claim for batch processing`);
      break;
    }
    logger.info(`[CONTEXT] Claimed ${batch.length} pages for batch processing`);
    allRawPages.push(...batch);
  }

  const rawDocs = allRawPages;

  logger.info(`[CONTEXT] Found ${rawDocs.length} raw pages to process from database`);

  if (process.env.NODE_ENV === 'test') {
    logger.info(`[CONTEXT] Starting simplified context enhancement for ${rawDocs.length} documents`);
  }

  // Phase 1: Prepare all documents for batch processing
  const documentsToProcess = [];
  const docMetadata = new Map(); // Store metadata for writing results back

  for (const doc of rawDocs) {
    try {
      if (!doc.file_path || !fs.existsSync(doc.file_path)) {
        if (process.env.NODE_ENV === 'test') {
          debugLogger.context(`Skipping ${doc.url} - no file path or file doesn't exist`);
        }
        continue;
      }

      const markdown = await fs.promises.readFile(doc.file_path, 'utf8');

      // Skip frontmatter if present
      let content = markdown;
      if (markdown.startsWith('---')) {
        const frontmatterEnd = markdown.indexOf('---', 3);
        if (frontmatterEnd > 0) {
          content = markdown.substring(frontmatterEnd + 3).trim();
        }
      }

      // Parse markdown into ALL blocks with original indices
      const allBlocks = content.split(/\n{2,}/).map((text, index) => ({
        text,
        originalIndex: index
      }));

      // Parse frontmatter to get full metadata
      let meta = {title: doc.title || '', url: doc.url};
      if (markdown.startsWith('---')) {
        const frontmatterEnd = markdown.indexOf('---', 3);
        if (frontmatterEnd > 0) {
          const frontmatter = markdown.substring(3, frontmatterEnd);
          const lines = frontmatter.split('\n');
          for (const line of lines) {
            const match = line.match(/^(\w+):\s*(.+)$/);
            if (match) {
              const key = match[1];
              const value = match[2].replace(/^["']|["']$/g, ''); // Remove quotes
              meta[key] = value;
            }
          }
        }
      }

      // Add document to batch processing list - send blocks with originalIndex preserved
      documentsToProcess.push({
        docId: doc.url,
        blocks: allBlocks, // Send full block objects to preserve originalIndex
        metadata: meta
      });

      // Store metadata for later use
      docMetadata.set(doc.url, {
        filePath: doc.file_path,
        originalMarkdown: markdown,
        frontmatterEnd: markdown.startsWith('---') ? markdown.indexOf('---', 3) : -1
      });
    } catch (err) {
      logger.error(`[CONTEXT] Failed preparing doc ${doc.url}: ${err.message}`);
    }
  }

  // Phase 2: Process all documents in batch
  if (documentsToProcess.length === 0) {
    logger.info('[CONTEXT] No documents to process');
    if (shouldClose) db.close();
    return;
  }

  logger.info(`[CONTEXT] Processing ${documentsToProcess.length} documents with simplified sliding window approach`);

  // Log document details for debugging
  if (process.env.DEBUG) {
    documentsToProcess.forEach((doc, idx) => {
      logger.info(`[CONTEXT] Document ${idx + 1}: ${doc.docId} - ${doc.blocks.length} blocks`);
    });
  }

  // Initialize the AI request tracker with all documents
  // This will calculate the expected total requests across all documents
  if (progressCallback) {
    await aiRequestTracker.initialize(documentsToProcess, progressCallback);
    // Update progress bar with actual total now that documents are prepared
    const stats = aiRequestTracker.getStats();
    progressCallback(stats.totalCompleted, stats.totalExpected);
  }

  // Process all documents together
  const results = await processDocumentsSimple(documentsToProcess, aiConfig, progressCallback);

  // Phase 3: Write results back to files and update database
  for (const [docId, enhancedBlocks] of Object.entries(results)) {
    try {
      const metadata = docMetadata.get(docId);
      if (!metadata) continue;

      // Track insertions for test mode
      if (insertionTracker.enabled) {
        const allInsertions = [];
        for (const block of enhancedBlocks) {
          const insertions = extractContextInsertions(block);
          allInsertions.push(...insertions);
        }
        insertionTracker.trackFile(metadata.filePath, allInsertions);
      }

      // Reassemble enriched markdown - extract text from blocks if they're objects
      const contextedMarkdown = enhancedBlocks
        .map(block => (typeof block === 'string' ? block : block.text || block))
        .join('\n\n');

      // Preserve frontmatter if present
      let finalMarkdown = contextedMarkdown;
      if (metadata.frontmatterEnd > 0) {
        const frontmatter = metadata.originalMarkdown.substring(0, metadata.frontmatterEnd + 3);
        finalMarkdown = frontmatter + '\n\n' + contextedMarkdown;
      }

      // Write the enriched content back to the file
      await fs.promises.writeFile(metadata.filePath, finalMarkdown, 'utf8');

      // Update the database to mark as processed
      db.markPageContexted(docId);

      if (process.env.NODE_ENV === 'test') {
        const insertionsCount = (contextedMarkdown.match(/\[\[.*?\]\]/g) || []).length;
        debugLogger.context(`✓ Completed: ${docId} (${insertionsCount} insertions)`);
      }
    } catch (err) {
      logger.error(`[CONTEXT] Failed writing results for ${docId}: ${err.message}`);
      // Mark as failed so it can be retried
      db.markPageFailed(docId, err.message);
    }
  }

  if (shouldClose) db.close();
}

/**
 * Enhance a single page (used for retry logic)
 * @param {string} url - Page URL
 * @param {string} filePath - Path to markdown file
 * @param {Object} aiConfig - AI configuration
 * @param {Object} db - Database instance
 * @returns {Promise<Object>} Result with success status
 */
export async function enhanceSinglePage(url, filePath, aiConfig, db) {
  const startTime = Date.now();

  try {
    // Update database: starting attempt
    db.db
      .prepare(
        `
      UPDATE pages 
      SET context_attempts = context_attempts + 1, 
          last_context_attempt = ?, 
          context_error = NULL,
          content_status = 'processing'
      WHERE url = ?
    `
      )
      .run(new Date().toISOString(), url);

    // Check if file exists
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read and parse markdown
    const markdown = await fs.promises.readFile(filePath, 'utf8');

    // Skip frontmatter if present
    let content = markdown;
    if (markdown.startsWith('---')) {
      const frontmatterEnd = markdown.indexOf('---', 3);
      if (frontmatterEnd > 0) {
        content = markdown.substring(frontmatterEnd + 3).trim();
      }
    }

    // Parse into blocks
    const allBlocks = content.split(/\n{2,}/).filter(text => text.trim());

    // Get page metadata from database
    const pageData = db.db.prepare('SELECT title FROM pages WHERE url = ?').get(url);
    let meta = {title: pageData?.title || '', url: url};

    // Parse frontmatter to get full metadata
    if (markdown.startsWith('---')) {
      const frontmatterEnd = markdown.indexOf('---', 3);
      if (frontmatterEnd > 0) {
        const frontmatter = markdown.substring(3, frontmatterEnd);
        const lines = frontmatter.split('\n');
        for (const line of lines) {
          const match = line.match(/^(\w+):\s*(.+)$/);
          if (match) {
            const key = match[1];
            const value = match[2].replace(/^["']|["']$/g, ''); // Remove quotes
            meta[key] = value;
          }
        }
      }
    }

    // Use simple processor - pass URL as docId for better tracking
    const doc = {
      docId: url,
      blocks: allBlocks,
      metadata: meta
    };

    const results = await processDocumentsSimple([doc], aiConfig, null);
    const enhancedBlocks = results[url] || allBlocks;

    if (!enhancedBlocks || enhancedBlocks.length === 0) {
      throw new Error('Context enhancement returned no results');
    }

    // Track insertions for test mode
    if (insertionTracker.enabled) {
      const allInsertions = [];
      for (const block of enhancedBlocks) {
        const insertions = extractContextInsertions(block);
        allInsertions.push(...insertions);
      }
      insertionTracker.trackFile(filePath, allInsertions);
    }

    const contextedMarkdown = enhancedBlocks
      .map(block => (typeof block === 'string' ? block : block.text || block))
      .join('\n\n');

    // Preserve frontmatter if present
    let finalMarkdown = contextedMarkdown;
    if (markdown.startsWith('---')) {
      const frontmatterEnd = markdown.indexOf('---', 3);
      if (frontmatterEnd > 0) {
        const frontmatter = markdown.substring(0, frontmatterEnd + 3);
        finalMarkdown = frontmatter + '\n\n' + contextedMarkdown;
      }
    }

    // Write enhanced content back to file
    await fs.promises.writeFile(filePath, finalMarkdown, 'utf8');

    // Update database: success
    db.db
      .prepare(
        `
      UPDATE pages 
      SET content_status = 'contexted',
          context_error = NULL,
          last_modified = ?
      WHERE url = ?
    `
      )
      .run(new Date().toISOString(), url);

    const processingTime = Date.now() - startTime;
    const insertionCount = (contextedMarkdown.match(/\[\[.*?\]\]/g) || []).length;

    return {
      success: true,
      processingTime,
      insertionCount,
      blocksProcessed: enhancedBlocks.length
    };
  } catch (error) {
    // Update database: failure
    db.db
      .prepare(
        `
      UPDATE pages 
      SET content_status = 'raw',
          context_error = ?
      WHERE url = ?
    `
      )
      .run(error.message, url);

    return {
      success: false,
      error: error.message,
      processingTime: Date.now() - startTime
    };
  }
}
