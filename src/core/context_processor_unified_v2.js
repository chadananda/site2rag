// context_processor_unified_v2.js
// Unified sliding window implementation using improved AI client with proper context caching
import {z} from 'zod';
import {getAISessionV2, closeAISessionV2} from './ai_client_v2.js';
import debugLogger from '../services/debug_logger.js';
import {
  buildSlidingCacheInstructions,
  createOptimizedSlidingWindows,
  validateEnhancement
} from '../utils/context_utils.js';
// Schema for batch enhancement response
const BatchEnhancementSchema = z.object({
  enhanced_blocks: z.record(z.string())
});
// Constants for window sizing
const WINDOW_OVERLAP_PERCENT = 0.5; // 50% overlap
const CONTEXT_UTILIZATION = 0.8; // Use 80% of context window
const MIN_WINDOW_WORDS = 1000; // Minimum window size
const MAX_WINDOW_WORDS = 5000; // Cap window size to prevent huge prompts
/**
 * Process a single batch with built-in validation and retry logic
 * @param {Object} batch - Batch containing keyed blocks
 * @param {Object} session - AI session with cached context
 * @param {number} batchIndex - Index for polite delays
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Validated enhanced blocks
 */
async function processBatchWithRetry(batch, session, batchIndex) {
  const maxRetries = 3;
  const politeDelay = 500; // ms between batch starts
  
  // Initial polite delay based on batch index
  if (batchIndex > 0) {
    await new Promise(resolve => setTimeout(resolve, batchIndex * politeDelay));
  }
  
  let currentBatch = batch;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      debugLogger.batching(`Batch ${batchIndex + 1}: Attempt ${attempt}/${maxRetries}`);
      
      // Create prompt for current batch (just the blocks, not the full context)
      const prompt = createKeyedBatchPrompt(currentBatch.blocks);
      
      // Call AI with session (system context is already cached)
      const result = await session.call(prompt, BatchEnhancementSchema);
      
      if (!result || !result.enhanced_blocks) {
        throw new Error('Invalid AI response format');
      }
      
      // Validate results
      const validation = validateBatchResults(currentBatch.blocks, result.enhanced_blocks);
      
      if (validation.allValid) {
        debugLogger.batching(`Batch ${batchIndex + 1}: All blocks validated successfully`);
        return validation.validated;
      }
      
      // If not all valid and we have retries left, retry only failed blocks
      if (attempt < maxRetries && validation.failed.length > 0) {
        debugLogger.batching(`Batch ${batchIndex + 1}: Retrying ${validation.failed.length} failed blocks`);
        
        // Create new batch with only failed blocks
        const failedBlocks = {};
        for (const key of validation.failed) {
          failedBlocks[key] = currentBatch.blocks[key];
        }
        
        currentBatch = {
          blocks: failedBlocks,
          wordCount: Object.values(failedBlocks).join(' ').split(/\s+/).length
        };
        
        // Exponential backoff for retries
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } else {
        // No more retries, return what we have
        debugLogger.batching(`Batch ${batchIndex + 1}: Returning with ${validation.failed.length} blocks using original text`);
        return validation.validated;
      }
      
    } catch (error) {
      debugLogger.batching(`Batch ${batchIndex + 1}: Error on attempt ${attempt} - ${error.message}`);
      
      if (attempt === maxRetries) {
        // Final attempt failed, return original blocks
        const fallback = {};
        for (const [key, text] of Object.entries(currentBatch.blocks)) {
          fallback[key] = text;
        }
        return fallback;
      }
      
      // Wait before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}
/**
 * Validate batch results against original blocks
 */
function validateBatchResults(originalBlocks, enhancedBlocks) {
  const validated = {};
  const failed = [];
  
  for (const [key, originalText] of Object.entries(originalBlocks)) {
    const enhancedText = enhancedBlocks[key];
    
    if (!enhancedText) {
      debugLogger.batching(`Block ${key}: Missing in AI response`);
      failed.push(key);
      validated[key] = originalText; // Use original
      continue;
    }
    
    // Check if enhancement preserved the original text
    const validation = validateEnhancement(originalText, enhancedText);
    
    if (validation.isValid) {
      validated[key] = enhancedText;
    } else {
      debugLogger.batching(`Block ${key}: Validation failed - ${validation.error}`);
      failed.push(key);
      validated[key] = originalText; // Use original
    }
  }
  
  return {
    validated,
    failed,
    allValid: failed.length === 0
  };
}
/**
 * Create keyed blocks from input blocks
 */
function createKeyedBlocks(blocks, minChars = 30) {
  const keyedBlocks = {};
  let keyCounter = 1;
  
  for (const block of blocks) {
    // Handle both string blocks and object blocks with {text} property
    const blockText = typeof block === 'string' ? block : (block.text || '');
    
    // Skip very short blocks (headers, empty lines, etc)
    const textContent = blockText.replace(/[#*\-`>[\](){}]/g, '').trim();
    if (textContent.length < minChars) {
      continue;
    }
    
    const key = `BLOCK_${String(keyCounter).padStart(3, '0')}`;
    keyedBlocks[key] = blockText;
    keyCounter++;
  }
  
  return keyedBlocks;
}
/**
 * Create batches from keyed blocks
 */
function createBatches(keyedBlocks, targetBatchWords = 500) {
  const batches = [];
  let currentBatch = {blocks: {}, wordCount: 0};
  
  for (const [key, text] of Object.entries(keyedBlocks)) {
    const wordCount = text.split(/\s+/).length;
    
    // Start new batch if current would exceed target
    if (currentBatch.wordCount > 0 && currentBatch.wordCount + wordCount > targetBatchWords) {
      batches.push(currentBatch);
      currentBatch = {blocks: {}, wordCount: 0};
    }
    
    currentBatch.blocks[key] = text;
    currentBatch.wordCount += wordCount;
  }
  
  // Add final batch
  if (Object.keys(currentBatch.blocks).length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}
/**
 * Create prompt for a keyed batch (without the full context)
 */
function createKeyedBatchPrompt(blocks) {
  const blockEntries = Object.entries(blocks)
    .map(([key, text]) => `${key}:\n${text}`)
    .join('\n\n');
  
  return `Process these blocks and add context where needed:

${blockEntries}

Return ONLY a JSON object with "enhanced_blocks" containing the enhanced version of each block by its key.`;
}
/**
 * Get optimal window size for the AI model
 */
function getOptimalWindowSize(aiConfig) {
  // const provider = aiConfig.provider || 'ollama'; // Currently unused
  const model = aiConfig.model || '';
  
  // Model-specific context windows (in tokens)
  const contextWindows = {
    'gpt-4o': 128000,
    'gpt-4': 8192,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'llama3.2': 128000,
    'qwen2.5': 32768,
    'mistral-large': 32768
  };
  
  // Find matching model
  let contextTokens = 8192; // Default
  for (const [modelKey, tokens] of Object.entries(contextWindows)) {
    if (model.toLowerCase().includes(modelKey)) {
      contextTokens = tokens;
      break;
    }
  }
  
  // Apply utilization factor and convert to words (1 token ≈ 0.75 words)
  const usableTokens = contextTokens * CONTEXT_UTILIZATION;
  const optimalWords = Math.floor(usableTokens * 0.75);
  
  // Apply min/max bounds
  const boundedWords = Math.max(MIN_WINDOW_WORDS, Math.min(MAX_WINDOW_WORDS, optimalWords));
  
  debugLogger.ai(`Window sizing - Model: ${model}, Context: ${contextTokens} tokens, Optimal: ${optimalWords} words, Bounded: ${boundedWords} words`);
  
  return boundedWords;
}
/**
 * Main unified enhancement function using improved AI client
 */
export async function enhanceDocumentUnifiedV2(blocks, metadata, aiConfig, options = {}) {
  const sessionId = `unified-${Date.now()}`;
  const progressCallback = options.onProgress || (() => {});
  
  try {
    debugLogger.ai('=== Starting Unified V2 Document Enhancement ===');
    
    // Validate inputs
    if (!blocks) {
      debugLogger.ai('ERROR: blocks is undefined or null');
      return [];
    }
    
    if (!Array.isArray(blocks)) {
      debugLogger.ai(`ERROR: blocks is not an array, got: ${typeof blocks}`);
      return [];
    }
    
    debugLogger.ai(`Total blocks: ${blocks.length}`);
    debugLogger.ai(`AI Provider: ${aiConfig.provider || 'ollama'}`);
    debugLogger.ai(`AI Model: ${aiConfig.model || 'default'}`);
    
    // Create keyed blocks (filter short content)
    const keyedBlocks = createKeyedBlocks(blocks);
    const totalKeyedBlocks = Object.keys(keyedBlocks).length;
    
    debugLogger.ai(`Keyed blocks for processing: ${totalKeyedBlocks} (filtered from ${blocks.length})`);
    
    if (totalKeyedBlocks === 0) {
      debugLogger.ai('No blocks to process after filtering');
      return blocks;
    }
    
    // Get AI session with improved client
    const session = getAISessionV2(sessionId, aiConfig);
    
    // Build and cache context instructions
    const contextInstructions = buildSlidingCacheInstructions(metadata);
    session.setSystemContext(contextInstructions);
    
    debugLogger.ai(`System context cached: ${contextInstructions.length} chars`);
    
    // Calculate optimal window size
    const windowSizeWords = getOptimalWindowSize(aiConfig);
    const totalWords = Object.values(keyedBlocks).join(' ').split(/\s+/).length;
    
    debugLogger.ai(`Document size: ${totalWords} words, Window size: ${windowSizeWords} words`);
    
    // Create sliding windows
    const windows = createOptimizedSlidingWindows(
      Object.entries(keyedBlocks).map(([key, text]) => ({key, text})),
      windowSizeWords,
      WINDOW_OVERLAP_PERCENT
    );
    
    debugLogger.ai(`Created ${windows.length} sliding windows`);
    
    // Process all windows
    const allEnhancedBlocks = {};
    let processedBlocks = 0;
    
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
      const window = windows[windowIndex];
      debugLogger.ai(`\n--- Processing Window ${windowIndex + 1}/${windows.length} ---`);
      debugLogger.ai(`Window blocks: ${window.blocks.length}, Words: ${window.wordCount}`);
      
      // Update progress
      progressCallback(processedBlocks, totalKeyedBlocks);
      
      // Extract blocks for this window
      const windowKeyedBlocks = {};
      for (const block of window.blocks) {
        windowKeyedBlocks[block.key] = block.text;
      }
      
      // Create batches from window blocks
      const batches = createBatches(windowKeyedBlocks);
      debugLogger.ai(`Window ${windowIndex + 1}: Created ${batches.length} batches`);
      
      // Process all batches in parallel
      const batchPromises = batches.map((batch, index) => 
        processBatchWithRetry(batch, session, index, options)
      );
      
      // Wait for all batches to complete
      debugLogger.ai(`Window ${windowIndex + 1}: Processing ${batches.length} batches in parallel...`);
      const batchResults = await Promise.all(batchPromises);
      
      // Merge batch results
      for (const batchResult of batchResults) {
        Object.assign(allEnhancedBlocks, batchResult);
      }
      
      processedBlocks += window.blocks.length;
      debugLogger.ai(`Window ${windowIndex + 1}: Completed. Total processed: ${processedBlocks}/${totalKeyedBlocks}`);
    }
    
    // Final progress update
    progressCallback(totalKeyedBlocks, totalKeyedBlocks);
    
    // Map enhanced keyed blocks back to original blocks
    const enhancedBlocksArray = [];
    // const keyToIndex = new Map(); // Currently unused
    let keyCounter = 1;
    
    // Build mapping of keys to enhanced content
    const enhancedByKey = new Map();
    for (const [key, text] of Object.entries(allEnhancedBlocks)) {
      enhancedByKey.set(key, text);
    }
    
    // Process original blocks in order
    for (const originalBlock of blocks) {
      // Handle both string blocks and object blocks with {text} property
      const blockText = typeof originalBlock === 'string' ? originalBlock : (originalBlock.text || '');
      const textContent = blockText.replace(/[#*\-`>[\](){}]/g, '').trim();
      
      // Skip if too short (wasn't processed)
      if (textContent.length < 30) {
        enhancedBlocksArray.push(originalBlock);
        continue;
      }
      
      // Find corresponding enhanced block
      const key = `BLOCK_${String(keyCounter).padStart(3, '0')}`;
      const enhanced = enhancedByKey.get(key);
      
      if (enhanced) {
        // If original was an object, return object with enhanced text
        if (typeof originalBlock === 'object' && originalBlock.text) {
          enhancedBlocksArray.push({...originalBlock, text: enhanced});
        } else {
          enhancedBlocksArray.push(enhanced);
        }
        keyCounter++;
      } else {
        enhancedBlocksArray.push(originalBlock);
      }
    }
    
    // Get session metrics
    const metrics = closeAISessionV2(sessionId);
    debugLogger.ai(`\n=== Enhancement Complete ===`);
    debugLogger.ai(`Session metrics: ${JSON.stringify(metrics, null, 2)}`);
    
    // Return in the format expected by the caller
    return {
      blocks: enhancedBlocksArray.map((block, index) => ({
        original: typeof blocks[index] === 'string' ? blocks[index] : blocks[index].text,
        contexted: typeof block === 'string' ? block : block.text
      }))
    };
    
  } catch (error) {
    console.error(`[UNIFIED V2] Enhancement failed: ${error.message}`);
    debugLogger.ai(`Enhancement error: ${error.stack}`);
    closeAISessionV2(sessionId);
    throw error;
  }
}