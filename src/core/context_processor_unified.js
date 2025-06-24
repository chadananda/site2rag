// context_processor_unified.js
// Unified sliding window + keyed blocks implementation with validation and retry

import {z} from 'zod';
import {callAI, getAISession, closeAISession} from './ai_client.js';
import debugLogger from '../services/debug_logger.js';
import {
  buildSlidingCacheInstructions,
  createOptimizedSlidingWindows,
  validateEnhancement,
  extractContextInsertions
} from '../utils/context_utils.js';

// Schema for batch enhancement response
const BatchEnhancementSchema = z.object({
  enhanced_blocks: z.record(z.string())
});

/**
 * Process a single batch with built-in validation and retry logic
 * @param {Object} batch - Batch containing keyed blocks
 * @param {Object} session - AI session with cached context
 * @param {number} batchIndex - Index for polite delays
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Validated enhanced blocks
 */
async function processBatchWithRetry(batch, session, batchIndex, options = {}) {
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
      
      // Create prompt for current batch
      const prompt = createKeyedBatchPrompt(currentBatch.blocks);
      
      // Call AI with session (uses cached context)
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
 * Validate batch results, checking word preservation for blocks with insertions
 * @param {Object} originalBlocks - Original keyed blocks
 * @param {Object} enhancedBlocks - Enhanced blocks from AI
 * @returns {Object} Validation results
 */
function validateBatchResults(originalBlocks, enhancedBlocks) {
  const validated = {};
  const failed = [];
  let allValid = true;
  
  for (const [key, original] of Object.entries(originalBlocks)) {
    const enhanced = enhancedBlocks[key];
    
    if (!enhanced) {
      // AI didn't return this block, use original
      validated[key] = original;
      failed.push(key);
      allValid = false;
      continue;
    }
    
    // Check if block has insertions
    const hasInsertions = enhanced.includes('[[') && enhanced.includes(']]');
    
    if (hasInsertions) {
      // Validate word preservation
      if (validateEnhancement(original, enhanced)) {
        validated[key] = enhanced;
      } else {
        // Validation failed, will retry this block
        validated[key] = original; // Use original as fallback
        failed.push(key);
        allValid = false;
        debugLogger.validation(`Block ${key} failed validation`);
      }
    } else {
      // No insertions, use original (no need to validate)
      validated[key] = original;
    }
  }
  
  return {validated, failed, allValid};
}

/**
 * Create prompt for keyed batch processing
 * @param {Object} keyedBlocks - Blocks to process
 * @returns {string} Formatted prompt
 */
function createKeyedBatchPrompt(keyedBlocks) {
  const entries = Object.entries(keyedBlocks);
  
  return `## Blocks to Enhance

Please enhance the following blocks by adding context disambiguations using [[...]] notation.

${entries.map(([key, text]) => `### ${key}\n${text}`).join('\n\n')}

## Response Format

Return a JSON object with "enhanced_blocks" containing the same keys:
{
  "enhanced_blocks": {
    "${entries[0][0]}": "enhanced text with [[context]] insertions",
    ${entries.slice(1).map(([key]) => `"${key}": "enhanced text"`).join(',\n    ')}
  }
}

Remember:
- Only add [[...]] for ambiguous references
- Preserve all original text exactly
- Use information from the document context window
- Return valid JSON only`;
}

/**
 * Convert blocks to keyed format with filtering
 * @param {Array} blocks - Document blocks
 * @param {number} minChars - Minimum text characters (default 100)
 * @returns {Object} Keyed blocks and index mapping
 */
function createKeyedBlocks(blocks, minChars = 100) {
  const keyedBlocks = {};
  const indexMapping = {};
  
  blocks.forEach((block, index) => {
    // Extract text content only (no markdown formatting)
    const textOnly = (block.text || block.content || block)
      .replace(/[#*`\[\]()\-_]/g, '')
      .trim();
    
    if (textOnly.length >= minChars) {
      const key = `block_${index}`;
      keyedBlocks[key] = block.text || block.content || block;
      indexMapping[key] = index;
    }
  });
  
  return {keyedBlocks, indexMapping};
}

/**
 * Create optimized batches from keyed blocks
 * @param {Object} keyedBlocks - Keyed blocks
 * @param {number} targetWords - Target words per batch (default 500)
 * @returns {Array} Array of batches
 */
function createOptimizedBatches(keyedBlocks, targetWords = 500) {
  const batches = [];
  let currentBatch = {blocks: {}, wordCount: 0};
  
  for (const [key, text] of Object.entries(keyedBlocks)) {
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    
    // Start new batch if adding this block would exceed target
    if (currentBatch.wordCount > 0 && currentBatch.wordCount + wordCount > targetWords) {
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
  
  debugLogger.batching(`Created ${batches.length} batches from ${Object.keys(keyedBlocks).length} blocks`);
  return batches;
}

/**
 * Main unified context enhancement function
 * Always uses sliding windows (often just 1) with keyed block processing
 * @param {Array} blocks - Document blocks to enhance
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Enhanced blocks and metrics
 */
export async function enhanceDocumentUnified(blocks, metadata, aiConfig, options = {}) {
  const startTime = Date.now();
  const isTestMode = options.test || process.env.NODE_ENV === 'test';
  
  // Calculate window capacity
  const capacity = calculateWindowCapacity(aiConfig);
  
  // Create sliding windows (often just 1 for small docs)
  const windows = createOptimizedSlidingWindows(
    blocks, 
    capacity.windowSize, 
    capacity.overlapSize,
    isTestMode
  );
  
  debugLogger.context(`Processing ${blocks.length} blocks in ${windows.length} window(s)`);
  
  // Initialize session for caching
  const sessionId = `unified-${Date.now()}`;
  const session = getAISession(sessionId, aiConfig);
  
  // Build static instructions
  const instructions = buildSlidingCacheInstructions(metadata);
  
  // Process results
  const allResults = new Array(blocks.length);
  
  try {
    // Process each window
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
      const window = windows[windowIndex];
      
      debugLogger.context(`Processing window ${windowIndex + 1}/${windows.length} (${window.actualWordCount} words)`);
      
      // Set cached context for this window
      const cachedContext = `${instructions}

## Document Context Window ${windowIndex + 1}
${window.contextText}`;
      
      session.setCachedContext(cachedContext);
      debugLogger.context(`Cached context: ${cachedContext.length} chars`);
      
      // Process all paragraphs in this window
      for (const batch of window.paragraphBatches) {
        // Get blocks for this batch
        const batchBlocks = [];
        for (const idx of batch.blockIndices) {
          if (blocks[idx]) {
            batchBlocks.push({
              text: blocks[idx].text || blocks[idx].content || blocks[idx],
              originalIndex: idx
            });
          }
        }
        
        // Convert to keyed blocks
        const {keyedBlocks, indexMapping} = createKeyedBlocks(batchBlocks);
        
        if (Object.keys(keyedBlocks).length === 0) {
          debugLogger.batching('No blocks met minimum character threshold in this batch');
          continue;
        }
        
        // Create optimized batches
        const batches = createOptimizedBatches(keyedBlocks);
        
        // Process all batches in parallel
        debugLogger.batching(`Processing ${batches.length} batches in parallel for window ${windowIndex + 1}`);
        
        const batchPromises = batches.map((batch, batchIdx) => 
          processBatchWithRetry(batch, session, batchIdx, options)
        );
        
        // Wait for ALL batches to complete before moving to next window
        const batchResults = await Promise.all(batchPromises);
        
        // Merge results back to original indices
        batchResults.forEach((result, batchIdx) => {
          for (const [key, enhancedText] of Object.entries(result)) {
            const originalIdx = indexMapping[key];
            if (originalIdx !== undefined) {
              const blockData = batchBlocks.find(b => b.originalIndex === originalIdx);
              if (blockData) {
                allResults[originalIdx] = {
                  original: blockData.text,
                  contexted: enhancedText
                };
                
                // Track insertions in test mode
                if (isTestMode) {
                  const insertions = extractContextInsertions(enhancedText);
                  if (insertions.length > 0) {
                    console.log(`[TEST] Block ${originalIdx}: ${insertions.length} insertions`);
                  }
                }
              }
            }
          }
        });
      }
      
      debugLogger.context(`Window ${windowIndex + 1} complete`);
    }
    
    // Get session metrics
    const metrics = session.getMetrics();
    
    // Close session
    closeAISession(sessionId);
    
    // Fill in any missing blocks with originals
    for (let i = 0; i < blocks.length; i++) {
      if (!allResults[i]) {
        allResults[i] = {
          original: blocks[i].text || blocks[i].content || blocks[i],
          contexted: blocks[i].text || blocks[i].content || blocks[i]
        };
      }
    }
    
    const processingTime = Date.now() - startTime;
    
    return {
      blocks: allResults,
      metrics: {
        windows: windows.length,
        blocksProcessed: allResults.length,
        processingTime,
        cacheMetrics: metrics
      }
    };
    
  } catch (error) {
    closeAISession(sessionId);
    throw error;
  }
}

/**
 * Calculate window capacity based on AI model
 * @param {Object} aiConfig - AI configuration
 * @returns {Object} Window sizing parameters
 */
function calculateWindowCapacity(aiConfig) {
  // Model-specific limits (using 80% for safety)
  const modelLimits = {
    'gpt-4-turbo': {tokens: 128000, safe: 102400},
    'gpt-4o': {tokens: 128000, safe: 102400},
    'claude-3-opus': {tokens: 200000, safe: 160000},
    'claude-3-sonnet': {tokens: 200000, safe: 160000},
    'llama-3.2': {tokens: 4096, safe: 3276},
    'qwen2.5': {tokens: 32768, safe: 26214},
    default: {tokens: 4096, safe: 3276}
  };
  
  const model = aiConfig.model?.toLowerCase() || 'default';
  const limits = Object.entries(modelLimits).find(([key]) => 
    model.includes(key)
  )?.[1] || modelLimits.default;
  
  // Reserve space for instructions and response
  const reservedTokens = 1500;
  const availableTokens = limits.safe - reservedTokens;
  const windowWords = Math.floor(availableTokens * 0.75); // ~0.75 words per token
  
  return {
    windowSize: windowWords,
    overlapSize: Math.floor(windowWords * 0.5) // 50% overlap
  };
}

// For backward compatibility, maintain the original function name
export async function enhanceBlocksWithCaching(blocks, metadata, aiConfig, options = {}) {
  return enhanceDocumentUnified(blocks, metadata, aiConfig, options);
}