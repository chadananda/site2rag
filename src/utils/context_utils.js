// context_extensions.js
// Supporting functions for optimal sliding cached context window system

/**
 * Get optimal window sizes based on AI model context limits
 * @param {Object} aiConfig - AI configuration
 * @returns {Object} Window size and overlap size in words
 */
export function getOptimalWindowSize(aiConfig) {
  // eslint-disable-next-line no-unused-vars
  const provider = aiConfig.provider?.toLowerCase() || 'ollama';
  const model = aiConfig.model?.toLowerCase() || '';

  // Define model context limits (80% utilization for safety)
  const modelLimits = {
    // OpenAI models
    'gpt-4': {contextTokens: 8000, promptTokens: 6000},
    'gpt-4-turbo': {contextTokens: 128000, promptTokens: 100000},
    'gpt-4o': {contextTokens: 128000, promptTokens: 100000},
    'gpt-3.5-turbo': {contextTokens: 16000, promptTokens: 12000},

    // Anthropic models
    'claude-3-opus': {contextTokens: 200000, promptTokens: 160000},
    'claude-3-sonnet': {contextTokens: 200000, promptTokens: 160000},
    'claude-3-haiku': {contextTokens: 200000, promptTokens: 160000},

    // Ollama models (common ones)
    'llama3.2:latest': {contextTokens: 4096, promptTokens: 3000},
    'llama3.2': {contextTokens: 4096, promptTokens: 3000},
    'qwen2.5:14b': {contextTokens: 32768, promptTokens: 24000},
    'qwen2.5': {contextTokens: 32768, promptTokens: 24000},
    mistral: {contextTokens: 8192, promptTokens: 6000},
    codellama: {contextTokens: 16000, promptTokens: 12000},

    // Default fallback
    default: {contextTokens: 4096, promptTokens: 3000}
  };

  // Get model limits
  const limits = modelLimits[model] || modelLimits['default'];

  // Convert tokens to words (rough 1.3 tokens per word for safety)
  const wordsPerToken = 0.75;
  const maxContextWords = Math.floor(limits.contextTokens * wordsPerToken * 0.8); // 80% utilization

  // For sliding windows: use maximum available context with 50% overlap
  const windowSize = Math.min(maxContextWords, 18000); // Cap at reasonable size
  const overlapSize = Math.floor(windowSize * 0.5); // 50% overlap

  return {windowSize, overlapSize};
}

/**
 * Build cached instructions for sliding window system
 * @param {Object} metadata - Document metadata
 * @returns {string} Cached instructions prompt
 */
export function buildSlidingCacheInstructions(metadata) {
  return `# SLIDING CONTEXT DISAMBIGUATION SESSION
## Document Metadata
Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}
Description: ${metadata.description || 'None'}

## Context Disambiguation Instructions
You will receive paragraph batches with surrounding document context for disambiguation enhancement.

### Guidelines
1. **Document-Only Context**: Only add context that appears in the provided document context window
2. **Pronoun Clarification**: "he" → "he (John Smith)", "they" → "they (the organization)"
3. **Unclear References**: Clarify pronouns and vague references using surrounding context
4. **Temporal Context**: Add time context when clear from surrounding text
5. **Geographic Specificity**: Add location context when mentioned elsewhere in context
6. **Roles/Relationships**: Clarify relationships using document context
7. **Acronym Expansion**: Expand acronyms using full forms found in document
8. **Cross-References**: Clarify "this", "that", "these" references from context
9. **Context Delimiter Style**: Use [[...]] delimiters for context clarifications to preserve flow
10. **No Repetition**: Don't repeat information already clear in the current sentence
11. **Preserve Meaning**: Maintain original meaning and flow exactly
12. **Paragraph-Level Context**: Use surrounding paragraphs for disambiguation context

### Validation Requirements
- Enhanced text must contain all original words in exact order
- Only [[...]] context additions and minor context insertions allowed
- No removal or reordering of original content

IMPORTANT: All context additions must be justified by information found in the provided document context window. Use maximum available context for disambiguation.`;
}

/**
 * Create batch processing prompt for paragraph arrays
 * @param {Object} batch - Paragraph batch object
 * @returns {string} Batch processing prompt
 */
export function createBatchProcessingPrompt(batch) {
  // Create numbered input paragraphs for clear 1:1 mapping
  const numberedParagraphs = batch.blocks.map((block, index) => `${index + 1}. ${block.originalText}`).join('\n');

  // Create example output structure showing exact mapping
  const exampleOutput = batch.blocks.map((block, index) => ({
    text: `enhanced version of paragraph ${index + 1}`,
    summary: `changes made to paragraph ${index + 1}`
  }));

  return `## CRITICAL: ENHANCE MARKDOWN TEXT - PRESERVE ALL MARKDOWN SYNTAX

### MARKDOWN paragraphs to enhance:
${numberedParagraphs}

### MARKDOWN PRESERVATION RULES:
1. This is MARKDOWN text - preserve ALL markdown syntax exactly
2. NEVER change URLs, links, image paths, or markdown formatting  
3. NEVER change ![alt text](url) image syntax
4. NEVER change [link text](url) link syntax
5. NEVER change markdown headers (##), lists, or formatting
6. ONLY add [[context]] insertions after ambiguous terms in TEXT content
7. Do NOT add [[...]] insertions inside URLs, alt text, or markdown syntax

### Examples of CORRECT markdown enhancement:
- Original: "this was a fantastic project"
- Enhanced: "this [[Ocean search software development]] was a fantastic project"

- Original: "![Ocean screenshot](https://example.com/image.png)"  
- Enhanced: "![Ocean screenshot](https://example.com/image.png)" (NO CHANGES to markdown)

- Original: "[Ocean project](https://bahai-education.org/ocean)"
- Enhanced: "[Ocean project](https://bahai-education.org/ocean)" (NO CHANGES to links)

### Examples of WRONG enhancement (NEVER DO THIS):
- Wrong: Changing URLs: "https://bahai-education.org" → "https://bahai-ed.org"
- Wrong: Removing alt text: "![Ocean screenshot]" → "![]" 
- Wrong: Adding [[...]] inside markdown: "![Ocean [[software]] screenshot]"
- Wrong: Changing link text without context: "[Ocean]" → "[Ocean software]"

### JSON Response Format:
{
  "enhanced_paragraphs": ${JSON.stringify(exampleOutput, null, 2)}
}

CRITICAL: Preserve markdown syntax perfectly. Only enhance readable text content with [[...]] context.`;
}

/**
 * Create optimized sliding context windows for paragraph batch processing
 * @param {Array} blocks - Document blocks (paragraphs)
 * @param {number} windowSize - Target words per window based on AI capacity
 * @param {number} overlapSize - Overlap words between windows (50%)
 * @returns {Array} Array of sliding windows with paragraph mappings
 */
export function createOptimizedSlidingWindows(blocks, windowSize, overlapSize, isTestMode = false) {
  const windows = [];

  // Convert blocks to text with paragraph boundaries preserved
  const fullText = blocks
    .map(block => block.text || block.content || block.original || block)
    .filter(content => typeof content === 'string')
    .join(' ');

  const words = fullText.split(/\s+/).filter(w => w.length > 0);
  const stepSize = windowSize - overlapSize; // Move window by 50%

  if (isTestMode) {
    console.log(
      `[SLIDING_WINDOWS] Total: ${words.length} words, Window: ${windowSize} words, Step: ${stepSize} words (50% overlap)`
    );
  }

  // Create sliding windows with 50% overlap
  for (let start = 0; start < words.length; start += stepSize) {
    const windowWords = words.slice(start, start + windowSize);
    // For very small documents, create at least one window
    if (windowWords.length < 100 && windows.length > 0) break; // Skip tiny windows only if we already have windows

    const windowText = windowWords.join(' ');

    // End on sentence boundaries for clean context
    const lastSentenceEnd = Math.max(
      windowText.lastIndexOf('.'),
      windowText.lastIndexOf('!'),
      windowText.lastIndexOf('?')
    );

    const cleanText =
      lastSentenceEnd > windowText.length * 0.8 ? windowText.substring(0, lastSentenceEnd + 1) : windowText;

    // Map which blocks (paragraphs) are covered by this window
    const coveredBlocks = findBlocksInWindowRange(start, windowWords.length, blocks);

    windows.push({
      windowIndex: windows.length,
      startWord: start,
      endWord: start + windowWords.length - 1,
      wordCount: windowWords.length,
      actualWordCount: cleanText.split(/\s+/).length,
      contextText: cleanText,
      coveredBlocks: coveredBlocks,
      paragraphBatches: createParagraphBatches(coveredBlocks, blocks)
    });
  }

  if (isTestMode) {
    console.log(`[SLIDING_WINDOWS] Created ${windows.length} sliding windows with 50% overlap`);
  }
  return windows;
}

/**
 * Create paragraph batches within a window for efficient processing
 * Uses word-based batching (target ~500 words per batch) instead of fixed paragraph count
 * @param {Array} blockIndices - Block indices covered by window
 * @param {Array} allBlocks - All document blocks
 * @returns {Array} Array of paragraph batches for this window
 */
export function createParagraphBatches(blockIndices, allBlocks) {
  const batches = [];
  const targetBatchWords = 500; // Target ~500 words per batch
  
  let currentBatch = [];
  let currentWordCount = 0;
  
  for (const blockIndex of blockIndices) {
    const blockText = allBlocks[blockIndex].text || allBlocks[blockIndex].content || allBlocks[blockIndex].original;
    const blockWords = blockText.split(/\s+/).filter(w => w.length > 0).length;
    
    // If adding this block would exceed target AND we already have blocks, create batch
    if (currentWordCount + blockWords > targetBatchWords && currentBatch.length > 0) {
      // Create batch with current blocks
      const batchBlocks = currentBatch.map(idx => ({
        originalIndex: idx,
        originalText: allBlocks[idx].text || allBlocks[idx].content || allBlocks[idx].original,
        escapedText: JSON.stringify(allBlocks[idx].text || allBlocks[idx].content || allBlocks[idx].original)
      }));
      
      batches.push({
        batchIndex: batches.length,
        blockIndices: [...currentBatch],
        blocks: batchBlocks,
        wordCount: currentWordCount
      });
      
      // Start new batch with current block
      currentBatch = [blockIndex];
      currentWordCount = blockWords;
    } else {
      // Add block to current batch
      currentBatch.push(blockIndex);
      currentWordCount += blockWords;
    }
  }
  
  // Create final batch if there are remaining blocks
  if (currentBatch.length > 0) {
    const batchBlocks = currentBatch.map(idx => ({
      originalIndex: idx,
      originalText: allBlocks[idx].text || allBlocks[idx].content || allBlocks[idx].original,
      escapedText: JSON.stringify(allBlocks[idx].text || allBlocks[idx].content || allBlocks[idx].original)
    }));
    
    batches.push({
      batchIndex: batches.length,
      blockIndices: [...currentBatch],
      blocks: batchBlocks,
      wordCount: currentWordCount
    });
  }

  return batches;
}

/**
 * Find which blocks are covered by a word range in the document
 * @param {number} startWord - Start word index
 * @param {number} windowLength - Window length in words
 * @param {Array} blocks - All document blocks
 * @returns {Array} Block indices covered by this range
 */
export function findBlocksInWindowRange(startWord, windowLength, blocks) {
  const coveredBlocks = [];
  let currentWordPosition = 0;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const blockText = blocks[blockIndex].text || blocks[blockIndex].content || blocks[blockIndex].original;
    const blockWordCount = blockText.split(/\s+/).length;

    const blockStart = currentWordPosition;
    const blockEnd = currentWordPosition + blockWordCount - 1;
    const windowStart = startWord;
    const windowEnd = startWord + windowLength - 1;

    // Include block if it overlaps with window
    if (blockStart <= windowEnd && blockEnd >= windowStart) {
      coveredBlocks.push(blockIndex);
    }

    currentWordPosition += blockWordCount;
  }

  return coveredBlocks;
}

/**
 * Normalize text for comparison only (never modifies actual content)
 * Handles Bahá'í terminology encoding variations
 * @param {string} text - Text to normalize for comparison
 * @returns {string} Normalized text for comparison only
 */
function normalizeForComparison(text) {
  return (
    text
      // Normalize common Bahá'í terminology encoding variations
      .replace(/Bahá'í/gi, 'bahai')
      .replace(/Baha'i/gi, 'bahai')
      .replace(/Bahai/gi, 'bahai')
      .replace(/Bahá'u'lláh/gi, 'bahaullah')
      .replace(/Baha'u'llah/gi, 'bahaullah')
      .replace(/Bahaullah/gi, 'bahaullah')
      .replace(/'Abdu'l-Bahá/gi, 'abdulbaha')
      .replace(/Abdul-Baha/gi, 'abdulbaha')
      .replace(/Abdu'l-Baha/gi, 'abdulbaha')
      // Normalize apostrophes and accent marks
      .replace(/[''`]/g, "'")
      .replace(/[áàâä]/gi, 'a')
      .replace(/[íìîï]/gi, 'i')
      .replace(/[úùûü]/gi, 'u')
      .replace(/[éèêë]/gi, 'e')
      .replace(/[óòôö]/gi, 'o')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/**
 * Validate enhancement preserves original text integrity
 * Uses normalization for comparison only - never modifies actual text
 * @param {string} original - Original paragraph text
 * @param {string} enhanced - Enhanced paragraph text
 * @returns {boolean} True if enhancement is valid
 */
export function validateEnhancement(original, enhanced) {
  if (!original || !enhanced) return false;

  // Strip [[...]] context additions from enhanced text for comparison
  const enhancedWithoutContext = enhanced.replace(/\s*\[\[.*?\]\]/g, '');

  // Normalize both texts for comparison only (never modify actual output)
  const normalizedOriginal = normalizeForComparison(original);
  const normalizedEnhanced = normalizeForComparison(enhancedWithoutContext);

  // Enhanced text (after removing [[...]] insertions) must match original exactly
  const isValid = normalizedOriginal === normalizedEnhanced;

  if (!isValid) {
    // Only show validation details in test mode
    if (process.env.NODE_ENV === 'test') {
      console.log(`[VALIDATION] Failed - Enhanced text doesn't match original after removing [[...]] insertions`);
      console.log(`[VALIDATION] Original: "${normalizedOriginal}"`);
      console.log(`[VALIDATION] Enhanced (no [[...]]): "${normalizedEnhanced}"`);
    }
  }

  return isValid;
}

/**
 * Remove context insertions from enhanced text to get original content
 * @param {string} enhancedText - Text with [[...]] context insertions
 * @returns {string} Original text with context insertions removed
 */
export function removeContextInsertions(enhancedText) {
  if (!enhancedText) return enhancedText;

  // Remove all [[...]] context insertions
  return enhancedText
    .replace(/\s*\[\[.*?\]\]/g, '')
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Extract only the context insertions from enhanced text
 * @param {string} enhancedText - Text with [[...]] context insertions
 * @returns {Array} Array of context insertions found
 */
export function extractContextInsertions(enhancedText) {
  if (!enhancedText) return [];

  const matches = enhancedText.match(/\[\[.*?\]\]/g);
  return matches ? matches.map(match => match.slice(2, -2)) : []; // Remove [[ and ]]
}
