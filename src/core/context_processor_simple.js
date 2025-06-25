// context_processor_simple.js
// Simplified sliding window context processor with full parallelization
import {z} from 'zod';
import pLimit from 'p-limit';
import {callAI} from './ai_client.js';
import debugLogger from '../services/debug_logger.js';
import {validateEnhancement} from '../utils/context_utils.js';

// Schema for AI response
const WindowEnhancementSchema = z.object({
  enhanced_blocks: z.record(z.string(), z.string())
});

// Constants
const CONTEXT_WORDS = 1000; // Words of context to include
const PROCESS_WORDS = 1000; // Words to process per window
const MIN_BLOCK_CHARS = 200; // Minimum block size to process

/**
 * Check if the AI model is a simpler/smaller model that needs simplified instructions
 * @param {Object} aiConfig - AI configuration
 * @returns {boolean} True if simple model
 */
function isSimpleModel(aiConfig) {
  const simpleModels = ['gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-3.5'];
  return aiConfig.model && simpleModels.some(m => aiConfig.model.includes(m));
}

/**
 * Create sliding windows from document blocks
 * Each window has context from previous window and new blocks to process
 * @param {Array} blocks - Document blocks
 * @returns {Array} Windows with context and blocks to process
 */
function createSlidingWindows(blocks) {
  const windows = [];
  let processedBlockIndex = 0;
  let previousText = ''; // Accumulate text for context

  while (processedBlockIndex < blocks.length) {
    // Collect blocks for this window (~1000 words to process)
    const windowBlocks = {};
    const blockIndices = []; // Track which original indices we're processing
    let windowWords = 0;
    const startIndex = processedBlockIndex;

    while (processedBlockIndex < blocks.length && windowWords < PROCESS_WORDS) {
      const block = blocks[processedBlockIndex];
      const blockText = typeof block === 'string' ? block : block.text || block;

      // Skip very short blocks but track that we processed this index
      if (blockText.trim().length < MIN_BLOCK_CHARS) {
        processedBlockIndex++;
        continue;
      }

      // Track original index - use originalIndex if available (from filtered blocks), otherwise use current index
      const originalIdx = block.originalIndex !== undefined ? block.originalIndex : processedBlockIndex;
      const key = String(originalIdx);
      windowBlocks[key] = blockText;
      blockIndices.push(originalIdx);

      windowWords += blockText.split(/\s+/).length;
      processedBlockIndex++;
    }

    // Skip empty windows but ensure we process remaining short blocks
    if (Object.keys(windowBlocks).length === 0) {
      // If we're not at the end, continue to next block
      if (processedBlockIndex < blocks.length) {
        processedBlockIndex++;
        continue;
      }
      break;
    }

    // Get context from previous text (last 1000 words)
    const contextWords = previousText.split(/\s+/).filter(w => w.length > 0);
    const contextStart = Math.max(0, contextWords.length - CONTEXT_WORDS);
    const context = contextWords.slice(contextStart).join(' ');

    // Create window
    windows.push({
      windowIndex: windows.length,
      startBlockIndex: startIndex,
      endBlockIndex: processedBlockIndex - 1,
      blockIndices: blockIndices, // Store actual indices processed
      context: context,
      blocks: windowBlocks,
      blockCount: Object.keys(windowBlocks).length,
      wordCount: windowWords
    });

    // Update previous text for next window's context
    // Add all the text we just processed
    const processedText = Object.values(windowBlocks).join(' ');

    // More efficient context accumulation
    const newContextWords = [...contextWords, ...processedText.split(/\s+/).filter(w => w.length > 0)];
    // Keep only recent words for context
    if (newContextWords.length > CONTEXT_WORDS * 2) {
      previousText = newContextWords.slice(-CONTEXT_WORDS * 2).join(' ');
    } else {
      previousText = newContextWords.join(' ');
    }
  }

  return windows;
}

/**
 * Create a request for a single window
 * @param {Object} window - Window data
 * @param {Object} metadata - Document metadata
 * @param {string} docId - Document identifier
 * @param {Object} aiConfig - AI configuration
 * @returns {Object} Request object
 */
function createWindowRequest(window, metadata, docId, aiConfig) {
  const useSimplePrompt = isSimpleModel(aiConfig);
  
  let prompt;
  if (useSimplePrompt) {
    // Simplified prompt for models like GPT-4o-mini
    prompt = `========= INSTRUCTIONS:

Add [[context]] after pronouns to show what they refer to.
Use ONLY information from the PREVIOUS CONTEXT section.

Example: "He arrived" becomes "He [[John Smith]] arrived"

Return JSON with the same number keys, adding [[context]] where needed.

========= DOCUMENT META-DATA:

Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}

========= PREVIOUS CONTEXT:

${window.context || '(This is the beginning of the document)'}

========= BLOCKS TO PROCESS:

${JSON.stringify(window.blocks)}`;
  } else {
    // More detailed prompt for advanced models
    prompt = `========= INSTRUCTIONS:

Add [[context]] to clarify ambiguous references using information from the document.

Focus on:
- Pronouns: "she" → "she [[Dr. Smith]]"
- Ambiguous references: "the project" → "the project [[Ocean software]]"
- Unclear terms that need context from earlier in the document

Use ONLY information found in the PREVIOUS CONTEXT or current blocks.
DO NOT add generic descriptions or information not in the document.

========= DOCUMENT META-DATA:

Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}
Description: ${metadata.description || 'None provided'}

========= PREVIOUS CONTEXT:

${window.context || '(This is the beginning of the document)'}

========= BLOCKS TO PROCESS:

${JSON.stringify(window.blocks)}`;
  }

  return {
    docId,
    windowIndex: window.windowIndex,
    prompt,
    metadata,
    window
  };
}

/**
 * Process all documents with simplified sliding window approach
 * @param {Array} documents - Array of {docId, blocks, metadata} objects
 * @param {Object} aiConfig - AI configuration
 * @param {Function} progressCallback - Progress callback(completed, total)
 * @returns {Promise<Object>} Results keyed by docId
 */
export async function processDocumentsSimple(documents, aiConfig, progressCallback = null) {
  debugLogger.ai('=== Starting Simplified Sliding Window Processing ===');
  debugLogger.ai(`Processing ${documents.length} documents`);

  // Phase 1: Create all requests upfront
  const allRequests = [];

  for (const doc of documents) {
    if (!doc.blocks || doc.blocks.length === 0) {
      debugLogger.ai(`Skipping document ${doc.docId} - no blocks`);
      continue;
    }

    // Create sliding windows for this document
    const windows = createSlidingWindows(doc.blocks);
    debugLogger.ai(`Document ${doc.docId}: Created ${windows.length} windows`);

    // Create request for each window
    for (const window of windows) {
      const request = createWindowRequest(window, doc.metadata, doc.docId, aiConfig);
      allRequests.push(request);
    }
  }

  const totalRequests = allRequests.length;
  debugLogger.ai(`Total requests to process: ${totalRequests}`);

  if (totalRequests === 0) {
    return {};
  }

  // Initialize progress
  if (progressCallback) {
    progressCallback(0, totalRequests);
  }

  // Phase 2: Process all requests in parallel with rate limiting
  const limiter = pLimit(10); // Process up to 10 requests concurrently
  const completedRequests = {count: 0}; // Use object for atomic-like updates
  const results = {};

  // Process all requests
  const requestPromises = allRequests.map(request =>
    limiter(async () => {
      try {
        debugLogger.ai(`Processing request - Doc: ${request.docId}, Window: ${request.windowIndex}`);

        // Call AI with the request
        const response = await callAI(request.prompt, WindowEnhancementSchema, aiConfig);

        if (!response || !response.enhanced_blocks) {
          throw new Error('Invalid AI response format');
        }

        // Validate enhancements
        const validatedBlocks = {};
        for (const [key, original] of Object.entries(request.window.blocks)) {
          const enhanced = response.enhanced_blocks[key];
          if (enhanced) {
            const validation = validateEnhancement(original, enhanced);
            if (validation.isValid) {
              validatedBlocks[key] = enhanced;
            } else {
              debugLogger.ai(`Window ${request.windowIndex}, Block ${key}: Validation failed - ${validation.error}`);
              validatedBlocks[key] = original; // Use original on validation failure
            }
          } else {
            validatedBlocks[key] = original; // Use original if not returned
          }
        }

        // Update progress
        completedRequests.count++;
        if (progressCallback) {
          progressCallback(completedRequests.count, totalRequests);
        }

        return {
          docId: request.docId,
          windowIndex: request.windowIndex,
          startBlockIndex: request.window.startBlockIndex,
          endBlockIndex: request.window.endBlockIndex,
          blockIndices: request.window.blockIndices,
          enhancedBlocks: validatedBlocks
        };
      } catch (error) {
        debugLogger.ai(`Request failed - Doc: ${request.docId}, Window: ${request.windowIndex}: ${error.message}`);

        // Update progress even on failure
        completedRequests.count++;
        if (progressCallback) {
          progressCallback(completedRequests.count, totalRequests);
        }

        // Return original blocks on error
        return {
          docId: request.docId,
          windowIndex: request.windowIndex,
          startBlockIndex: request.window.startBlockIndex,
          endBlockIndex: request.window.endBlockIndex,
          blockIndices: request.window.blockIndices,
          enhancedBlocks: request.window.blocks,
          error: error.message
        };
      }
    })
  );

  // Wait for all requests to complete
  const allResults = await Promise.all(requestPromises);

  // Phase 3: Reassemble results by document
  for (const result of allResults) {
    if (!results[result.docId]) {
      results[result.docId] = {
        windows: [],
        blocks: []
      };
    }
    results[result.docId].windows.push(result);
  }

  // Sort windows and create final block arrays
  for (const docId in results) {
    const docResult = results[docId];
    const doc = documents.find(d => d.docId === docId);

    if (!doc) {
      debugLogger.ai(`Warning: No document found for docId ${docId}`);
      continue;
    }

    // Sort windows by index
    docResult.windows.sort((a, b) => a.windowIndex - b.windowIndex);

    // Create array to hold final blocks in correct order
    // Use allBlocks if available (contains ALL blocks including filtered ones), otherwise use blocks
    const finalBlocks = doc.allBlocks ? [...doc.allBlocks] : [...doc.blocks]; // Start with all original blocks

    // Replace blocks that were enhanced
    for (const window of docResult.windows) {
      // Get the enhanced blocks in order
      const enhancedBlocksArray = Object.values(window.enhancedBlocks);

      // Use blockIndices to know which blocks to replace
      if (window.blockIndices && window.blockIndices.length === enhancedBlocksArray.length) {
        for (let i = 0; i < window.blockIndices.length; i++) {
          const originalIndex = window.blockIndices[i];
          finalBlocks[originalIndex] = enhancedBlocksArray[i];
        }
      } else {
        // Fallback if blockIndices is missing (shouldn't happen with new code)
        debugLogger.ai(`Warning: blockIndices missing or mismatched for window ${window.windowIndex}`);
        // Use the old logic as fallback
        let blockCounter = 0;
        for (
          let idx = window.startBlockIndex;
          idx <= window.endBlockIndex && blockCounter < enhancedBlocksArray.length;
          idx++
        ) {
          const block = doc.blocks[idx];
          if (block) {
            const blockText = typeof block === 'string' ? block : block.text || block;
            if (blockText.trim().length >= MIN_BLOCK_CHARS) {
              finalBlocks[idx] = enhancedBlocksArray[blockCounter];
              blockCounter++;
            }
          }
        }
      }
    }

    results[docId] = finalBlocks;
  }

  debugLogger.ai(`=== Completed Processing ${completedRequests.count}/${totalRequests} requests ===`);

  return results;
}

/**
 * Process a single document (for compatibility)
 * @param {Array} blocks - Document blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} Enhanced blocks
 */
export async function enhanceDocumentSimple(blocks, metadata, aiConfig, options = {}) {
  const doc = {
    docId: 'single-doc',
    blocks: blocks,
    metadata: metadata
  };

  const results = await processDocumentsSimple([doc], aiConfig, options.onProgress);

  return results['single-doc'] || blocks;
}
