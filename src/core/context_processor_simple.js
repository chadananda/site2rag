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
import {aiRequestTracker} from './ai_request_tracker.js';

// Schema for AI response - plain text for better model compatibility
const PlainTextResponseSchema = z.string();

/**
 * Strict validation that ensures ONLY context insertions are added
 * @param {string} original - Original text
 * @param {string} enhanced - Enhanced text with [[context]] insertions
 * @returns {Object} Validation result
 */
function strictValidateEnhancement(original, enhanced) {
  if (!original || !enhanced) {
    return {
      isValid: false,
      error: 'Missing original or enhanced text'
    };
  }

  // Remove [[...]] insertions from enhanced text
  const enhancedWithoutContext = enhanced.replace(/\s*\[\[.*?\]\]/g, '');

  // Only normalize whitespace - no other modifications allowed
  const normalizedOriginal = original.replace(/\s+/g, ' ').trim();
  const normalizedEnhanced = enhancedWithoutContext.replace(/\s+/g, ' ').trim();

  // Must match exactly after removing insertions and normalizing whitespace
  const isValid = normalizedOriginal === normalizedEnhanced;

  if (!isValid) {
    return {
      isValid: false,
      error: 'Enhanced text modifies the original content (only [[context]] insertions are allowed)'
    };
  }

  return {
    isValid: true,
    error: null
  };
}

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
const MIN_BLOCK_CHARS = process.env.SITE2RAG_MIN_BLOCK_CHARS ? parseInt(process.env.SITE2RAG_MIN_BLOCK_CHARS) : 20; // Skip only extremely short blocks (less than ~3 words)

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
 * Each window is completely independent with its own context for parallel processing
 * @param {Array} blocks - Document blocks
 * @returns {Array} Windows with context and blocks to process
 */
function createSlidingWindows(blocks) {
  const windows = [];
  let processedBlockIndex = 0;
  const globalProcessedBlocks = new Set(); // Track all blocks that have been added to any window

  // Use optimal window sizes for all models
  const CONTEXT_WORDS = WINDOW_SIZES.MINI.context;
  const PROCESS_WORDS = WINDOW_SIZES.MINI.process;

  // Pre-process all blocks to create a cleaned text array for context generation
  const allCleanedBlocks = blocks.map((block, idx) => {
    const blockText = typeof block === 'string' ? block : block.text || '';
    // Ensure blockText is a string
    if (typeof blockText !== 'string') {
      debugLogger.ai(`Warning: Block ${idx} is not a string:`, block);
      return {
        original: '',
        cleaned: '',
        index: idx,
        words: 0
      };
    }
    return {
      original: blockText,
      cleaned: cleanTextForContext(blockText),
      index: idx,
      words: blockText.split(/\s+/).length
    };
  });

  while (processedBlockIndex < blocks.length) {
    // Collect blocks for this window
    const windowBlocks = {};
    const blockIndices = []; // Track which original indices we're processing
    let windowWords = 0;
    const startIndex = processedBlockIndex;
    let currentWindowIndex = processedBlockIndex;

    while (currentWindowIndex < blocks.length && windowWords < PROCESS_WORDS) {
      const block = blocks[currentWindowIndex];
      const blockText = typeof block === 'string' ? block : block.text || '';

      // Skip headers (lines starting with #) from processing but not from iteration
      if (blockText.trim().startsWith('#')) {
        currentWindowIndex++;
        continue;
      }

      // Skip code blocks entirely (they don't need disambiguation)
      if (blockText.trim().startsWith('```') || /^(\s{4}|\t)/.test(blockText)) {
        currentWindowIndex++;
        continue;
      }

      // Skip empty blocks and blocks that are too short
      if (blockText.trim().length < MIN_BLOCK_CHARS) {
        debugLogger.ai(`Skipping short block (${blockText.trim().length} chars): "${blockText.substring(0, 50)}..."`);
        currentWindowIndex++;
        continue;
      }

      // Skip image blocks (they don't need disambiguation)
      if (blockText.trim().startsWith('![')) {
        debugLogger.ai(`Skipping image block: "${blockText.substring(0, 50)}..."`);
        currentWindowIndex++;
        continue;
      }

      // Track original index - use originalIndex if available (from filtered blocks), otherwise use current index
      const originalIdx = block.originalIndex !== undefined ? block.originalIndex : currentWindowIndex;
      const key = String(originalIdx);

      // Check if this block was already processed in a previous window
      if (windowBlocks[key]) {
        debugLogger.ai(`WARNING: Block ${originalIdx} already in current window!`);
      }

      // Check if this block was processed in any previous window
      if (globalProcessedBlocks.has(originalIdx)) {
        debugLogger.ai(
          `ERROR: Block ${originalIdx} was already processed in a previous window! This will cause duplicate processing.`
        );
      }
      globalProcessedBlocks.add(originalIdx);

      windowBlocks[key] = blockText;
      blockIndices.push(originalIdx);

      windowWords += blockText.split(/\s+/).length;
      currentWindowIndex++;
    }

    // Update processedBlockIndex to continue from where we left off
    processedBlockIndex = currentWindowIndex;

    // Skip empty windows
    if (Object.keys(windowBlocks).length === 0) {
      if (processedBlockIndex < blocks.length) {
        processedBlockIndex++;
        continue;
      }
      break;
    }

    // Build context independently for this window
    // Include ALL text before the current window's start, up to CONTEXT_WORDS limit
    let contextWords = [];
    let wordCount = 0;

    // Work backwards from the start of the current window to build context
    for (let i = startIndex - 1; i >= 0 && wordCount < CONTEXT_WORDS; i--) {
      const cleanedBlock = allCleanedBlocks[i];
      const blockWords = cleanedBlock.cleaned.split(/\s+/).filter(w => w.length > 0);

      // If adding this block would exceed the limit, only add partial
      if (wordCount + blockWords.length > CONTEXT_WORDS) {
        const wordsToTake = CONTEXT_WORDS - wordCount;
        // Take the last N words from this block
        contextWords.unshift(...blockWords.slice(-wordsToTake));
        break;
      } else {
        contextWords.unshift(...blockWords);
        wordCount += blockWords.length;
      }
    }

    const context = contextWords.join(' ');

    // Create window
    const newWindow = {
      windowIndex: windows.length,
      startBlockIndex: startIndex,
      endBlockIndex: currentWindowIndex - 1,
      blockIndices: blockIndices, // Store actual indices processed
      context: context || '(This is the beginning of the document)',
      blocks: windowBlocks,
      blockCount: Object.keys(windowBlocks).length,
      wordCount: windowWords
    };

    // Debug log window details
    debugLogger.ai(
      `Window ${newWindow.windowIndex}: Processing blocks ${blockIndices.join(', ')} (${newWindow.blockCount} blocks, ${newWindow.wordCount} words)`
    );

    // Log the first few words of each block for debugging
    if (process.env.DEBUG) {
      for (const [idx, text] of Object.entries(windowBlocks)) {
        const preview = text.substring(0, 50).replace(/\n/g, ' ');
        debugLogger.ai(`  Block ${idx}: "${preview}..."`);
      }
    }

    windows.push(newWindow);
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
 * @returns {Object} Request object
 */
function createWindowRequest(window, metadata, docId) {
  const simplifiedMetadata = simplifyMetadata(metadata);

  // Debug log the metadata being used
  debugLogger.ai(
    `Creating prompt with metadata: author="${simplifiedMetadata.author}", org="${simplifiedMetadata.authorOrganization}"`
  );

  // Use the simplified prompt for all models - it's clearer and more effective
  const prompt = `Add [[disambiguation]] to make each paragraph understandable when read in isolation.

CORE PRINCIPLE: If someone found just this paragraph in search results, would they understand what every reference means?

For each paragraph, ask yourself:
1. What references would be unclear if this paragraph stood alone?
2. Is the clarifying information available in the metadata or previous context?
3. Is the context already clear from the paragraph itself?
4. If unclear AND information exists, add [[the clarification]] after the ambiguous reference

## AMBIGUOUS REFERENCES TO CHECK:
- Pronouns: I, we, they, he, she, it, them, our, my, his, her, their
- Demonstratives: this, that, these, those  
- Partial names: first names only, last names only
- Generic terms: the project, the system, the company, the software
- Proper nouns without context: product names, place names, organization names
- Abbreviations and acronyms: FBI, API, CEO, NGO, etc.

## HOW TO DISAMBIGUATE:
Find what each ambiguous reference refers to in the context, then add that clarification:
- Pronouns → [[who or what they refer to]]
- Demonstratives → [[what they point to]]
- Partial names → [[complete name if available]]
- Generic terms → [[the specific thing being referenced]]
- Unfamiliar proper nouns → [[brief description of what they are]]
- Abbreviations/acronyms → [[full form]] if previously defined

## IMPORTANT:
- Use ONLY information from the document metadata and previous context
- Add just enough context to make the reference clear
- Preserve the original text exactly - only add [[clarifications]]

## CRITICAL RULES:

1. **ONE DISAMBIGUATION PER TERM PER PARAGRAPH**
   - Disambiguate each term ONLY on its FIRST occurrence
   - WRONG: "I [[John]] went to the store. I [[John]] bought milk."
   - RIGHT: "I [[John]] went to the store. I bought milk."

2. **ONLY USE INFORMATION THAT EXISTS**
   - ONLY use clarifications found in metadata or previous context
   - NEVER guess or invent information
   - If you can't find what something refers to, LEAVE IT ALONE
   
3. **CHECK IF CONTEXT IS ALREADY PRESENT**
   - Before adding disambiguation, check if the paragraph already contains the needed context
   - Don't add redundant information

## DO NOT DISAMBIGUATE:
- References that are already clear within the paragraph
- When the needed context is already present in the same paragraph
- Common knowledge (what a car is, what email means, etc.)
- When clarifying information is NOT available in the provided context
- NEVER invent or guess clarifications - if it's not explicitly stated, leave it alone

Make every paragraph independently understandable while preserving exact original text.

========= DOCUMENT META-DATA:

${Object.entries(simplifiedMetadata)
  .filter(([, value]) => value && value !== '')
  .map(([key, value]) => {
    // Format key nicely (camelCase to Title Case)
    const formattedKey = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
    return `${formattedKey}: ${value}`;
  })
  .join('\n')}

========= PREVIOUS CONTEXT:

${window.context || '(This is the beginning of the document)'}

========= TEXT TO PROCESS:

${JSON.stringify(window.blocks, null, 2)}

========= OUTPUT FORMAT:

Return ONLY the enhanced text blocks with [[disambiguations]] added.
Separate each block with a blank line.
Do not add any explanations, numbers, or other text.

Example output:
I [[Sarah Chen]] completed the analysis.

The team [[the dev team]] launched it [[the mobile app]].

This [[the product launch]] was amazing.`;

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
    debugLogger.ai(`Document ${doc.docId}: Created ${windows.length} windows from ${doc.blocks.length} total blocks`);

    // Log window details for debugging
    if (windows.length > 0) {
      const totalProcessableBlocks = windows.reduce((sum, w) => sum + Object.keys(w.blocks).length, 0);
      debugLogger.ai(`  Processing ${totalProcessableBlocks} content blocks across ${windows.length} windows`);
      if (process.env.DEBUG) {
        windows.forEach((w, i) => {
          debugLogger.ai(`  Window ${i}: ${Object.keys(w.blocks).length} blocks, ${w.wordCount} words`);
        });
      }
    }

    // Create request for each window
    for (const window of windows) {
      const request = createWindowRequest(window, doc.metadata, doc.docId);
      allRequests.push(request);
    }

    // Update the tracker with actual window count for this document
    if (aiRequestTracker.isInitialized) {
      aiRequestTracker.updateDocumentActual(doc.docId, windows.length);
    }
  }

  const totalRequests = allRequests.length;
  debugLogger.ai(`Total AI requests to process: ${totalRequests} (from ${documents.length} documents)`);

  if (totalRequests === 0) {
    return {};
  }

  // Initialize progress with actual request count from tracker if available
  if (progressCallback) {
    const initialTotal = aiRequestTracker.isInitialized ? aiRequestTracker.totalExpected : totalRequests;
    // Get current completed count from tracker to maintain progress continuity
    const currentCompleted = aiRequestTracker.isInitialized ? aiRequestTracker.totalCompleted : 0;
    progressCallback(currentCompleted, initialTotal);
  }

  // Phase 2: Process all requests in parallel with rate limiting
  // Reduce concurrency for external APIs to avoid rate limits
  const concurrency = aiConfig.provider === 'anthropic' ? 3 : 10;
  const limiter = pLimit(concurrency); // Process requests with provider-specific concurrency
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

        // Add delay for Anthropic to avoid rate limits
        if (aiConfig.provider === 'anthropic' && completedRequests.count > 0) {
          await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay between requests
        }

        // Set current model for pricing calculations
        if (aiRequestTracker.isInitialized && aiConfig.model) {
          aiRequestTracker.setCurrentModel(aiConfig.model);
        }

        // Call AI with the request
        const response = await callAI(request.prompt, PlainTextResponseSchema, aiConfig);
        
        // For now, we don't have access to usage data for plain text responses
        // This is a limitation we'll need to address in a future update
        const usage = null;
        const responseText = response;

        // Log response preview to debug
        const disambCount = (responseText.match(/\[\[.*?\]\]/g) || []).length;
        debugLogger.ai(`Response preview: ${responseText.substring(0, 200)}...`);
        debugLogger.ai(`Total disambiguations in response: ${disambCount}`);

        if (!responseText) {
          throw new Error('Invalid AI response - empty response');
        }

        // Parse plain text response into blocks (split by blank lines)
        const responseBlocks = responseText
          .split(/\n\s*\n/)
          .map(block => block.trim())
          .filter(block => block);
        const enhancedBlocks = {};

        // Match response blocks to original blocks using content matching
        const originalBlocksArray = Object.entries(request.window.blocks);
        const unmatchedResponses = [...responseBlocks];

        // Debug: Log AI response for first window
        if (request.windowIndex === 0) {
          debugLogger.ai('\n--- AI RESPONSE ---');
          debugLogger.ai('Number of blocks returned:', responseBlocks.length);
          debugLogger.ai('Number of blocks expected:', originalBlocksArray.length);
          debugLogger.ai('Response preview:', responseText.substring(0, 300) + '...');
          debugLogger.ai('==================\n');
        }

        // Match blocks by comparing normalized content
        for (const [key, originalText] of originalBlocksArray) {
          let bestMatch = null;
          let bestMatchIndex = -1;

          // Find the best matching response block
          for (let i = 0; i < unmatchedResponses.length; i++) {
            const responseBlock = unmatchedResponses[i];

            // Use the strict validation function to check if this block matches
            const validation = strictValidateEnhancement(originalText, responseBlock);

            // If validation passes, this is a match
            if (validation.isValid) {
              bestMatch = responseBlock;
              bestMatchIndex = i;
              break; // Stop searching once we find a valid match
            }
          }

          if (bestMatch) {
            enhancedBlocks[key] = bestMatch;
            unmatchedResponses.splice(bestMatchIndex, 1);
          } else {
            // No match found, use original
            enhancedBlocks[key] = originalText;
            debugLogger.ai(`Warning: No matching enhanced block found for key ${key}. Using original.`);
          }
        }

        // Validate enhancements
        const validatedBlocks = {};
        let validationFailures = 0;
        for (const [key, original] of Object.entries(request.window.blocks)) {
          const enhanced = enhancedBlocks[key];
          if (enhanced) {
            const validation = strictValidateEnhancement(original, enhanced);
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
          const currentTotal = aiRequestTracker.isInitialized ? aiRequestTracker.totalExpected : totalRequests;
          debugLogger.ai(`[PROGRESS] Updating progress: ${completedRequests.count}/${currentTotal}`);
          progressCallback(completedRequests.count, currentTotal);
        }

        // Track completion in the shared tracker
        if (aiRequestTracker.isInitialized) {
          await aiRequestTracker.trackCompletion(request.docId, usage);
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
          const currentTotal = aiRequestTracker.isInitialized ? aiRequestTracker.totalExpected : totalRequests;
          debugLogger.ai(`[PROGRESS] Updating progress on failure: ${completedRequests.count}/${currentTotal}`);
          progressCallback(completedRequests.count, currentTotal);
        }

        // Track completion in the shared tracker even on failure
        if (aiRequestTracker.isInitialized) {
          await aiRequestTracker.trackCompletion(request.docId, null); // No usage data on failure
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
  // Also check for duplicate block processing
  const processedBlocksMap = new Map(); // Track which blocks were processed in which windows

  for (const result of allResults) {
    if (!results[result.docId]) {
      results[result.docId] = {
        windows: [],
        blocks: []
      };
    }
    results[result.docId].windows.push(result);

    // Check for duplicate block processing
    if (result.blockIndices) {
      for (const blockIndex of result.blockIndices) {
        const key = `${result.docId}-${blockIndex}`;
        if (processedBlocksMap.has(key)) {
          debugLogger.ai(
            `WARNING: Block ${blockIndex} in doc ${result.docId} processed in multiple windows: ${processedBlocksMap.get(key)} and ${result.windowIndex}`
          );
        } else {
          processedBlocksMap.set(key, result.windowIndex);
        }
      }
    }
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
      // Use blockIndices to know which blocks to replace
      if (window.blockIndices && window.enhancedBlocks) {
        // Process blocks in the order they were sent (using blockIndices)
        for (const originalIndex of window.blockIndices) {
          const key = String(originalIndex);
          if (window.enhancedBlocks[key]) {
            // Log document:block replacement for duplicate detection with timestamp
            const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
            debugLogger.ai(`[BLOCK-REPLACE] ${timestamp} ${docId}:${originalIndex} - Window ${window.windowIndex}`);
            finalBlocks[originalIndex] = window.enhancedBlocks[key];
          }
        }
      } else {
        // Fallback if blockIndices is missing (shouldn't happen with new code)
        debugLogger.ai(`Warning: blockIndices or enhancedBlocks missing for window ${window.windowIndex}`);
        // Skip this window in the fallback case
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
