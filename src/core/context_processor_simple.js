// context_processor_simple.js
// Simplified sliding window context processor with full parallelization
//
// IMPORTANT: Never use console.log - always use debugLogger to avoid breaking progress bar
//
// Optimizations:
// - Optimal window sizes: 1200/600 for simple models (tested with Claude Haiku)
// - Minimum block size: 100 chars to skip trivial content
// - Simplified metadata by removing redundant SEO/social fields
// - Streamlined prompts without redundant examples
// - Simple text output format for mini models (no JSON constraints)
// - Headers included in context but not processed for disambiguation
// - Strip code blocks, images, and links from context to save tokens
import {z} from 'zod';
import pLimit from 'p-limit';
import {callAI} from './ai_client.js';
import debugLogger from '../services/debug_logger.js';
import {validateEnhancement} from '../utils/context_utils.js';

// Schema for AI response - simple text format for mini models
const WindowEnhancementSchema = z.object({
  enhanced_blocks: z.record(z.string(), z.string())
});

// Window size configurations based on model type
const WINDOW_SIZES = {
  DEFAULT: {context: 1000, process: 1000},
  MINI: {context: 1200, process: 600} // Optimal for GPT-4o-mini, Claude Haiku
};

// Window size test results for simple models:
// - 700/300: 3-4 disambiguations
// - 800/400: 4 disambiguations
// - 1000/500: 4 disambiguations
// - 1200/600: 5 disambiguations (optimal)
// - 1300/700: 4 disambiguations
// - 1500/800: 1 disambiguation (quality degrades)

// Content filtering thresholds
const MIN_BLOCK_CHARS = process.env.SITE2RAG_MIN_BLOCK_CHARS ? parseInt(process.env.SITE2RAG_MIN_BLOCK_CHARS) : 100; // Skip very short blocks to save tokens

/**
 * Check if the AI model requires simplified prompts and smaller context windows
 * @param {Object} aiConfig - AI configuration
 * @returns {boolean} True if model needs simplified prompts
 */
function isSimplifiedPromptModel(aiConfig) {
  const simpleModels = ['gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-3.5'];
  // Note: We do NOT include Haiku here - it should use the detailed prompts
  return aiConfig.model && simpleModels.some(m => aiConfig.model.includes(m));
}

/**
 * Clean text for context by removing markdown formatting, code blocks, images, and links
 * This reduces token usage while preserving the semantic content needed for disambiguation
 * @param {string} text - Raw markdown text
 * @returns {string} Cleaned plain text
 */
export function cleanTextForContext(text) {
  if (!text) return '';
  if (typeof text !== 'string') {
    debugLogger.ai(`Warning: cleanTextForContext received non-string input: ${typeof text}`);
    return '';
  }

  try {
    // Single-pass regex for better performance
    // This combines multiple operations:
    // 1. Code blocks (``` or indented)
    // 2. Images ![alt](url)
    // 3. Links [text](url) -> keep text
    // 4. HTML tags
    const cleaned = text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(/^(\s{4}|\t).+$/gm, ' [code] ')
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' ')
      // Replace links with just the text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove HTML tags
      .replace(/<[^>]+>/g, ' ')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();

    // Validate cleaned text
    if (!cleaned || cleaned.length === 0) {
      debugLogger.ai(`Warning: cleanTextForContext produced empty result from ${text.length} char input`);
      // Fall back to basic whitespace normalization
      return text.replace(/\s+/g, ' ').trim();
    }

    return cleaned;
  } catch (error) {
    // Log the specific error and input details for debugging
    debugLogger.ai(`Error in cleanTextForContext: ${error.message}, input length: ${text.length}`);
    // Attempt basic cleanup as fallback
    try {
      return text.replace(/\s+/g, ' ').trim();
    } catch (fallbackError) {
      debugLogger.ai(`Fallback cleaning also failed: ${fallbackError.message}`);
      return text.substring(0, 1000); // Return truncated original as last resort
    }
  }
}

/**
 * Create sliding windows from document blocks
 * Each window has context from previous window and new blocks to process
 * @param {Array} blocks - Document blocks
 * @param {Object} aiConfig - AI configuration to determine window sizes
 * @returns {Array} Windows with context and blocks to process
 */
function createSlidingWindows(blocks, aiConfig) {
  const windows = [];
  let processedBlockIndex = 0;
  let previousText = ''; // Accumulate text for context

  // Use appropriate window sizes based on model type
  const useSimplified = isSimplifiedPromptModel(aiConfig);
  const CONTEXT_WORDS = useSimplified ? WINDOW_SIZES.MINI.context : WINDOW_SIZES.DEFAULT.context;
  const PROCESS_WORDS = useSimplified ? WINDOW_SIZES.MINI.process : WINDOW_SIZES.DEFAULT.process;

  while (processedBlockIndex < blocks.length) {
    // Collect blocks for this window
    const windowBlocks = {};
    const blockIndices = []; // Track which original indices we're processing
    let windowWords = 0;
    const startIndex = processedBlockIndex;

    while (processedBlockIndex < blocks.length && windowWords < PROCESS_WORDS) {
      const block = blocks[processedBlockIndex];
      const blockText = typeof block === 'string' ? block : block.text || block;

      // Skip headers (lines starting with #) from processing but include in context
      if (blockText.trim().startsWith('#')) {
        // Add cleaned version to context but don't process
        previousText += ' ' + cleanTextForContext(blockText);
        processedBlockIndex++;
        continue;
      }

      // Skip code blocks entirely (they don't need disambiguation)
      if (blockText.trim().startsWith('```') || /^(\s{4}|\t)/.test(blockText)) {
        // Add placeholder to context for continuity
        previousText += ' [code block] ';
        processedBlockIndex++;
        continue;
      }

      // Skip empty blocks and blocks that are too short
      if (blockText.trim().length < MIN_BLOCK_CHARS) {
        // Still add cleaned version to context for continuity
        previousText += ' ' + cleanTextForContext(blockText);
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
    // Add cleaned version of the text we just processed
    const processedText = Object.values(windowBlocks)
      .map(block => cleanTextForContext(block))
      .join(' ');

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
 * Simplify metadata to reduce token usage by removing redundant fields
 * @param {Object} metadata - Full document metadata
 * @returns {Object} Simplified metadata keeping contextually useful fields
 * @throws {Error} If metadata is missing required fields
 */
export function simplifyMetadata(metadata) {
  if (!metadata) {
    throw new Error('Metadata is required for context processing');
  }

  // Pass through all metadata fields now that they're clean
  // The AI can use any of this context for better disambiguation
  const simplified = {
    ...metadata,
    // Ensure critical fields have defaults
    title: metadata.title || 'Unknown Document',
    url: metadata.url || 'Unknown URL'
  };

  // Ensure we have at least a title or URL for context
  if (simplified.title === 'Unknown Document' && simplified.url === 'Unknown URL') {
    debugLogger.ai('Warning: Document has no identifiable title or URL');
  }

  return simplified;
  // Skip redundant fields: og_title (duplicates title), og_description (duplicates description),
  // twitter_title, twitter_description, og_image, twitter_image, viewport, robots, etc.
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
  const useSimplifiedPrompt = isSimplifiedPromptModel(aiConfig);
  const simplifiedMetadata = simplifyMetadata(metadata);

  // Debug log the metadata being used
  debugLogger.ai(`Creating prompt with metadata: author="${simplifiedMetadata.author}", org="${simplifiedMetadata.authorOrganization}"`);
  
  let prompt;
  if (useSimplifiedPrompt) {
    // Simplified prompt for models like GPT-4o-mini - NO JSON for better results
    prompt = `Add [[clarifications]] to make each paragraph stand alone. Use ONLY information from THIS document.

WHAT TO CLARIFY:
• "I" → "I [[Chad Jones]]" (using author from metadata)
• "we/our" → "we [[specific team/group mentioned in doc]]"
• "this/that" → "this [[specific thing referenced]]"
• "it" → "it [[the specific item]]"
• "the project" → "the project [[Ocean]]"
• "the software" → "the software [[Ocean]]"
• Generic terms like "the CDs" when specific type is known

❌ FORBIDDEN - NEVER ADD:
• Definitions: "PC [[personal computer]]" ✗
• Locations: "S̱híráz [[a city in Iran]]" ✗
• Explanations: "controversy [[disagreement]]" ✗
• External facts: "Lotus Temple [[a Bahá'í House of Worship]]" ✗
• Info not in document: "Dawn-Breakers [[a Bahá'í text]]" ✗

✓ GOOD EXAMPLES:
• "I started this" → "I [[Chad Jones]] started this [[Ocean project]]"
• "We developed it" → "We [[the Ocean team]] developed it [[Ocean]]"
• "This was amazing" → "This [[visiting the Lotus Temple]] was amazing"

Only disambiguate if genuinely unclear. Skip if already clear from context.

========= DOCUMENT META-DATA:

${Object.entries(simplifiedMetadata)
  .filter(([, value]) => value && value !== '')
  .map(([key, value]) => {
    // Format key nicely (camelCase to Title Case)
    const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim();
    return `${formattedKey}: ${value}`;
  })
  .join('\n')}

========= PREVIOUS CONTEXT:

${window.context || '(This is the beginning of the document)'}

========= TEXT TO PROCESS:

${JSON.stringify(window.blocks, null, 0)}

========= OUTPUT FORMAT:

Return JSON with "enhanced_blocks" containing the same text with [[clarifications]] added.
Example: {"enhanced_blocks": {"0": "Text with [[clarification]]...", "1": "Another text..."}}`;
  } else {
    // More detailed prompt for advanced models
    prompt = `Disambiguate pronouns and vague references. Use ONLY information from THIS document.

TARGET THESE AMBIGUOUS REFERENCES:
1. Pronouns: I, we, our, they, their, he, she, it
2. Demonstratives: this, that, these, those
3. Generic terms: the project, the software, the team, the CDs
4. Unclear references that need context

APPLY THESE CLARIFICATIONS:
• "I" → "I [[Chad Jones]]" (from metadata author)
• "we/our" → "we [[the Ocean team]]" or specific group from doc
• "this/that" → add what it refers to from context
• "the project" → "the project [[Ocean]]"
• "it" → specify what "it" refers to

STRICT FORBIDDEN LIST:
✗ "PC" → "PC [[personal computer]]" - NO definitions!
✗ "S̱híráz" → "S̱híráz [[a city in Iran]]" - NO geography!
✗ "Lotus Temple" → "Lotus Temple [[a Bahá'í House of Worship]]" - NO descriptions!
✗ Any info not explicitly in THIS document

EXAMPLES:
✓ "I started this project" → "I [[Chad Jones]] started this project [[Ocean]]"
✓ "We achieved it" → "We [[the Ocean team]] achieved it [[distributing Ocean globally]]"
✓ "This was incredible" → "This [[the response from communities]] was incredible"

Return JSON: {"enhanced_blocks": {"0": "text with [[context]]", "1": "text with [[context]]", ...}}

========= DOCUMENT META-DATA:

${Object.entries(simplifiedMetadata)
  .filter(([, value]) => value && value !== '')
  .map(([key, value]) => {
    // Format key nicely (camelCase to Title Case)
    const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim();
    return `${formattedKey}: ${value}`;
  })
  .join('\n')}

========= PREVIOUS CONTEXT:

${window.context || '(This is the beginning of the document)'}

========= BLOCKS TO PROCESS:

${JSON.stringify(window.blocks, null, 0)}`;
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
    const windows = createSlidingWindows(doc.blocks, aiConfig);
    debugLogger.ai(`Document ${doc.docId}: Created ${windows.length} windows`);

    // Log window sizes for debugging
    debugLogger.ai(`Created ${windows.length} windows for processing:`);
    windows.forEach((w, i) => {
      debugLogger.ai(`  Window ${i}: ${Object.keys(w.blocks).length} blocks, ${w.wordCount} words`);
    });

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

        // Debug: Log prompt details for first window
        if (request.windowIndex === 0) {
          debugLogger.ai('\n========= AI PROCESSING DEBUG =========');
          debugLogger.ai('Document:', request.docId);
          debugLogger.ai('Window:', request.windowIndex);
          debugLogger.ai('Number of blocks to process:', Object.keys(request.window.blocks).length);
          debugLogger.ai('Block keys:', Object.keys(request.window.blocks));
          debugLogger.ai('\n--- PROMPT PREVIEW (first 500 chars) ---');
          debugLogger.ai(request.prompt.substring(0, 500) + '...');
          debugLogger.ai('\n--- BLOCKS BEING SENT ---');
          debugLogger.ai(JSON.stringify(request.window.blocks, null, 2));
          debugLogger.ai('======================================\n');
        }

        // Track token savings metrics
        const originalPromptLength = JSON.stringify(request.window.blocks).length;
        const cleanedContextLength = request.prompt.length;
        const tokenSavingsEstimate = Math.round((1 - cleanedContextLength / originalPromptLength) * 100);

        if (request.windowIndex === 0) {
          debugLogger.ai(`Token savings estimate: ${tokenSavingsEstimate}% reduction`);
        }

        // Call AI with the request
        const response = await callAI(request.prompt, WindowEnhancementSchema, aiConfig);

        if (!response || !response.enhanced_blocks) {
          throw new Error('Invalid AI response format');
        }

        // Debug: Log AI response for first window
        if (request.windowIndex === 0) {
          debugLogger.ai('\n--- AI RESPONSE ---');
          debugLogger.ai('Number of blocks returned:', Object.keys(response.enhanced_blocks).length);
          debugLogger.ai('Response preview:', JSON.stringify(response.enhanced_blocks).substring(0, 300) + '...');

          // Check if response has same keys as input
          const inputKeys = Object.keys(request.window.blocks).sort();
          const outputKeys = Object.keys(response.enhanced_blocks).sort();
          debugLogger.ai('Input keys:', inputKeys);
          debugLogger.ai('Output keys:', outputKeys);
          debugLogger.ai('Keys match:', JSON.stringify(inputKeys) === JSON.stringify(outputKeys));
          debugLogger.ai('==================\n');
        }

        // Validate enhancements
        const validatedBlocks = {};
        let validationFailures = 0;
        for (const [key, original] of Object.entries(request.window.blocks)) {
          const enhanced = response.enhanced_blocks[key];
          if (enhanced) {
            const validation = validateEnhancement(original, enhanced);
            if (validation.isValid) {
              validatedBlocks[key] = enhanced;
              // Log successful enhancements
              const disambiguations = (enhanced.match(/\[\[.*?\]\]/g) || []).length;
              if (disambiguations > 0) {
                debugLogger.ai(`✓ Block ${key}: Added ${disambiguations} disambiguations`);
              }
            } else {
              validationFailures++;
              debugLogger.ai(`✗ Block ${key}: Validation failed - ${validation.error}`);
              debugLogger.ai(`  Original: "${original.substring(0, 100)}..."`);
              debugLogger.ai(`  Enhanced: "${enhanced.substring(0, 100)}..."`);
              validatedBlocks[key] = original; // Use original on validation failure
            }
          } else {
            validatedBlocks[key] = original; // Use original if not returned
          }
        }

        // Log validation summary if there were failures
        if (validationFailures > 0) {
          debugLogger.ai(
            `Window ${request.windowIndex}: ${validationFailures} validation failures out of ${Object.keys(request.window.blocks).length} blocks`
          );
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
