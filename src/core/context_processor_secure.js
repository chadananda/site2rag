// context_processor_secure.js
// Secure and optimized sliding window context processor
// This version includes security fixes and performance optimizations
import {z} from 'zod';
import pLimit from 'p-limit';
import {callAI} from './ai_client.js';
import debugLogger from '../services/debug_logger.js';
import {
  sanitizeMetadata,
  sanitizeContent,
  escapeHtml,
  validateAIResponse,
  createSecurityReport
} from '../utils/security.js';
import {
  COMPILED_PATTERNS,
  PerformanceTracker,
  BlockMatcher,
  ValidationCache,
  TextAccumulator
} from '../utils/performance.js';
// Schema for AI response - plain text for better model compatibility
const PlainTextResponseSchema = z.string();
// Window size configurations
const WINDOW_SIZES = {
  DEFAULT: {context: 1000, process: 1000},
  MINI: {context: 1200, process: 600}
};
// Content filtering thresholds
const MIN_BLOCK_CHARS = process.env.SITE2RAG_MIN_BLOCK_CHARS ? parseInt(process.env.SITE2RAG_MIN_BLOCK_CHARS) : 100;
/**
 * Secure and optimized version of cleanTextForContext
 * @param {string} text - Raw markdown text
 * @returns {string} Cleaned plain text
 */
export function cleanTextForContextSecure(text) {
  if (!text) return '';
  if (typeof text !== 'string') {
    debugLogger.ai(`Warning: cleanTextForContext received non-string input: ${typeof text}`);
    return '';
  }
  try {
    // Sanitize content first to prevent injection
    const sanitized = sanitizeContent(text);
    // Single-pass cleaning with pre-compiled patterns
    const cleaned = sanitized
      .replace(COMPILED_PATTERNS.codeBlocks, ' [code] ')
      .replace(COMPILED_PATTERNS.indentedCode, ' [code] ')
      .replace(COMPILED_PATTERNS.images, ' ')
      .replace(COMPILED_PATTERNS.links, '$1')
      .replace(COMPILED_PATTERNS.htmlTags, ' ')
      .replace(COMPILED_PATTERNS.whitespace, ' ')
      .trim();
    return cleaned || text.replace(COMPILED_PATTERNS.whitespace, ' ').trim();
  } catch (error) {
    debugLogger.ai(`Error in cleanTextForContext: ${error.message}`);
    return text.substring(0, 1000);
  }
}
/**
 * Secure validation that ensures ONLY context insertions are added
 * @param {string} original - Original text
 * @param {string} enhanced - Enhanced text with [[context]] insertions
 * @param {ValidationCache} cache - Optional validation cache
 * @returns {Object} Validation result
 */
function secureValidateEnhancement(original, enhanced, cache = null) {
  if (!original || !enhanced) {
    return {
      isValid: false,
      error: 'Missing original or enhanced text'
    };
  }
  // Check cache first
  if (cache) {
    const cached = cache.get(original, enhanced);
    if (cached) return cached;
  }
  // Validate AI response for security issues
  const aiValidation = validateAIResponse(enhanced);
  if (!aiValidation.isValid) {
    const result = {
      isValid: false,
      error: `Security validation failed: ${aiValidation.reason}`
    };
    if (cache) cache.set(original, enhanced, result);
    return result;
  }
  // Remove [[...]] insertions from enhanced text
  const enhancedWithoutContext = enhanced.replace(COMPILED_PATTERNS.contextMarkers, '');
  // Normalize whitespace
  const normalizedOriginal = original.replace(COMPILED_PATTERNS.whitespace, ' ').trim();
  const normalizedEnhanced = enhancedWithoutContext.replace(COMPILED_PATTERNS.whitespace, ' ').trim();
  // Must match exactly after removing insertions
  const isValid = normalizedOriginal === normalizedEnhanced;
  const result = {
    isValid,
    error: isValid ? null : 'Enhanced text modifies the original content (only [[context]] insertions are allowed)'
  };
  // Cache result
  if (cache) cache.set(original, enhanced, result);
  return result;
}
/**
 * Create sliding windows with performance optimizations
 * @param {Array} blocks - Document blocks
 * @param {PerformanceTracker} tracker - Performance tracker
 * @returns {Array} Windows with context and blocks to process
 */
function createSlidingWindowsOptimized(blocks, tracker = null) {
  const windowTimer = tracker?.startTimer('windowProcessing');
  const windows = [];
  let processedBlockIndex = 0;
  const textAccumulator = new TextAccumulator(WINDOW_SIZES.MINI.context * 2);
  const CONTEXT_WORDS = WINDOW_SIZES.MINI.context;
  const PROCESS_WORDS = WINDOW_SIZES.MINI.process;
  while (processedBlockIndex < blocks.length) {
    const windowBlocks = {};
    const blockIndices = [];
    let windowWords = 0;
    const startIndex = processedBlockIndex;
    while (processedBlockIndex < blocks.length && windowWords < PROCESS_WORDS) {
      const block = blocks[processedBlockIndex];
      const blockText = typeof block === 'string' ? block : block.text || block;
      // Skip headers and code blocks
      if (
        COMPILED_PATTERNS.headerStart.test(blockText.trim()) ||
        COMPILED_PATTERNS.codeStart.test(blockText.trim()) ||
        COMPILED_PATTERNS.indentStart.test(blockText)
      ) {
        textAccumulator.add(cleanTextForContextSecure(blockText));
        processedBlockIndex++;
        continue;
      }
      // Skip short blocks
      if (blockText.trim().length < MIN_BLOCK_CHARS) {
        textAccumulator.add(cleanTextForContextSecure(blockText));
        processedBlockIndex++;
        continue;
      }
      // Add to window
      const originalIdx = block.originalIndex !== undefined ? block.originalIndex : processedBlockIndex;
      const key = String(originalIdx);
      windowBlocks[key] = blockText;
      blockIndices.push(originalIdx);
      windowWords += blockText.split(COMPILED_PATTERNS.whitespace).length;
      processedBlockIndex++;
    }
    if (Object.keys(windowBlocks).length === 0) {
      if (processedBlockIndex < blocks.length) {
        processedBlockIndex++;
        continue;
      }
      break;
    }
    // Get context from accumulator
    const context = textAccumulator.getContext(CONTEXT_WORDS);
    windows.push({
      windowIndex: windows.length,
      startBlockIndex: startIndex,
      endBlockIndex: processedBlockIndex - 1,
      blockIndices: blockIndices,
      context: context,
      blocks: windowBlocks,
      blockCount: Object.keys(windowBlocks).length,
      wordCount: windowWords
    });
    // Update accumulator with processed text
    const processedText = Object.values(windowBlocks)
      .map(block => cleanTextForContextSecure(block))
      .join(' ');
    textAccumulator.add(processedText);
  }
  windowTimer?.();
  return windows;
}
/**
 * Create a secure request for a single window
 * @param {Object} window - Window data
 * @param {Object} metadata - Document metadata
 * @param {string} docId - Document identifier
 * @returns {Object} Request object
 */
function createSecureWindowRequest(window, metadata, docId) {
  // Sanitize metadata to prevent injection
  const sanitizedMetadata = sanitizeMetadata(metadata);
  // Create security report for logging
  const securityReport = createSecurityReport(metadata, sanitizedMetadata, Object.values(window.blocks));
  if (securityReport.metadataModified || securityReport.blocksSanitized > 0) {
    debugLogger.ai(`Security sanitization applied: ${JSON.stringify(securityReport)}`);
  }
  // Use the same effective prompt as before, but with sanitized inputs
  const prompt = `Add [[disambiguation]] to ambiguous references using ONLY information already stated in this document.

PURPOSE: Each paragraph will be indexed separately for search. When someone searches for "Sarah Chen mobile app", they should find relevant paragraphs even if the paragraph only says "I launched it yesterday." Without disambiguation, that paragraph would be unsearchable.

GOAL: Make each paragraph standalone and searchable by resolving what pronouns and vague terms refer to.

## TARGET FOR DISAMBIGUATION:
- Pronouns: I, we, they, he, she, it, them
- Demonstratives: this, that, these, those
- Vague references: "the project", "the team", "the system", "the company"
- Unclear antecedents where the referent is ambiguous

## DISAMBIGUATION RULES:
1. Use ONLY names, entities, and concepts explicitly mentioned in THIS document
2. Add [[clarification]] immediately after the ambiguous reference
3. Disambiguate each reference only ONCE per paragraph
4. Skip if the referent is clear from immediate context (within same paragraph)
5. CRITICAL: If you cannot find the disambiguation in the provided document or it's meta-data, DO NOT disambiguate
6. FORBIDDEN: Never use your general knowledge about what something is (e.g., knowing Google is a search engine)

## DISAMBIGUATION TEST:
Ask yourself: "If this paragraph were the only search result, would someone understand what/who is being referenced?"

If NO → Add disambiguation
If YES → Leave as-is

## EXAMPLES:
✓ "I completed the analysis" → "I [[Sarah Chen]] completed the analysis"
   (Searcher needs to know WHO completed analysis)
✓ "We launched it yesterday" → "We [[the dev team]] launched it [[the mobile app]] yesterday"
   (Searcher needs to know WHO launched WHAT)
✓ "This approach worked" → "This approach [[microservices architecture]] worked"
   (Searcher needs to know WHICH approach)
✓ "They approved our proposal" → "They [[the board]] approved our proposal [[for Q4 expansion]]"
   (Searcher needs to know WHO approved WHAT proposal)

## DO NOT DISAMBIGUATE:
✗ Clear references: "Sarah completed her analysis" (already clear)
✗ Immediately obvious: "The car broke down. It needs repair." (clear within paragraph)
✗ External knowledge: Don't add info not in the document
✗ Definitions: Don't explain what things are, only identify what specific thing is referenced

Focus on using document content and meta-data to make ambiguous references searchable, not educational.

========= DOCUMENT META-DATA:

${Object.entries(sanitizedMetadata)
  .filter(([, value]) => value && value !== '')
  .map(([key, value]) => {
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
    metadata: sanitizedMetadata,
    window,
    securityReport
  };
}
/**
 * Process all documents with security and performance optimizations
 * @param {Array} documents - Array of {docId, blocks, metadata} objects
 * @param {Object} aiConfig - AI configuration
 * @param {Function} progressCallback - Progress callback(completed, total)
 * @returns {Promise<Object>} Results keyed by docId
 */
export async function processDocumentsSecure(documents, aiConfig, progressCallback = null) {
  debugLogger.ai('=== Starting Secure Sliding Window Processing ===');
  debugLogger.ai(`Processing ${documents.length} documents`);
  const performanceTracker = new PerformanceTracker();
  const validationCache = new ValidationCache();
  // Phase 1: Create all requests upfront
  const allRequests = [];
  for (const doc of documents) {
    if (!doc.blocks || doc.blocks.length === 0) {
      debugLogger.ai(`Skipping document ${doc.docId} - no blocks`);
      continue;
    }
    const windows = createSlidingWindowsOptimized(doc.blocks, performanceTracker);
    debugLogger.ai(`Document ${doc.docId}: Created ${windows.length} windows`);
    for (const window of windows) {
      const request = createSecureWindowRequest(window, doc.metadata, doc.docId);
      allRequests.push(request);
    }
  }
  const totalRequests = allRequests.length;
  debugLogger.ai(`Total requests to process: ${totalRequests}`);
  if (totalRequests === 0) {
    return {};
  }
  if (progressCallback) {
    progressCallback(0, totalRequests);
  }
  // Phase 2: Process requests with optimized matching
  const limiter = pLimit(10);
  const completedRequests = {count: 0};
  const results = {};
  const requestPromises = allRequests.map(request =>
    limiter(async () => {
      const aiTimer = performanceTracker.startTimer('aiCalls');
      try {
        const aiResponse = await callAI(request.prompt, PlainTextResponseSchema, aiConfig);
        aiTimer();
        // Extract content and usage from the response
        const response = aiResponse.content || aiResponse; // Handle both old and new format
        // const _usage = aiResponse.usage || null; // TODO: Implement usage tracking
        if (!response) {
          throw new Error('Invalid AI response - empty response');
        }
        // Parse and match blocks using optimized matcher
        const matchTimer = performanceTracker.startTimer('blockMatching');
        const responseBlocks = response
          .split(/\n\s*\n/)
          .map(block => block.trim())
          .filter(block => block);
        const enhancedBlocks = {};
        const blockMatcher = new BlockMatcher();
        blockMatcher.addOriginalBlocks(request.window.blocks);
        // Match response blocks to original blocks
        for (const responseBlock of responseBlocks) {
          const match = blockMatcher.findMatch(responseBlock);
          if (match) {
            enhancedBlocks[match.key] = responseBlock;
          } else {
            debugLogger.ai(`Warning: No match found for response block`);
          }
        }
        matchTimer();
        // Fill in missing blocks
        for (const [key, original] of Object.entries(request.window.blocks)) {
          if (!enhancedBlocks[key]) {
            enhancedBlocks[key] = original;
          }
        }
        // Validate enhancements with caching
        const validationTimer = performanceTracker.startTimer('validation');
        const validatedBlocks = {};
        let validationFailures = 0;
        for (const [key, original] of Object.entries(request.window.blocks)) {
          const enhanced = enhancedBlocks[key];
          if (enhanced) {
            const validation = secureValidateEnhancement(original, enhanced, validationCache);
            if (validation.isValid) {
              // Escape HTML in context insertions to prevent XSS
              const escapedEnhanced = enhanced.replace(COMPILED_PATTERNS.contextMarkers, match => {
                const content = match.slice(2, -2); // Remove [[ and ]]
                return `[[${escapeHtml(content)}]]`;
              });
              validatedBlocks[key] = escapedEnhanced;
              const disambiguations = (enhanced.match(COMPILED_PATTERNS.contextMarkers) || []).length;
              if (disambiguations > 0) {
                debugLogger.ai(`✓ Block ${key}: Added ${disambiguations} disambiguations`);
              }
            } else {
              validationFailures++;
              debugLogger.ai(`✗ Block ${key}: Validation failed - ${validation.error}`);
              validatedBlocks[key] = original;
            }
          } else {
            validatedBlocks[key] = original;
          }
        }
        validationTimer();
        if (validationFailures > 0) {
          debugLogger.ai(`Window ${request.windowIndex}: ${validationFailures} validation failures`);
        }
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
          enhancedBlocks: request.window.blocks,
          error: error.message
        };
      }
    })
  );
  const allResults = await Promise.all(requestPromises);
  // Phase 3: Reassemble results
  for (const result of allResults) {
    if (!results[result.docId]) {
      results[result.docId] = {
        windows: [],
        blocks: []
      };
    }
    results[result.docId].windows.push(result);
  }
  for (const docId in results) {
    const docResult = results[docId];
    const doc = documents.find(d => d.docId === docId);
    if (!doc) continue;
    docResult.windows.sort((a, b) => a.windowIndex - b.windowIndex);
    const finalBlocks = doc.allBlocks ? [...doc.allBlocks] : [...doc.blocks];
    for (const window of docResult.windows) {
      const enhancedBlocksArray = Object.values(window.enhancedBlocks);
      if (window.blockIndices && window.blockIndices.length === enhancedBlocksArray.length) {
        for (let i = 0; i < window.blockIndices.length; i++) {
          const originalIndex = window.blockIndices[i];
          finalBlocks[originalIndex] = enhancedBlocksArray[i];
        }
      }
    }
    results[docId] = finalBlocks;
  }
  // Clear validation cache to free memory
  validationCache.clear();
  // Log performance summary
  const perfSummary = performanceTracker.getSummary();
  debugLogger.ai(`=== Performance Summary ===`);
  debugLogger.ai(JSON.stringify(perfSummary, null, 2));
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
export async function enhanceDocumentSecure(blocks, metadata, aiConfig, options = {}) {
  const doc = {
    docId: 'single-doc',
    blocks: blocks,
    metadata: metadata
  };
  const results = await processDocumentsSecure([doc], aiConfig, options.onProgress);
  return results['single-doc'] || blocks;
}
