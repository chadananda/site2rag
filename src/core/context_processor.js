// context.js
// Contextual enrichment task for site2rag
// This module will process documents with content_status='raw' and add disambiguating context using AI.
// It uses a centralized callAI(prompt, schema, aiConfig) function for all AI calls.
// Zod is used for schema validation.

import {getDB} from '../db.js';
// All DB access must use getDB() from src/db.js. Never instantiate CrawlDB directly.
import {z} from 'zod';
import {callAI, getAISession, closeAISession} from './ai_client.js';
import debugLogger from '../services/debug_logger.js';
import logger from '../services/logger_service.js';
import fs from 'fs';
import {
  createBatchProcessingPrompt,
  createParagraphBatches,
  validateEnhancement,
  removeContextInsertions,
  extractContextInsertions,
  getOptimalWindowSize
} from '../utils/context_utils.js';

/**
 * Execute AI call with automatic fallback support
 * @param {Function} callFunc - Function to execute AI call (session.call or callAI)
 * @param {Object} aiConfig - AI configuration (regular or fallback)
 * @param {Array} args - Arguments to pass to the call function
 * @returns {Promise<any>} AI call result
 */
async function executeWithFallback(callFunc, aiConfig, ...args) {
  // Regular AI config - single provider
  if (!aiConfig.type || aiConfig.type !== 'fallback') {
    return await callFunc(...args);
  }

  // Fallback AI config - try each provider in order
  const {availableLLMs} = aiConfig;
  let lastError = null;

  for (let i = 0; i < availableLLMs.length; i++) {
    const currentLLM = availableLLMs[i];
    console.log(
      `🔄 Trying fallback ${i + 1}/${availableLLMs.length}: ${currentLLM.fallbackName} (${currentLLM.provider}/${currentLLM.model})`
    );

    try {
      // Create session or call AI with current LLM config
      if (callFunc.name === 'call' && callFunc.session) {
        // This is a session call - update the session's AI config
        const session = callFunc.session;
        session.aiConfig = currentLLM;
        const result = await callFunc(...args);
        debugLogger.ai(`✅ Fallback ${i + 1} succeeded: ${currentLLM.fallbackName}`);
        return result;
      } else {
        // This is a direct callAI call
        const result = await callFunc(args[0], args[1], currentLLM);
        debugLogger.ai(`✅ Fallback ${i + 1} succeeded: ${currentLLM.fallbackName}`);
        return result;
      }
    } catch (error) {
      lastError = error;
      debugLogger.ai(`❌ Fallback ${i + 1} failed: ${currentLLM.fallbackName} - ${error.message}`);

      // Don't try more fallbacks if it's a validation error (not provider issue)
      if (error.message.includes('validation') || error.message.includes('schema')) {
        debugLogger.ai(`🛑 Schema validation error, stopping fallback attempts`);
        throw error;
      }
    }
  }

  debugLogger.ai(`💥 All ${availableLLMs.length} fallback providers failed`);
  throw lastError || new Error('All fallback providers failed');
}

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

    const fileName = filePath.split('/').pop();
    session.files.set(filePath, {
      fileName,
      filePath,
      insertionCount: insertions.length,
      insertions: [...insertions],
      enhancedBlocks: [...allEnhancedBlocks]
    });

    session.totalInsertions += insertions.length;
    session.totalBlocks += allEnhancedBlocks.length;
    session.enhancedBlocks.push(...allEnhancedBlocks);
  },

  getSessionSummary(sessionId) {
    return this.sessions.get(sessionId || this.currentSession);
  },

  logSessionSummary(sessionId) {
    const session = this.getSessionSummary(sessionId);
    if (!session) return;

    logger.info('\n' + '='.repeat(80));
    logger.info(`🤖 LLM ENHANCEMENT SUMMARY - ${session.llmConfig.provider}/${session.llmConfig.model}`);
    logger.info('='.repeat(80));

    logger.info(`📊 Total files processed: ${session.files.size}`);
    logger.info(`📊 Total insertions: ${session.totalInsertions}`);
    logger.info(`📊 Total enhanced blocks: ${session.totalBlocks}`);
    logger.info(`⏱️  Processing time: ${((Date.now() - session.startTime) / 1000).toFixed(1)}s`);

    if (session.files.size > 0) {
      logger.info('\n📄 PER-FILE BREAKDOWN:');
      for (const [, fileData] of session.files) {
        logger.info(`  ${fileData.fileName}: ${fileData.insertionCount} insertions`);
      }

      if (session.enhancedBlocks.length > 0) {
        logger.info('\n🔍 ALL ENHANCED BLOCKS (for LLM comparison):');
        for (const block of session.enhancedBlocks) {
          const insertions = extractContextInsertions(block.enhanced);
          if (insertions.length > 0) {
            logger.info(`\n📄 ${block.fileName} - Block ${block.blockKey}:`);
            logger.info(`Original: "${block.original.substring(0, 100)}${block.original.length > 100 ? '...' : ''}"`);
            logger.info(`Enhanced: "${block.enhanced.substring(0, 150)}${block.enhanced.length > 150 ? '...' : ''}"`);
            logger.info(`Insertions: ${insertions.map(i => `[[${i}]]`).join(', ')}`);
          }
        }
      }
    }

    logger.info('='.repeat(80));
  },

  clear() {
    this.sessions.clear();
    this.currentSession = null;
  }
};

// Zod schema for document analysis
export const DocumentAnalysisSchema = z.object({
  bibliographic: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    publisher: z.string().optional(),
    publication_date: z.string().optional(),
    short_description: z.string().optional(),
    long_description: z.string().optional(),
    document_type: z.string().optional(),
    language: z.string().optional(),
    reading_level: z.string().optional(),
    word_count: z.number().optional()
  }),
  content_analysis: z.object({
    subjects: z.array(z.string()).optional(),
    geographical_scope: z.string().optional(),
    time_period: z.string().optional(),
    narrative_perspective: z.string().optional(),
    people: z.array(z.object({name: z.string(), role: z.string().optional()})).optional(),
    places: z.array(z.object({name: z.string(), context: z.string().optional()})).optional(),
    organizations: z.array(z.object({name: z.string(), context: z.string().optional()})).optional(),
    themes: z.array(z.string()).optional()
  }),
  context_summary: z.string()
});

export const ContextedDocSchema = z.object({
  contexted_markdown: z.string(),
  context_summary: z.string().optional()
});

// Schema for keyed object processing - simpler and more reliable
export const KeyedEnhancementSchema = z.object({
  enhanced_blocks: z.record(z.string(), z.string()) // key -> enhanced text mapping
});

// Schema for batch processing results
export const BatchEnhancementSchema = z.object({
  enhanced_paragraphs: z.array(
    z.object({
      text: z.string(),
      summary: z.string().optional()
    })
  )
});

// Enhanced permissive schema for comprehensive entity extraction
export const EntityExtractionSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string(),
        roles: z.union([z.array(z.string()), z.string()]).optional(),
        aliases: z.union([z.array(z.string()), z.string()]).optional(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        type: z.string().optional() // individual, title, role, group
      })
    )
    .optional(),
  places: z
    .array(
      z.object({
        name: z.string(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        aliases: z.union([z.array(z.string()), z.string()]).optional(),
        type: z.string().optional() // city, country, region, abstract
      })
    )
    .optional(),
  organizations: z
    .array(
      z.object({
        name: z.string(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        aliases: z.union([z.array(z.string()), z.string()]).optional(),
        type: z.string().optional() // institution, movement, group, abstract
      })
    )
    .optional(),
  dates: z
    .array(
      z.object({
        date: z.string(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        precision: z.string().optional(), // exact, approximate, range, era
        type: z.string().optional() // date, period, era, age
      })
    )
    .optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        timeframe: z.union([z.string(), z.array(z.string())]).optional(),
        participants: z.union([z.array(z.string()), z.string()]).optional(),
        location: z.union([z.string(), z.array(z.string())]).optional(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        type: z.string().optional() // historical, religious, social, political
      })
    )
    .optional(),
  documents: z
    .array(
      z.object({
        title: z.string(),
        author: z.union([z.string(), z.array(z.string())]).optional(),
        type: z.string().optional(), // book, concept, principle, teaching
        date: z.union([z.string(), z.array(z.string())]).optional(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        subject_matter: z.union([z.array(z.string()), z.string()]).optional()
      })
    )
    .optional(),
  subjects: z
    .union([
      z.array(z.string()),
      z.array(
        z.object({
          name: z.string(),
          context: z.string().optional()
        })
      )
    ])
    .optional(),
  relationships: z
    .array(
      z.object({
        from: z.string(),
        relationship: z.string(),
        to: z.string(),
        context: z.union([z.string(), z.array(z.string())]).optional(),
        type: z.string().optional() // causal, temporal, hierarchical, contextual
      })
    )
    .optional()
});

// Combined entity graph from all chunks
export const EntityGraphSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string(),
        roles: z.array(z.string()).optional(),
        aliases: z.array(z.string()).optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  places: z
    .array(
      z.object({
        name: z.string(),
        context: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        type: z.string().optional()
      })
    )
    .optional(),
  organizations: z
    .array(
      z.object({
        name: z.string(),
        context: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        type: z.string().optional()
      })
    )
    .optional(),
  dates: z
    .array(
      z.object({
        date: z.string(),
        context: z.string().optional(),
        precision: z.string().optional()
      })
    )
    .optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        timeframe: z.string().optional(),
        participants: z.array(z.string()).optional(),
        location: z.string().optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  documents: z
    .array(
      z.object({
        title: z.string(),
        author: z.string().optional(),
        type: z.string().optional(), // book, letter, tablet, document
        date: z.string().optional(),
        context: z.string().optional(),
        subject_matter: z.array(z.string()).optional()
      })
    )
    .optional(),
  subjects: z.array(z.string()).optional(),
  relationships: z
    .array(
      z.object({
        from: z.string(),
        relationship: z.string(),
        to: z.string(),
        context: z.string().optional()
      })
    )
    .optional()
});

/**
 * PASS 1: Extract entities from document using sliding window for large docs
 * @param {Array} blocks - Document blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - AI call implementation
 * @returns {Promise<Object>} Complete entity graph
 */
export async function extractEntitiesWithSlidingWindow(blocks, metadata, aiConfig, callAIImpl = callAI) {
  console.log(
    `[ENTITIES] Pass 1: Extracting entities from ${blocks.length} blocks using context-aware sliding windows`
  );

  // Determine optimal window size based on AI model context limits
  const {windowSize, overlapSize} = getOptimalWindowSize(aiConfig);
  console.log(
    `[ENTITIES] Using ${aiConfig.model || 'default'} model - Window: ${windowSize} words, Overlap: ${overlapSize} words`
  );

  const windows = createContextualWindows(blocks, windowSize, overlapSize);
  console.log(
    `[ENTITIES] Processing ${windows.length} contextual windows (optimized for ${aiConfig.provider || 'default'} provider)`
  );

  // Use cache-optimized AI session
  const sessionId = `kg-extraction-${Date.now()}`;
  console.log(`[CACHE] Creating knowledge graph extraction session: ${sessionId}`);

  const cachedInstructions = `COMPREHENSIVE ENTITY EXTRACTION: Extract ALL entities, subjects, and relationships from text windows. Be thorough and capture rich historical, religious, and conceptual information.

EXTRACTION PHILOSOPHY: Be comprehensive but accurate. Extract all mentioned entities, then validate relationships. Err on the side of inclusion rather than exclusion.

COMPREHENSIVE EXTRACTION RULES:
1. **PEOPLE**: Extract ALL named individuals, titles, roles
   - Examples: "Shoghi Effendi", "Abdu'l-Baha", "the Bab", "Baha'u'llah", "kings", "Prophets"
   - Include titles: "Author", "Guardian", "Center of the Covenant"

2. **PLACES**: Extract ALL geographic locations, regions, institutions
   - Examples: "Wilmette", "Illinois", "United States", "World Center", "Holy Land"
   - Include abstract places: "world", "society", "mankind"

3. **ORGANIZATIONS**: Extract ALL institutions, groups, movements
   - Examples: "Bahá'í Publishing Trust", "National Spiritual Assembly", "Baha'i Faith", "ecclesiastical hierarchies"
   - Include abstract organizations: "dynasties", "empires", "races", "creeds", "classes"

4. **DATES & TIME PERIODS**: Extract ALL temporal references
   - Examples: "May 23rd", "centennial", "1944", "century", "World War", "Formative Age"
   - Include relative times: "primitive age", "opening years", "auspicious year"

5. **EVENTS**: Extract ALL significant occurrences, processes, developments
   - Examples: "centennial anniversary", "founding of the Faith", "World War", "planetary upheaval"
   - Include abstract events: "inception", "inauguration", "commencement", "collapse", "emergence"

6. **DOCUMENTS & CONCEPTS**: Extract ALL texts, ideas, principles
   - Examples: "God Passes By", "Faith of Baha'u'llah", "World Order", "Revelation", "Covenant"
   - Include abstract concepts: "prophetic cycle", "spiritual history", "divine guidance"

7. **SUBJECTS**: Extract ALL main topics, themes, domains
   - Examples: "religion", "history", "prophecy", "civilization", "social order", "spiritual development"

COMPREHENSIVE COVERAGE GUIDANCE:
- Extract ALL people mentioned (may be 0, may be 20+ - follow what's in the text)
- Extract ALL places mentioned (geographic, institutional, abstract)  
- Extract ALL organizations mentioned (formal institutions and informal groups)
- Extract ALL time references (specific dates, periods, eras, relative times)
- Extract ALL events mentioned (historical, personal, abstract processes)
- Extract ALL documents/concepts mentioned (books, principles, ideas)
- Extract ALL subject themes discussed (topics, domains, fields of discourse)

IMPORTANT: Only extract entities that are actually mentioned in the text. Do not invent or hallucinate entities to meet quotas. If a category has zero mentions, return an empty array for that category.

RELATIONSHIP EXTRACTION:
- Extract explicit relationships: "X founded Y", "A wrote B", "C commemorates D"
- Extract contextual relationships: entities mentioned in same context
- Include temporal relationships: "X preceded Y", "A followed B"
- Include causal relationships: "X caused Y", "A influenced B"

IMPORTANT: Return exactly this JSON structure:
{
  "people": [],
  "places": [],
  "organizations": [],
  "dates": [],
  "events": [],
  "documents": [],
  "subjects": [],
  "relationships": []
}

Fill arrays with entities using this format:
- people: {"name": "string", "roles": ["array"], "aliases": ["array"], "context": "string"}
- places: {"name": "string", "context": "string", "aliases": ["array"], "type": "string"}
- organizations: {"name": "string", "context": "string", "aliases": ["array"], "type": "string"}
- dates: {"date": "string", "context": "string", "precision": "string"}
- events: {"name": "string", "timeframe": "string", "participants": ["array"], "location": "string", "context": "string"}
- documents: {"title": "string", "author": "string", "type": "string", "date": "string", "context": "string", "subject_matter": ["array"]}
- subjects: ["string", "string"] (main topics discussed)
- relationships: {"from": "string", "relationship": "string", "to": "string", "context": "string"}

Return valid JSON only, no other text or explanation.`;

  try {
    // Start cached AI session for maximum efficiency
    // await getAISession(sessionId, cachedInstructions, aiConfig);
    // throw new Error('Using fallback for test'); // Force fallback for reliable test

    const entityExtractions = [];

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      debugLogger.ai(
        `[ENTITIES] Processing window ${i + 1}/${windows.length} (${window.actualWordCount} words) - Cached session`
      );

      const metadataEscaped = JSON.stringify(metadata);
      const windowEscaped = JSON.stringify(window.text);

      // Only send variable content to cached session
      const variablePrompt = `Document metadata: ${metadataEscaped}
Text window: ${windowEscaped}`;

      try {
        const extraction = await callAIImpl(variablePrompt, EntityExtractionSchema, {...aiConfig, sessionId});
        if (extraction) {
          normalizeExtractionFields(extraction);
          entityExtractions.push(extraction);
          debugLogger.ai(
            `[ENTITIES] Window ${i + 1} extracted: ${extraction.people?.length || 0} people, ${extraction.places?.length || 0} places, ${extraction.documents?.length || 0} documents`
          );
        }
      } catch (err) {
        debugLogger.ai(`[ENTITIES] Failed to extract from window ${i + 1}: ${err.message}`);
      }
    }

    // Close the AI session
    await closeAISession(sessionId);
    debugLogger.ai(`[CACHE] Knowledge graph extraction session completed`);

    // Merge all extractions with improved deduplication
    const entityGraph = mergeEntityExtractions(entityExtractions);
    debugLogger.ai(
      `[ENTITIES] Merged entities: ${entityGraph.people?.length || 0} people, ${entityGraph.places?.length || 0} places, ${entityGraph.documents?.length || 0} documents`
    );

    return entityGraph;
  } catch (error) {
    debugLogger.ai(`[CACHE] Knowledge graph session failed: ${error.message}`);
    debugLogger.ai(`[FALLBACK] Using non-cached large window approach`);

    // Fall back to non-cached approach with large windows
    const entityExtractions = [];

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      console.log(
        `[ENTITIES] Processing window ${i + 1}/${windows.length} (${window.actualWordCount} words) - Non-cached`
      );

      const metadataEscaped = JSON.stringify(metadata);
      const windowEscaped = JSON.stringify(window.text);

      const fullPrompt = `${cachedInstructions}

Document metadata: ${metadataEscaped}
Text window: ${windowEscaped}`;

      try {
        const extraction = await callAIImpl(fullPrompt, EntityExtractionSchema, aiConfig);
        if (extraction) {
          normalizeExtractionFields(extraction);
          entityExtractions.push(extraction);
          debugLogger.ai(
            `[ENTITIES] Window ${i + 1} extracted: ${extraction.people?.length || 0} people, ${extraction.places?.length || 0} places, ${extraction.documents?.length || 0} documents`
          );
        }
      } catch (err) {
        debugLogger.ai(`[ENTITIES] Failed to extract from window ${i + 1}: ${err.message}`);
      }
    }

    const entityGraph = mergeEntityExtractions(entityExtractions);
    console.log(
      `[ENTITIES] Fallback completed: ${entityGraph.people?.length || 0} people, ${entityGraph.places?.length || 0} places, ${entityGraph.documents?.length || 0} documents`
    );

    return entityGraph;
  }
}

/**
 * Fallback extraction without caching
 * @param {Array} blocks - Document blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - AI call implementation
 * @returns {Promise<Object>} Complete entity graph
 */
async function extractEntitiesWithoutCache(blocks, metadata, aiConfig, callAIImpl) { // eslint-disable-line no-unused-vars
  console.log(`[ENTITIES] Fallback: Non-cached entity extraction`);

  const sentences = blocks.flatMap(block => {
    const content = block.text || block.content || block.original || block;
    if (typeof content !== 'string') return [];
    return content.split(/[.!?]+/).filter(s => s.trim().length > 10);
  });

  const batchSize = 15; // Smaller batches for non-cached
  const entityExtractions = [];

  for (let i = 0; i < sentences.length; i += batchSize) {
    const batch = sentences.slice(i, i + batchSize);
    const batchText = batch.join('. ');

    const prompt = `Extract entities from: ${JSON.stringify(batchText)}
Return JSON with people, places, organizations, dates, events, documents, subjects, relationships arrays.
Be strict and conservative - only extract explicit information.`;

    try {
      const extraction = await callAIImpl(prompt, EntityExtractionSchema, aiConfig);
      if (extraction) {
        normalizeExtractionFields(extraction);
        entityExtractions.push(extraction);
      }
    } catch (err) {
      console.log(`[ENTITIES] Fallback failed on batch ${Math.floor(i / batchSize) + 1}: ${err.message}`);
    }
  }

  return mergeEntityExtractions(entityExtractions);
}

/**
 * Calculate optimal context capacity (80% of AI model limits) for sliding windows
 * @param {Object} aiConfig - AI configuration with provider and model info
 * @param {boolean} isTestMode - Whether to show detailed logs
 * @returns {Object} - { capacity, windowSize, overlapSize }
 */
function getOptimalContextCapacity(aiConfig, isTestMode = false) { // eslint-disable-line no-unused-vars
  // eslint-disable-next-line no-unused-vars
  const provider = aiConfig.provider?.toLowerCase() || 'ollama';
  const model = aiConfig.model?.toLowerCase() || '';

  // Model context limits (use 80% as capacity for safety)
  const modelLimits = {
    // OpenAI models
    'gpt-4': {contextTokens: 8000, promptTokens: 6000},
    'gpt-4-turbo': {contextTokens: 128000, promptTokens: 100000},
    'gpt-4o': {contextTokens: 128000, promptTokens: 100000},
    'gpt-3.5-turbo': {contextTokens: 16000, promptTokens: 12000},

    // Anthropic models
    'claude-3-haiku': {contextTokens: 200000, promptTokens: 150000},
    'claude-3-sonnet': {contextTokens: 200000, promptTokens: 150000},
    'claude-3-opus': {contextTokens: 200000, promptTokens: 150000},
    'claude-3.5-sonnet': {contextTokens: 200000, promptTokens: 150000},

    // Local models (Ollama)
    'llama3.2': {contextTokens: 8000, promptTokens: 6000},
    'llama3.1': {contextTokens: 32000, promptTokens: 24000},
    llama3: {contextTokens: 8000, promptTokens: 6000},
    mistral: {contextTokens: 8000, promptTokens: 6000},
    'qwen2.5': {contextTokens: 32000, promptTokens: 24000},
    gemma2: {contextTokens: 8000, promptTokens: 6000},

    // Default for unknown models
    default: {contextTokens: 8000, promptTokens: 6000}
  };

  // Find matching model configuration
  let modelConfig = modelLimits.default;

  // Check for exact model match first
  if (modelLimits[model]) {
    modelConfig = modelLimits[model];
  } else {
    // Check for partial matches (e.g., "gpt-4" matches "gpt-4-0125-preview")
    for (const [key, config] of Object.entries(modelLimits)) {
      if (model.includes(key)) {
        modelConfig = config;
        break;
      }
    }
  }

  // Use 80% of context limit as capacity
  const capacity = Math.floor(modelConfig.contextTokens * 0.8);
  const responseBuffer = 500; // Reserve tokens for response
  const instructionsBuffer = 1000; // Reserve tokens for instructions and metadata

  // Available tokens for document context window
  const availableForContext = capacity - responseBuffer - instructionsBuffer;
  const wordsPerToken = 0.75; // Conservative estimate
  const maxContextWords = Math.floor(availableForContext * wordsPerToken);

  // Window size is the available context capacity
  const windowSize = Math.max(500, maxContextWords); // Minimum 500 words
  const overlapSize = Math.floor(windowSize * 0.5); // 50% overlap

  if (isTestMode) {
    console.log(
      `[CAPACITY] Model: ${model || 'default'}, Capacity: ${capacity} tokens (80% of ${modelConfig.contextTokens}), Context Window: ${windowSize} words`
    );
  }

  return {capacity, windowSize, overlapSize, availableForContext};
}

/**
 * Create contextual sliding windows with overlap for better entity extraction
 * @param {Array} blocks - Document blocks
 * @param {number} windowSize - Target words per window
 * @param {number} overlapSize - Overlap words between windows
 * @returns {Array} Array of context windows with metadata
 */
function createContextualWindows(blocks, windowSize, overlapSize) {
  const windows = [];

  // Convert all blocks to a single text stream for efficient chunking
  const fullText = blocks
    .map(block => block.text || block.content || block.original || block)
    .filter(content => typeof content === 'string')
    .join(' ');

  const words = fullText.split(/\s+/).filter(w => w.length > 0);
  const stepSize = windowSize - overlapSize; // How far to advance each window

  console.log(`[WINDOWS] Total words: ${words.length}, Window size: ${windowSize}, Step size: ${stepSize}`);

  // Create large sliding windows with 50% overlap
  for (let i = 0; i < words.length; i += stepSize) {
    const windowWords = words.slice(i, i + windowSize);
    if (windowWords.length < 100) break; // Skip very small windows

    const windowText = windowWords.join(' ');

    // Ensure we end on sentence boundaries for better context
    const lastSentenceEnd = Math.max(
      windowText.lastIndexOf('.'),
      windowText.lastIndexOf('!'),
      windowText.lastIndexOf('?')
    );

    const cleanText =
      lastSentenceEnd > windowText.length * 0.8 ? windowText.substring(0, lastSentenceEnd + 1) : windowText;

    windows.push({
      text: cleanText,
      wordCount: windowWords.length,
      actualWordCount: cleanText.split(/\s+/).length,
      startIndex: i,
      endIndex: i + windowWords.length - 1
    });
  }

  console.log(
    `[WINDOWS] Created ${windows.length} windows (reduced from ~${Math.ceil(words.length / 120)} with old method)`
  );
  return windows;
}

/**
 * Create sliding windows from document blocks
 * @param {Array} blocks - Document blocks
 * @param {number} windowSize - Words per window
 * @param {number} overlapSize - Overlap words between windows
 * @returns {Array} Array of window text arrays
 */
export function createSlidingWindows(blocks, windowSize, overlapSize) {
  const windows = [];
  let currentWindow = [];
  let currentWordCount = 0;
  let blockIndex = 0;

  while (blockIndex < blocks.length) {
    const block = blocks[blockIndex];
    const blockWords = block.text.split(/\s+/).length;

    // Add block if it fits in current window
    if (currentWordCount + blockWords <= windowSize) {
      currentWindow.push(block.text);
      currentWordCount += blockWords;
      blockIndex++;
    } else {
      // Window is full, save it and create next window with overlap
      if (currentWindow.length > 0) {
        windows.push([...currentWindow]);

        // Create overlap for next window
        const overlapWindow = [];
        let overlapWords = 0;
        for (let i = currentWindow.length - 1; i >= 0 && overlapWords < overlapSize; i--) {
          const text = currentWindow[i];
          const words = text.split(/\s+/).length;
          if (overlapWords + words <= overlapSize) {
            overlapWindow.unshift(text);
            overlapWords += words;
          } else {
            break;
          }
        }

        currentWindow = overlapWindow;
        currentWordCount = overlapWords;
      } else {
        // Single block is too large, split it
        currentWindow.push(block.text);
        windows.push([...currentWindow]);
        currentWindow = [];
        currentWordCount = 0;
        blockIndex++;
      }
    }
  }

  // Add final window if it has content
  if (currentWindow.length > 0) {
    windows.push(currentWindow);
  }

  return windows;
}

/**
 * Normalize extraction fields that may be arrays or strings to strings
 * @param {Object} extraction - Entity extraction to normalize
 */
function normalizeExtractionFields(extraction) {
  const normalizeToArray = value => {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(v => v && typeof v === 'string');
    if (typeof value === 'string') return [value];
    return [];
  };

  const normalizeToString = value => {
    if (!value) return '';
    if (Array.isArray(value)) return value.filter(v => v && typeof v === 'string').join(', ');
    if (typeof value === 'string') return value;
    return '';
  };

  // Normalize all entity types with enhanced handling
  ['people', 'places', 'organizations', 'dates', 'events', 'documents'].forEach(entityType => {
    if (extraction[entityType] && Array.isArray(extraction[entityType])) {
      extraction[entityType] = extraction[entityType]
        .filter(entity => {
          // Filter out invalid entities
          return entity && typeof entity === 'object' && entity.name;
        })
        .map(entity => {
          // Normalize fields that should be arrays
          if (entity.roles) entity.roles = normalizeToArray(entity.roles);
          if (entity.aliases) entity.aliases = normalizeToArray(entity.aliases);
          if (entity.participants) entity.participants = normalizeToArray(entity.participants);
          if (entity.subject_matter) entity.subject_matter = normalizeToArray(entity.subject_matter);

          // Normalize fields that should be strings
          if (entity.context) entity.context = normalizeToString(entity.context);
          if (entity.timeframe) entity.timeframe = normalizeToString(entity.timeframe);
          if (entity.location) entity.location = normalizeToString(entity.location);
          if (entity.date) entity.date = normalizeToString(entity.date);
          if (entity.author) entity.author = normalizeToString(entity.author);

          return entity;
        });
    }
  });

  // Normalize subjects array
  if (extraction.subjects) {
    if (Array.isArray(extraction.subjects)) {
      extraction.subjects = extraction.subjects
        .flatMap(subject => {
          if (typeof subject === 'string') return [subject];
          if (subject && typeof subject === 'object' && subject.name) return [subject.name];
          return [];
        })
        .filter(s => s && s.trim());
    }
  }

  // Normalize relationships
  if (extraction.relationships && Array.isArray(extraction.relationships)) {
    extraction.relationships = extraction.relationships
      .filter(rel => rel && rel.from && rel.relationship && rel.to)
      .map(rel => ({
        ...rel,
        context: normalizeToString(rel.context)
      }));
  }
}

/**
 * Merge multiple entity extractions into single graph, deduplicating entities
 * @param {Array} extractions - Array of entity extraction results
 * @returns {Object} Merged entity graph
 */
export function mergeEntityExtractions(extractions) {
  const merged = {
    people: [],
    places: [],
    organizations: [],
    dates: [],
    events: [],
    documents: [],
    subjects: [],
    relationships: []
  };

  // Merge and deduplicate each entity type
  for (const extraction of extractions) {
    if (extraction.people) {
      merged.people = mergeEntities(merged.people, extraction.people, 'name');
    }
    if (extraction.places) {
      merged.places = mergeEntities(merged.places, extraction.places, 'name');
    }
    if (extraction.organizations) {
      merged.organizations = mergeEntities(merged.organizations, extraction.organizations, 'name');
    }
    if (extraction.dates) {
      merged.dates = mergeEntities(merged.dates, extraction.dates, 'date');
    }
    if (extraction.events) {
      merged.events = mergeEntities(merged.events, extraction.events, 'name');
    }
    if (extraction.documents) {
      merged.documents = mergeEntities(merged.documents, extraction.documents, 'title');
    }
    if (extraction.subjects && Array.isArray(extraction.subjects)) {
      // Simply concatenate and deduplicate string subjects
      for (const subject of extraction.subjects) {
        if (typeof subject === 'string' && subject.trim() && !merged.subjects.includes(subject)) {
          merged.subjects.push(subject.trim());
        }
      }
    }
    if (extraction.relationships) {
      merged.relationships = mergeRelationships(merged.relationships, extraction.relationships);
    }
  }

  return merged;
}

/**
 * Merge and deduplicate entities by key field
 * @param {Array} existing - Existing entities
 * @param {Array} newEntities - New entities to merge
 * @param {string} keyField - Field to use for deduplication
 * @returns {Array} Merged entities
 */
export function mergeEntities(existing, newEntities, keyField) {
  const existingMap = new Map();
  existing.forEach(entity => {
    if (entity[keyField] && typeof entity[keyField] === 'string' && entity[keyField].trim()) {
      existingMap.set(entity[keyField].toLowerCase(), entity);
    }
  });

  for (const newEntity of newEntities) {
    // Validate entity has required key field
    if (!newEntity[keyField] || typeof newEntity[keyField] !== 'string' || !newEntity[keyField].trim()) {
      continue; // Skip invalid entities
    }

    const key = newEntity[keyField].toLowerCase();
    if (existingMap.has(key)) {
      // Merge with existing entity
      const existingEntity = existingMap.get(key);
      if (newEntity.roles && existingEntity.roles) {
        existingEntity.roles = [...new Set([...existingEntity.roles, ...newEntity.roles])];
      }
      if (newEntity.aliases && existingEntity.aliases) {
        existingEntity.aliases = [...new Set([...existingEntity.aliases, ...newEntity.aliases])];
      }
      if (newEntity.context && existingEntity.context !== newEntity.context) {
        existingEntity.context = existingEntity.context + '; ' + newEntity.context;
      }
    } else {
      existingMap.set(key, {...newEntity});
    }
  }

  return Array.from(existingMap.values());
}

/**
 * Merge relationships, avoiding duplicates
 * @param {Array} existing - Existing relationships
 * @param {Array} newRelationships - New relationships to merge
 * @returns {Array} Merged relationships
 */
export function mergeRelationships(existing, newRelationships) {
  const relationshipSet = new Set(
    existing.filter(r => r.from && r.relationship && r.to).map(r => `${r.from}|${r.relationship}|${r.to}`)
  );

  const merged = [...existing.filter(r => r.from && r.relationship && r.to)];
  for (const rel of newRelationships) {
    // Validate relationship has all required fields
    if (
      !rel.from ||
      !rel.relationship ||
      !rel.to ||
      typeof rel.from !== 'string' ||
      typeof rel.relationship !== 'string' ||
      typeof rel.to !== 'string' ||
      !rel.from.trim() ||
      !rel.relationship.trim() ||
      !rel.to.trim()
    ) {
      continue; // Skip invalid relationships
    }

    const key = `${rel.from}|${rel.relationship}|${rel.to}`;
    if (!relationshipSet.has(key)) {
      merged.push(rel);
      relationshipSet.add(key);
    }
  }

  return merged;
}

// Analyze the document to extract metadata, entities, and summary using AI
export async function analyzeDocument(blocks, metadata, aiConfig, callAIImpl = callAI) {
  // Accumulate blocks by word count up to 3000 words
  let wordBudget = 3000,
    used = 0,
    selected = [];
  for (const block of blocks) {
    const words = block.text.split(/\s+/).length;
    if (used + words > wordBudget) break;
    selected.push(block.text);
    used += words;
  }
  const docInput = selected.join('\n\n');
  const prompt = `Analyze the following document content and metadata. Extract bibliographic metadata, key people, places, organizations, themes, and write a 2-3 paragraph prose context summary for disambiguation.

Return your response as valid JSON only, no other text or explanation.

Metadata: ${JSON.stringify(metadata)}

Content:
${docInput}

Respond with valid JSON matching this structure:
{
  "bibliographic": {
    "title": "optional string",
    "author": "optional string", 
    "publisher": "optional string",
    "publication_date": "optional string",
    "short_description": "optional string",
    "long_description": "optional string",
    "document_type": "optional string",
    "language": "optional string",
    "reading_level": "optional string",
    "word_count": 0
  },
  "content_analysis": {
    "subjects": ["optional array of strings"],
    "geographical_scope": "optional string",
    "time_period": "optional string", 
    "narrative_perspective": "optional string",
    "people": [{"name": "string", "role": "optional string"}],
    "places": [{"name": "string", "context": "optional string"}],
    "organizations": [{"name": "string", "context": "optional string"}],
    "themes": ["optional array of strings"]
  },
  "context_summary": "required string - 2-3 paragraph summary for disambiguation"
}`;
  return await callAIImpl(prompt, DocumentAnalysisSchema, aiConfig);
}

/**
 * PASS 2: Enhanced context window builder with complete entity graph
 * @param {number} blockIndex - Index of current block
 * @param {Array} allBlocks - All document blocks
 * @param {Array} processedBlocks - Previously processed blocks
 * @param {Object} entityGraph - Complete entity graph from Pass 1
 * @param {Object} options - Budget options
 * @returns {string} Context window text
 */
export function buildEntityAwareContextWindow(
  blockIndex,
  allBlocks,
  processedBlocks,
  entityGraph,
  {prevBudget = 2000, nextBudget = 1000, entityBudget = 2000, totalBudget = 24000} = {}
) {
  const currentBlock = allBlocks[blockIndex].text;

  // Build entity context relevant to current block
  const relevantEntities = findRelevantEntities(currentBlock, entityGraph);
  const entityContext = buildEntityContext(relevantEntities, entityBudget);

  const components = {
    entityContext: entityContext,
    currentBlock: currentBlock,
    previousBlocks: getPreviousContext(processedBlocks, prevBudget),
    followingBlocks: getFollowingContext(allBlocks, blockIndex, nextBudget)
  };

  return optimizeForTokenLimit(components, totalBudget);
}

/**
 * Find entities mentioned in current block
 * @param {string} blockText - Current block text
 * @param {Object} entityGraph - Complete entity graph
 * @returns {Object} Relevant entities for this block
 */
export function findRelevantEntities(blockText, entityGraph) {
  const blockLower = blockText.toLowerCase();
  const relevant = {
    people: [],
    places: [],
    organizations: [],
    dates: [],
    events: [],
    documents: [],
    relationships: []
  };

  // Find people mentioned (including aliases)
  if (entityGraph.people) {
    for (const person of entityGraph.people) {
      if (
        blockLower.includes(person.name.toLowerCase()) ||
        person.aliases?.some(alias => blockLower.includes(alias.toLowerCase()))
      ) {
        relevant.people.push(person);
      }
    }
  }

  // Find places mentioned
  if (entityGraph.places) {
    for (const place of entityGraph.places) {
      if (
        blockLower.includes(place.name.toLowerCase()) ||
        place.aliases?.some(alias => blockLower.includes(alias.toLowerCase()))
      ) {
        relevant.places.push(place);
      }
    }
  }

  // Find organizations mentioned
  if (entityGraph.organizations) {
    for (const org of entityGraph.organizations) {
      if (
        blockLower.includes(org.name.toLowerCase()) ||
        org.aliases?.some(alias => blockLower.includes(alias.toLowerCase()))
      ) {
        relevant.organizations.push(org);
      }
    }
  }

  // Find documents mentioned
  if (entityGraph.documents) {
    for (const doc of entityGraph.documents) {
      if (
        blockLower.includes(doc.title.toLowerCase()) ||
        (doc.author && blockLower.includes(doc.author.toLowerCase()))
      ) {
        relevant.documents.push(doc);
      }
    }
  }

  // Find relevant relationships
  if (entityGraph.relationships) {
    const mentionedEntities = [
      ...relevant.people.map(p => p.name),
      ...relevant.places.map(p => p.name),
      ...relevant.organizations.map(o => o.name),
      ...relevant.documents.map(d => d.title)
    ];

    for (const rel of entityGraph.relationships) {
      if (mentionedEntities.includes(rel.from) || mentionedEntities.includes(rel.to)) {
        relevant.relationships.push(rel);
      }
    }
  }

  return relevant;
}

/**
 * Build entity context string from relevant entities
 * @param {Object} relevantEntities - Entities relevant to current block
 * @param {number} maxBudget - Maximum characters for entity context
 * @returns {string} Formatted entity context
 */
export function buildEntityContext(relevantEntities, maxBudget) {
  const sections = [];

  if (relevantEntities.people?.length > 0) {
    const peopleText = relevantEntities.people
      .map(p => `${p.name}${p.roles?.length ? ` (${p.roles.join(', ')})` : ''}${p.context ? `: ${p.context}` : ''}`)
      .join('; ');
    sections.push(`People: ${peopleText}`);
  }

  if (relevantEntities.places?.length > 0) {
    const placesText = relevantEntities.places
      .map(p => `${p.name}${p.type ? ` (${p.type})` : ''}${p.context ? `: ${p.context}` : ''}`)
      .join('; ');
    sections.push(`Places: ${placesText}`);
  }

  if (relevantEntities.organizations?.length > 0) {
    const orgsText = relevantEntities.organizations
      .map(o => `${o.name}${o.type ? ` (${o.type})` : ''}${o.context ? `: ${o.context}` : ''}`)
      .join('; ');
    sections.push(`Organizations: ${orgsText}`);
  }

  if (relevantEntities.documents?.length > 0) {
    const documentsText = relevantEntities.documents
      .map(
        d =>
          `${d.title}${d.author ? ` by ${d.author}` : ''}${d.type ? ` (${d.type})` : ''}${d.context ? `: ${d.context}` : ''}`
      )
      .join('; ');
    sections.push(`Documents: ${documentsText}`);
  }

  if (relevantEntities.relationships?.length > 0) {
    const relsText = relevantEntities.relationships.map(r => `${r.from} ${r.relationship} ${r.to}`).join('; ');
    sections.push(`Relationships: ${relsText}`);
  }

  let context = sections.join(' | ');

  // Truncate if too long
  if (context.length > maxBudget) {
    context = context.slice(0, maxBudget - 3) + '...';
  }

  return context;
}

/**
 * Build cached context for session-based processing
 * @param {Object} entityGraph - Complete entity graph
 * @param {Object} metadata - Document metadata
 * @returns {string} Cached context template
 */
/**
 * Build cached context for context-only disambiguation (no entity graphs)
 * @param {Object} metadata - Document metadata
 * @returns {string} Cached context prompt
 */
export function buildCachedContextWithoutEntities(metadata) {
  return `# DOCUMENT CONTEXT DISAMBIGUATION SESSION
## Document Metadata
Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}
Description: ${metadata.description || 'None'}

## Context Disambiguation Rules
1. **Document-Only Context**: Only add context that appears elsewhere in this document
2. **Pronoun Clarification**: "he" → "he (Chad Jones)", "they" → "they (the organization)"
3. **Unclear References**: Clarify pronouns and vague references using surrounding context
4. **Temporal Context**: Add time context when clear from surrounding text
5. **Geographic Specificity**: Add location context when mentioned elsewhere in document
6. **Roles/Relationships**: Clarify relationships using document context
7. **Acronym Expansion**: Expand acronyms using full forms found in document
8. **Cross-References**: Clarify "this", "that", "these" references from context
9. **Parenthetical Style**: Use brief parenthetical clarifications to preserve flow
10. **No Repetition**: Don't repeat information already clear in the current sentence
11. **Preserve Meaning**: Maintain original meaning and flow exactly
12. **Paragraph-Level Context**: Use surrounding paragraphs for disambiguation context
13. **JSON Format**: Always return valid JSON with "contexted_markdown" and "context_summary" fields

IMPORTANT: All context additions must be justified by information found elsewhere in this same document. Use maximum available context window for disambiguation.`;
}

export function buildCachedContext(entityGraph, metadata) {
  const entityContext = buildEntityContext(entityGraph, 2000);

  return `# DOCUMENT DISAMBIGUATION SESSION
## Document Metadata
Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}
Description: ${metadata.description || 'None'}

## Entity Graph Context
${entityContext}

## Enhanced Disambiguation Rules
1. **Document-Only Context**: Only add context that appears elsewhere in this document
2. **Pronoun Clarification**: "he" → "he (Chad Jones)", "they" → "they (US Publishing Trust)"
3. **Technical Terms**: Add context from document - "Ocean" → "Ocean (Bahá'í literature search software)"
4. **Products/Projects**: Use full names found in document - "Sifter" → "Sifter - Star of the West"
5. **Temporal Context**: Add time context from document - "back then" → "in the 1990s"
6. **Geographic Specificity**: Add location context - "India" → "India (where author learned programming)"
7. **Roles/Relationships**: Clarify from document - "Mr. Shah" → "Mr. Shah (project supporter)"
8. **Acronym Expansion**: Use document context - "US" → "United States", "PC" → "personal computer"
9. **Cross-References**: Clarify references - "this mailing" → "the global CD distribution"
10. **Parenthetical Style**: Use brief parenthetical clarifications to preserve flow
11. **No Repetition**: Don't repeat information already clear in the current sentence
12. **Preserve Meaning**: Maintain original meaning and flow exactly
13. **JSON Format**: Always return valid JSON with "contexted_markdown" and "context_summary" fields

IMPORTANT: All context additions must be justified by information found elsewhere in this same document. Do not add external knowledge.`;
}

/**
 * Enhanced content blocks directly without sliding windows (for small documents)
 * @param {Array} blocks - Document blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Object} options - Processing options
 * @param {Function} callAIImpl - Optional AI call implementation for testing
 * @returns {Promise<Array>} Enhanced blocks
 */
export async function enhanceBlocksDirectly(blocks, metadata, aiConfig, options = {}/*, callAIImpl = callAI*/) {
  const isTestMode = options.test || process.env.NODE_ENV === 'test';
  
  // Build full document context
  const fullDocumentText = blocks
    .map(block => block.text || block.content || block.original || block)
    .filter(content => typeof content === 'string')
    .join('\n\n');
  
  // Create word-based batches using the same logic as sliding windows
  const blockIndices = blocks.map((_, index) => index);
  const batches = createParagraphBatches(blockIndices, blocks);
  
  if (isTestMode) {
    debugLogger.direct(`Created ${batches.length} word-based batches for ${blocks.length} blocks`);
  }
  
  const processedBlocks = new Array(blocks.length);
  
  // Use AI session caching for efficiency
  const sessionId = `direct-cache-${Date.now()}`;
  const session = getAISession(sessionId, aiConfig);
  
  // Build static cached context (instructions + metadata + document context)
  const staticContext = `# DOCUMENT CONTEXT DISAMBIGUATION
## Document Metadata
Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}
Description: ${metadata.description || 'None'}

## Full Document Context
${fullDocumentText}

## Enhancement Instructions
You will enhance the following paragraphs using the full document context above.

### Guidelines
1. **Document-Only Context**: Only add context that appears in the provided document
2. **Pronoun Clarification**: "he" → "he (John Smith)", "they" → "they (the organization)"
3. **Unclear References**: Clarify pronouns and vague references using document context
4. **Temporal Context**: Add time context when clear from document
5. **Geographic Specificity**: Add location context when mentioned in document
6. **Roles/Relationships**: Clarify relationships using document context
7. **Acronym Expansion**: Expand acronyms using full forms found in document
8. **Cross-References**: Clarify "this", "that", "these" references from context
9. **Context Delimiter Style**: Use [[...]] delimiters for context clarifications
10. **No Repetition**: Don't repeat information already clear in the current sentence
11. **Preserve Meaning**: Maintain original meaning and flow exactly

IMPORTANT: All context additions must be justified by information found in this document.

`;

  // Set cached context once for the entire session
  session.setCachedContext(staticContext);
  
  debugLogger.direct(`Set cached context: ${staticContext.length} chars`);
  debugLogger.direct(`Using session caching for ${batches.length} batches`);

  const POLITE_DELAY_MS = 500; // Delay between batch submissions
  
  // Create all batch promises with polite delays
  const batchPromises = batches.map((batch, batchIndex) => {
    // Add delay before starting each batch (except the first)
    const delayMs = batchIndex * POLITE_DELAY_MS;
    
    return (async () => {
      // Wait for the polite delay
      if (delayMs > 0) {
        debugLogger.direct(`Batch ${batchIndex + 1} waiting ${delayMs}ms before starting...`);
        await new Promise(wait => setTimeout(wait, delayMs));
      }
      
      if (isTestMode) {
        debugLogger.direct(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.blocks.length} paragraphs, ~${batch.wordCount} words)`);
      }
      
      const batchResults = [];
      
      try {
        const batchPrompt = createBatchProcessingPrompt(batch);
        const boundSessionCall = session.call.bind(session);
        boundSessionCall.session = session; // Add session reference for fallback detection
        const result = await executeWithFallback(boundSessionCall, aiConfig, batchPrompt, BatchEnhancementSchema);
        
        if (result && result.enhanced_paragraphs && result.enhanced_paragraphs.length === batch.blocks.length) {
          for (let i = 0; i < batch.blocks.length; i++) {
            const blockIndex = batch.blocks[i].originalIndex;
            const originalText = batch.blocks[i].originalText;
            const enhancedText = result.enhanced_paragraphs[i].text;
            
            if (validateEnhancement(originalText, enhancedText)) {
              batchResults.push({
                blockIndex,
                block: {
                  original: originalText,
                  contexted: enhancedText
                }
              });
              
              if (isTestMode) {
                const insertions = extractContextInsertions(enhancedText);
                if (insertions.length > 0) {
                  console.log(`[TEST_INSERTIONS] Paragraph ${blockIndex + 1} received ${insertions.length} context insertions`);
                }
              }
            } else {
              // Fallback to original text if validation fails
              batchResults.push({
                blockIndex,
                block: {
                  original: originalText,
                  contexted: originalText
                }
              });
            }
          }
        } else {
          // Fallback to original text if response format is invalid
          for (let i = 0; i < batch.blocks.length; i++) {
            const blockIndex = batch.blocks[i].originalIndex;
            const originalText = batch.blocks[i].originalText;
            batchResults.push({
              blockIndex,
              block: {
                original: originalText,
                contexted: originalText
              }
            });
          }
        }
      } catch (error) {
        if (isTestMode) {
          console.error(`[DIRECT_PROCESSING] Error processing batch ${batchIndex + 1}: ${error.message}`);
        }
        
        // Fallback to original text on error
        for (let i = 0; i < batch.blocks.length; i++) {
          const blockIndex = batch.blocks[i].originalIndex;
          const originalText = batch.blocks[i].originalText;
          batchResults.push({
            blockIndex,
            block: {
              original: originalText,
              contexted: originalText
            }
          });
        }
      }
      
      return { batchIndex: batchIndex + 1, results: batchResults };
    })();
  });
  
  // Process all batches in parallel
  debugLogger.direct(`Starting parallel processing of ${batches.length} batches with ${POLITE_DELAY_MS}ms delays`);
  const allBatchResults = await Promise.all(batchPromises);
  
  // Merge all results into processedBlocks
  for (const batchResult of allBatchResults) {
    for (const { blockIndex, block } of batchResult.results) {
      processedBlocks[blockIndex] = block;
    }
  }
  
  // Close the AI session
  closeAISession(sessionId);
  
  if (isTestMode) {
    debugLogger.direct(`Completed processing, closed session ${sessionId}`);
  }
  
  return processedBlocks.filter(block => block !== undefined);
}

/**
 * Context-optimized enhancement: Enhance content blocks using maximum-sized sliding cached context windows
 * @param {Array} blocks - Document blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - Optional AI call implementation for testing
 * @returns {Promise<Array>} Enhanced blocks with cache metrics
 */
export async function enhanceBlocksWithCaching(blocks, metadata, aiConfig, options = {}/*, callAIImpl = callAI*/) {
  debugLogger.ai('=== enhanceBlocksWithCaching called ===');
  
  // Validate inputs
  if (!blocks || !Array.isArray(blocks)) {
    console.error('[CONTEXT] ERROR: Invalid blocks passed to enhanceBlocksWithCaching:', blocks);
    return [];
  }
  
  debugLogger.ai(`Blocks: ${blocks.length}, Provider: ${aiConfig.provider}, Model: ${aiConfig.model}`);
  
  // Import the unified V2 implementation with proper caching
  const {enhanceDocumentUnifiedV2} = await import('./context_processor_unified_v2.js');
  
  // Use unified V2 approach for all documents (with proper context caching)
  debugLogger.ai('Using unified V2 implementation with proper context caching');
  return await enhanceDocumentUnifiedV2(blocks, metadata, aiConfig, options);
}

/**
 * Build minimal context window for cached session (previous approach with full context)
 * @param {number} blockIndex - Current block index
 * @param {Array} allBlocks - All document blocks
 * @param {Array} processedBlocks - Previously processed blocks
 * @returns {string} Minimal context window
 */
/**
 * Create sliding context windows with 50% overlap sized to fit AI context limits
 * @param {Array} blocks - Document blocks
 * @param {number} maxWindowWords - Maximum words per window based on AI limits
 * @param {number} staticContextSize - Size of static cached context (chars)
 * @param {Object} aiConfig - AI configuration
 * @returns {Array} Array of sliding context windows
 */
function createSlidingContextWindows(blocks, maxWindowWords, staticContextSize, aiConfig) { // eslint-disable-line no-unused-vars
  const fullText = blocks.map(block => block.text || block.content || block.original).join(' ');
  const words = fullText.split(/\s+/).filter(w => w.length > 0);

  // Reserve space for static context, prompt template, and response (conservative estimate)
  const reservedTokens = Math.ceil(staticContextSize / 3) + 800; // ~3 chars per token + prompt overhead
  const {contextTokens} = getModelContextLimits(aiConfig);
  const availableTokens = contextTokens - reservedTokens;
  const actualWindowWords = Math.min(maxWindowWords, Math.floor(availableTokens * 0.75)); // 0.75 words per token

  console.log(
    `[WINDOWS] AI Context: ${contextTokens} tokens, Reserved: ${reservedTokens}, Available: ${availableTokens}, Window: ${actualWindowWords} words`
  );

  const windows = [];
  const stepSize = Math.floor(actualWindowWords * 0.5); // 50% overlap

  // Create sliding windows with 50% overlap
  for (let start = 0; start < words.length; start += stepSize) {
    const windowWords = words.slice(start, start + actualWindowWords);
    if (windowWords.length < 50) break; // Skip very small windows

    const windowText = windowWords.join(' ');

    // End on sentence boundaries for better context
    const lastSentenceEnd = Math.max(
      windowText.lastIndexOf('.'),
      windowText.lastIndexOf('!'),
      windowText.lastIndexOf('?')
    );

    const cleanText =
      lastSentenceEnd > windowText.length * 0.8 ? windowText.substring(0, lastSentenceEnd + 1) : windowText;

    // Map which blocks are covered by this window
    const coveredBlocks = findBlocksInWindow(start, windowWords.length, blocks);

    windows.push({
      index: windows.length,
      startWord: start,
      endWord: start + windowWords.length - 1,
      wordCount: windowWords.length,
      actualWordCount: cleanText.split(/\s+/).length,
      contextText: cleanText,
      coveredBlocks: coveredBlocks
    });
  }

  return windows;
}

/**
 * Find which blocks are covered by a word range
 * @param {number} startWord - Start word index in full document
 * @param {number} windowLength - Length of window in words
 * @param {Array} blocks - All document blocks
 * @returns {Array} Array of block indices covered by this window
 */
function findBlocksInWindow(startWord, windowLength, blocks) {
  const coveredBlocks = [];
  let currentWordPosition = 0;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const blockText = blocks[blockIndex].text || blocks[blockIndex].content || blocks[blockIndex].original;
    const blockWordCount = blockText.split(/\s+/).length;

    // Check if this block overlaps with the window
    const blockStart = currentWordPosition;
    const blockEnd = currentWordPosition + blockWordCount - 1;
    const windowStart = startWord;
    const windowEnd = startWord + windowLength - 1;

    // Block overlaps with window if there's any intersection
    if (blockStart <= windowEnd && blockEnd >= windowStart) {
      coveredBlocks.push(blockIndex);
    }

    currentWordPosition += blockWordCount;
  }

  return coveredBlocks;
}

/**
 * Find the best sliding window for a specific block
 * @param {number} blockIndex - Target block index
 * @param {Array} windows - Array of sliding windows
 * @returns {Object} Best window for this block
 */
function findWindowForBlock(blockIndex, windows) { // eslint-disable-line no-unused-vars
  // Find window that contains this block (prefer windows where block is more centered)
  const candidateWindows = windows.filter(window => window.coveredBlocks.includes(blockIndex));

  if (candidateWindows.length === 0) {
    // Fallback to first window if no specific window found
    return windows[0];
  }

  if (candidateWindows.length === 1) {
    return candidateWindows[0];
  }

  // Choose window where block is most centered
  let bestWindow = candidateWindows[0];
  let bestCenterDistance = Infinity;

  for (const window of candidateWindows) {
    const windowCenter = window.coveredBlocks.length / 2;
    const blockPositionInWindow = window.coveredBlocks.indexOf(blockIndex);
    const distanceFromCenter = Math.abs(blockPositionInWindow - windowCenter);

    if (distanceFromCenter < bestCenterDistance) {
      bestCenterDistance = distanceFromCenter;
      bestWindow = window;
    }
  }

  return bestWindow;
}

/**
 * Get AI model context limits
 * @param {Object} aiConfig - AI configuration
 * @returns {Object} Context limits for the model
 */
function getModelContextLimits(aiConfig) {
  // eslint-disable-next-line no-unused-vars
  const provider = aiConfig.provider?.toLowerCase() || 'ollama';
  const model = aiConfig.model?.toLowerCase() || '';

  // Same model limits as getOptimalWindowSize but return full object
  const modelLimits = {
    // OpenAI models
    'gpt-4': {contextTokens: 8000, promptTokens: 6000},
    'gpt-4-turbo': {contextTokens: 128000, promptTokens: 100000},
    'gpt-4o': {contextTokens: 128000, promptTokens: 100000},
    'gpt-3.5-turbo': {contextTokens: 4000, promptTokens: 3000},
    // Anthropic models
    'claude-3-haiku': {contextTokens: 200000, promptTokens: 150000},
    'claude-3-sonnet': {contextTokens: 200000, promptTokens: 150000},
    'claude-3-opus': {contextTokens: 200000, promptTokens: 150000},
    'claude-3.5-sonnet': {contextTokens: 200000, promptTokens: 150000},
    // Ollama models (conservative estimates)
    'llama3.1': {contextTokens: 8000, promptTokens: 6000},
    'llama3.2': {contextTokens: 8000, promptTokens: 6000},
    'qwen2.5': {contextTokens: 32000, promptTokens: 24000},
    qwen2: {contextTokens: 8000, promptTokens: 6000},
    mistral: {contextTokens: 8000, promptTokens: 6000},
    codellama: {contextTokens: 16000, promptTokens: 12000},
    default: {contextTokens: 8000, promptTokens: 6000}
  };

  // Find matching model configuration
  let modelConfig = modelLimits.default;

  if (modelLimits[model]) {
    modelConfig = modelLimits[model];
  } else {
    // Check for partial matches
    for (const [key, config] of Object.entries(modelLimits)) {
      if (model.includes(key)) {
        modelConfig = config;
        break;
      }
    }
  }

  return modelConfig;
}

/**
 * Build maximum-sized context window with 50% overlap strategy
 * @param {number} blockIndex - Current block index
 * @param {Array} allBlocks - All document blocks
 * @param {Object} aiConfig - AI configuration for context size limits
 * @returns {string} Maximum context window
 */
export function buildMaximalContextWindow(blockIndex, allBlocks, aiConfig) {
  const currentBlock = allBlocks[blockIndex].text;
  const {windowSize} = getOptimalWindowSize(aiConfig);

  // Create sliding window with current block at center
  const allText = allBlocks.map(block => block.text || block.content || block.original).join(' ');
  const words = allText.split(/\s+/);

  // Find position of current block in full text
  let currentBlockStart = 0;
  for (let i = 0; i < blockIndex; i++) {
    const blockText = allBlocks[i].text || allBlocks[i].content || allBlocks[i].original;
    currentBlockStart += blockText.split(/\s+/).length;
  }

  // Create window centered on current block with maximum available context
  const halfWindow = Math.floor(windowSize / 2);
  const windowStart = Math.max(0, currentBlockStart - halfWindow);
  const windowEnd = Math.min(words.length, currentBlockStart + halfWindow);

  const contextWords = words.slice(windowStart, windowEnd);
  const contextText = contextWords.join(' ');

  // Ensure we end on sentence boundaries for better context
  const lastSentenceEnd = Math.max(
    contextText.lastIndexOf('.'),
    contextText.lastIndexOf('!'),
    contextText.lastIndexOf('?')
  );

  const cleanContextText =
    lastSentenceEnd > contextText.length * 0.8 ? contextText.substring(0, lastSentenceEnd + 1) : contextText;

  return `**Maximum Context Window (${contextWords.length} words):**\n${cleanContextText}\n\n**Current Block to Enhance:**\n${currentBlock}`;
}

export function buildMinimalContextWindow(blockIndex, allBlocks, processedBlocks) {
  const currentBlock = allBlocks[blockIndex].text;
  const prevContext = getPreviousContext(processedBlocks, 1000);
  const nextContext = getFollowingContext(allBlocks, blockIndex, 500);

  let context = `**Current Block:**\n${currentBlock}`;

  if (prevContext) {
    context = `**Previous Context:**\n${prevContext}\n\n${context}`;
  }

  if (nextContext) {
    context += `\n\n**Following Context:**\n${nextContext}`;
  }

  return context;
}

/**
 * PASS 2: Enhance content blocks with entity-aware disambiguation
 * @param {Array} blocks - Document blocks
 * @param {Object} entityGraph - Complete entity graph from Pass 1
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - AI call implementation
 * @returns {Promise<Array>} Enhanced blocks
 */
export async function enhanceBlocksWithEntityContext(blocks, entityGraph, aiConfig, callAIImpl = callAI) {
  console.log(`[DISAMBIGUATION] Pass 2: Enhancing ${blocks.length} blocks with entity context`);

  const processedBlocks = [];

  for (let i = 0; i < blocks.length; i++) {
    console.log(`[DISAMBIGUATION] Processing block ${i + 1}/${blocks.length}`);

    const contextWindow = buildEntityAwareContextWindow(i, blocks, processedBlocks, entityGraph);

    // Pre-escape the original text for JSON safety
    const originalEscaped = JSON.stringify(blocks[i].text);

    const enrichPrompt = `Add disambiguating context to this content block using ONLY information found elsewhere in this same document. Do not add external knowledge or information not present in the document.

${contextWindow}

DISAMBIGUATION RULES:
1. Only add context that appears elsewhere in this document
2. Help clarify pronouns, abbreviations, and unclear references  
3. Use parentheses for brief clarifications: "he" → "he (Chad Jones)"
4. Do not add information not found in the document
5. Do not repeat information already clear in the current sentence
6. Preserve the original meaning and flow exactly

IMPORTANT: Return exactly this JSON structure with the enhanced text:
{
  "contexted_markdown": ${originalEscaped},
  "context_summary": "brief summary of changes made"
}

Replace the content inside contexted_markdown with your enhanced version, keeping the same JSON string format. The original text is: ${originalEscaped}

Only add context that exists elsewhere in this document. Return valid JSON only, no other text or explanation.`;

    try {
      const contextedResult = await callAIImpl(enrichPrompt, ContextedDocSchema, aiConfig);

      if (contextedResult && contextedResult.contexted_markdown) {
        processedBlocks.push({
          original: blocks[i].text,
          contexted: contextedResult.contexted_markdown
        });
      } else {
        // Fallback to original content if enrichment fails
        processedBlocks.push({
          original: blocks[i].text,
          contexted: blocks[i].text
        });
      }
    } catch (err) {
      console.log(`[DISAMBIGUATION] Failed to enhance block ${i + 1}: ${err.message}`);
      processedBlocks.push({
        original: blocks[i].text,
        contexted: blocks[i].text
      });
    }
  }

  return processedBlocks;
}

// Build a context window for a block, filling the context budget
export function buildContextWindow(
  blockIndex,
  allBlocks,
  processedBlocks,
  documentAnalysis,
  {prevBudget = 3000, nextBudget = 1500, entityBudget = 500, totalBudget = 24000} = {}
) {
  const components = {
    documentContext: documentAnalysis.context_summary?.slice(0, 1200) || '',
    currentBlock: allBlocks[blockIndex].text,
    previousBlocks: getPreviousContext(processedBlocks, prevBudget),
    followingBlocks: getFollowingContext(allBlocks, blockIndex, nextBudget),
    keyEntities: getEntityReference(documentAnalysis.content_analysis, entityBudget)
  };
  return optimizeForTokenLimit(components, totalBudget);
}

export function getPreviousContext(processedBlocks, maxChars) {
  let context = '',
    charCount = 0;
  for (let i = processedBlocks.length - 1; i >= 0; i--) {
    const block = processedBlocks[i].contexted;
    if (charCount + block.length > maxChars) break;
    context = block + '\n\n' + context;
    charCount += block.length + 2;
  }
  return context.trim();
}

export function getFollowingContext(allBlocks, currentIndex, maxChars) {
  let context = '',
    charCount = 0;
  for (let i = currentIndex + 1; i < allBlocks.length; i++) {
    const block = allBlocks[i].text;
    if (charCount + block.length > maxChars) {
      if (i === currentIndex + 1) {
        context += block.substring(0, maxChars - charCount) + '...';
      }
      break;
    }
    context += block + '\n\n';
    charCount += block.length + 2;
  }
  return context.trim();
}

export function getEntityReference(contentAnalysis, maxChars) {
  const entities = [];
  if (contentAnalysis.people)
    entities.push('People: ' + contentAnalysis.people.map(p => p.name + (p.role ? ` (${p.role})` : '')).join(', '));
  if (contentAnalysis.places) entities.push('Places: ' + contentAnalysis.places.map(p => p.name).join(', '));
  if (contentAnalysis.organizations)
    entities.push('Organizations: ' + contentAnalysis.organizations.map(o => o.name).join(', '));
  if (contentAnalysis.themes) entities.push('Themes: ' + contentAnalysis.themes.join(', '));
  let out = entities.join(' | ');
  return out.length > maxChars ? out.slice(0, maxChars) + '...' : out;
}

export function optimizeForTokenLimit(components, tokenLimit) {
  // Strict char-based enforcement, including headers and joiners
  const joiner = '\n\n---\n\n';
  // eslint-disable-next-line no-unused-vars
  let out = '',
    parts = [];
  for (const [k, v] of Object.entries(components)) {
    if (v && v.length) parts.push(`## ${k}\n${v}`);
  }
  // Add parts one by one until budget is hit
  let acc = '',
    i = 0;
  while (i < parts.length) {
    let next = acc ? acc + joiner + parts[i] : parts[i];
    if (next.length > tokenLimit) {
      // Truncate the last part to fit
      let allowed = tokenLimit - (acc ? acc.length + joiner.length : 0);
      if (allowed > 0) acc += (acc ? joiner : '') + parts[i].slice(0, allowed) + '...';
      break;
    } else {
      acc = next;
    }
    i++;
  }
  return acc;
}

/**
 * Create a batch-specific prompt for keyed blocks (without full context)
 * @param {Object} keyedBlocks - Keyed blocks to process
 * @returns {string} Batch prompt
 */
function createKeyedBatchPrompt(keyedBlocks) {
  const blockEntries = Object.entries(keyedBlocks);
  
  return `## Blocks to Enhance
${blockEntries.map(([key, text]) => `**${key}:**\n${text}`).join('\n\n')}

## Response Format
Return exactly this JSON structure with same keys:
{
  "enhanced_blocks": {
    "${blockEntries[0][0]}": "enhanced text with [[context]] insertions",
    ...
  }
}

Enhance each block using the document context. Focus on factual clarifications like vague references ("this", "that", "we") that need disambiguation.`;
}

/**
 * Create keyed object mapping for blocks with minimum character filtering
 * @param {Array} blocks - All blocks with {text, originalIndex}
 * @param {number} minCharacters - Minimum characters for inclusion
 * @returns {Object} Keyed object with index -> text mapping
 */
function createKeyedBlockMapping(blocks, minCharacters = 100) {
  const keyedBlocks = {};
  const indexMapping = {}; // track original indices

  for (const block of blocks) {
    // Filter by content length (remove formatting characters)
    const textContent = block.text.replace(/[#*`[\]()\-_]/g, '').trim();

    if (textContent.length >= minCharacters) {
      const key = `block_${block.originalIndex}`;
      keyedBlocks[key] = block.text;
      indexMapping[key] = block.originalIndex;
    }
  }

  return {keyedBlocks, indexMapping};
}

/**
 * Get optimal batch size based on AI provider and model capabilities
 * @param {Object} aiConfig - AI configuration
 * @returns {number} Optimal words per batch
 */
function getOptimalBatchSize(aiConfig) {
  const provider = aiConfig.provider?.toLowerCase() || 'ollama';
  const model = aiConfig.model?.toLowerCase() || '';

  if (provider === 'openai') {
    if (model.includes('gpt-4o-mini')) return 1000;
    if (model.includes('gpt-4o')) return 1400;
    if (model.includes('gpt-4-turbo') || model.includes('gpt-4-1106')) return 1800;
    if (model.includes('o1-mini') || model.includes('o1-preview')) return 800; // o1 models are slower
    return 1200; // Default for OpenAI
  }

  if (provider === 'anthropic') {
    if (model.includes('claude-3-haiku')) return 1500;
    if (model.includes('claude-3-sonnet') || model.includes('claude-3.5-sonnet')) return 2500;
    if (model.includes('claude-3-opus')) return 3000;
    return 2000; // Default for Anthropic
  }

  if (provider === 'mistral') return 1200;
  if (provider === 'perplexity') return 1000;
  if (provider === 'xai') return 1200;

  return 800; // Conservative default for Ollama and unknown providers
}

/**
 * Create optimized batches that preserve block integrity
 * @param {Object} keyedBlocks - Keyed block mapping
 * @param {Object} aiConfig - AI configuration for optimal sizing
 * @returns {Array} Array of optimized batch objects
 */
function createOptimalBatches(keyedBlocks, aiConfig) {
  const targetWords = getOptimalBatchSize(aiConfig);
  const maxBlocksPerBatch = 15; // Maximum blocks per batch for JSON reliability
  const batches = [];
  let currentBatch = {blocks: {}, wordCount: 0, blockCount: 0};

  debugLogger.batching(`Target: ${targetWords} words per batch (max ${maxBlocksPerBatch} blocks) for ${aiConfig.provider}/${aiConfig.model}`);

  for (const [key, text] of Object.entries(keyedBlocks)) {
    const blockWords = text.split(/\s+/).length;

    // Start new batch if we would exceed word target OR block limit
    if (
      currentBatch.blockCount > 0 &&
      (currentBatch.wordCount + blockWords > targetWords || currentBatch.blockCount >= maxBlocksPerBatch)
    ) {
      const efficiency = Math.round((currentBatch.wordCount / targetWords) * 100);
      debugLogger.batching(`Batch ${batches.length + 1}: ${currentBatch.wordCount} words, ${currentBatch.blockCount} blocks (${efficiency}% of target)`);

      batches.push(currentBatch);
      currentBatch = {blocks: {}, wordCount: 0, blockCount: 0};
    }

    // Add complete block to current batch (never split blocks)
    currentBatch.blocks[key] = text;
    currentBatch.wordCount += blockWords;
    currentBatch.blockCount++;
  }

  // Add final batch if it has content
  if (currentBatch.blockCount > 0) {
    const efficiency = Math.round((currentBatch.wordCount / targetWords) * 100);
    debugLogger.batching(`Batch ${batches.length + 1}: ${currentBatch.wordCount} words, ${currentBatch.blockCount} blocks (${efficiency}% of target)`);
    batches.push(currentBatch);
  }

  debugLogger.batching(`Created ${batches.length} optimized batches with block integrity preserved`);
  return batches;
}

/**
 * Enhance keyed blocks with context using AI
 * @param {Object} keyedBlocks - Keyed block mapping
 * @param {Object} indexMapping - Original index mapping
 * @param {Object} metadata - Page metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} - Enhanced blocks result
 */
async function enhanceKeyedBlocksWithContext(keyedBlocks, indexMapping, metadata, aiConfig, options = {}) {
  const blockKeys = Object.keys(keyedBlocks);
  debugLogger.keyed(`Processing ${blockKeys.length} blocks with keyed object approach`);

  // Create provider-optimized batches with block integrity preserved
  const batches = createOptimalBatches(keyedBlocks, aiConfig);
  debugLogger.keyed(`Split into ${batches.length} batches for processing`);

  // Import and use V2 AI client for proper message-based caching
  const {getAISessionV2, closeAISessionV2} = await import('./ai_client_v2.js');
  
  // Create AI session with V2 client for proper caching
  const sessionId = `keyed-enhancement-${Date.now()}`;
  const session = getAISessionV2(sessionId, aiConfig);
  
  // Set cached context with ONLY instructions (not the full document)
  const cachedContext = `# KEYED CONTEXT DISAMBIGUATION

## Document Metadata
Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}

## Task
You will receive batches of text blocks from a document. Each batch contains keyed blocks that need context enhancement.

## Important Guidelines
1. **Self-Contained Batches**: Each batch contains all the context needed for disambiguation
2. **Cross-Reference Within Batch**: Look for context clues within the blocks provided in each batch
3. **[[...]] Format**: Use [[...]] delimiters for all context additions
4. **Preserve Original**: Keep all original text exactly as is, only add [[...]] insertions
5. **Factual Focus**: Prioritize factual disambiguation (names, places, dates) over grammatical clarifications
6. **No Parentheses**: Never use parentheses for clarifications - only [[...]]

## Response Format
Return a JSON object with "enhanced_blocks" containing the same keys with enhanced text.
`;
  
  session.setSystemContext(cachedContext);
  debugLogger.keyed(`Set system context: ${cachedContext.length} chars (instructions only)`);

  const allEnhancedBlocks = {};
  const POLITE_DELAY_MS = 500; // Delay between batch submissions

  try {
    // Create all batch promises with polite delays
    const batchPromises = batches.map((batch, i) => {
      // Add delay before starting each batch (except the first)
      const delayMs = i * POLITE_DELAY_MS;
      
      return new Promise((resolve) => {
        (async () => {
        // Wait for the polite delay
        if (delayMs > 0) {
          debugLogger.keyed(`Batch ${i + 1} waiting ${delayMs}ms before starting...`);
          await new Promise(wait => setTimeout(wait, delayMs));
        }
        
        debugLogger.keyed(`Processing batch ${i + 1}/${batches.length} (${batch.wordCount} words, ${batch.blockCount} blocks)`);
        
        try {
          // Create batch-specific prompt (only the blocks to process)
          const batchPrompt = createKeyedBatchPrompt(batch.blocks);
          
          // Use session to call AI with cached context
          const result = await session.call(batchPrompt, KeyedEnhancementSchema);
          
          if (result && result.enhanced_blocks) {
            debugLogger.keyed(`Batch ${i + 1} completed: ${Object.keys(result.enhanced_blocks).length} blocks enhanced`);
            resolve({ batchIndex: i + 1, enhancedBlocks: result.enhanced_blocks });
          } else {
            debugLogger.keyed(`Batch ${i + 1} failed: no enhanced blocks returned`);
            resolve({ batchIndex: i + 1, enhancedBlocks: {} });
          }
        } catch (error) {
          debugLogger.keyed(`Batch ${i + 1} error: ${error.message}`);
          resolve({ batchIndex: i + 1, enhancedBlocks: {}, error });
        }
        })();
      });
    });
    
    // Process all batches in parallel
    debugLogger.keyed(`Starting parallel processing of ${batches.length} batches with ${POLITE_DELAY_MS}ms delays`);
    const results = await Promise.all(batchPromises);
    
    // Merge all results
    for (const result of results) {
      if (result.enhancedBlocks) {
        Object.assign(allEnhancedBlocks, result.enhancedBlocks);
      }
      if (result.error) {
        debugLogger.keyed(`Batch ${result.batchIndex} had error: ${result.error.message}`);
      }
    }

    const result = {enhanced_blocks: allEnhancedBlocks};

    if (result && result.enhanced_blocks) {
      // Validate that enhanced text matches original after removing context
      const validatedBlocks = {};

      for (const [key, enhancedText] of Object.entries(result.enhanced_blocks)) {
        if (keyedBlocks[key]) {
          // Check if the block has any context insertions
          const hasInsertions = enhancedText.includes('[[') && enhancedText.includes(']]');
          
          if (hasInsertions) {
            // Only validate blocks with context insertions
            if (validateWordForWordMatch(keyedBlocks[key], enhancedText)) {
              validatedBlocks[key] = enhancedText;

              // Log insertions in test mode
              if (options.test) {
                const insertions = extractContextInsertions(enhancedText);
                if (insertions.length > 0) {
                  console.log(`[TEST_INSERTIONS] ${key} received ${insertions.length} context insertions:`);
                  insertions.forEach((insertion, idx) => {
                    console.log(`  ${idx + 1}. [[${insertion}]]`);
                  });
                }
              }
            } else {
              debugLogger.validation(`${key} failed word-for-word validation, using original`);
              validatedBlocks[key] = keyedBlocks[key];
            }
          } else {
            // No insertions, use original block (no need to validate)
            validatedBlocks[key] = keyedBlocks[key];
          }
        }
      }

      // Ensure all keys are present
      for (const key of blockKeys) {
        if (!validatedBlocks[key]) {
          validatedBlocks[key] = keyedBlocks[key];
        }
      }

      return {
        enhancedBlocks: validatedBlocks,
        indexMapping: indexMapping,
        processingTime: 0
      };
    } else {
      if (process.env.NODE_ENV === 'test') {
        console.log(`[KEYED] Enhancement failed, using original content`);
      }
      return {
        enhancedBlocks: keyedBlocks,
        indexMapping: indexMapping,
        processingTime: 0
      };
    }
  } catch (error) {
    debugLogger.keyed(`Error processing blocks: ${error.message}`);
    return {
      enhancedBlocks: keyedBlocks,
      indexMapping: indexMapping,
      processingTime: 0
    };
  } finally {
    // Always close the session to clean up
    if (session) {
      const metrics = closeAISessionV2(sessionId);
      if (metrics) {
        debugLogger.keyed(`Session closed. Cache hit rate: ${metrics.hitRate}%`);
        debugLogger.ai(`V2 Session metrics: Tokens saved: ${metrics.tokensSaved || 0}`);
      }
    }
  }
}

// Function removed - now using session caching approach in enhanceKeyedBlocksWithContext

/**
 * Validate that enhanced text matches original word-for-word after removing [[...]] insertions
 * @param {string} originalText - Original block text
 * @param {string} enhancedText - Enhanced text with [[...]] insertions
 * @returns {boolean} True if texts match word-for-word
 */
function validateWordForWordMatch(originalText, enhancedText) {
  // Remove all [[...]] insertions from enhanced text
  const cleanedEnhanced = enhancedText.replace(/\[\[[^\]]+\]\]/g, '');

  // Normalize text more aggressively for comparison
  const normalizeText = text =>
    text
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[""'']/g, '"') // Normalize quotes
      .replace(/[–—]/g, '-') // Normalize dashes
      .replace(/\u00A0/g, ' ') // Replace non-breaking spaces
      .trim()
      .toLowerCase();

  const normalizedOriginal = normalizeText(originalText);
  const normalizedCleaned = normalizeText(cleanedEnhanced);

  // If exact match fails, try word-by-word comparison
  if (normalizedOriginal === normalizedCleaned) {
    return true;
  }

  // Split into words and compare (more lenient)
  const originalWords = normalizedOriginal.split(/\s+/).filter(w => w.length > 0);
  const cleanedWords = normalizedCleaned.split(/\s+/).filter(w => w.length > 0);

  if (originalWords.length !== cleanedWords.length) {
    return false;
  }

  // Check if 95% of words match (allows for minor differences)
  let matchCount = 0;
  for (let i = 0; i < originalWords.length; i++) {
    if (originalWords[i] === cleanedWords[i]) {
      matchCount++;
    }
  }

  const matchRatio = matchCount / originalWords.length;
  return matchRatio >= 0.95;
}

/**
 * Enhance a single page with context disambiguation
 * @param {string} url - Page URL
 * @param {string} filePath - Path to markdown file
 * @param {Object} aiConfig - AI configuration
 * @param {Object} db - Database instance
 * @returns {Promise<Object>} - Enhancement result with status
 */
export async function enhanceSinglePage(url, filePath, aiConfig, db) {
  const startTime = Date.now();

  try {
    // Update database: starting attempt
    const updateAttemptStmt = db.db.prepare(`
      UPDATE pages 
      SET context_attempts = context_attempts + 1, 
          last_context_attempt = ?, 
          context_error = NULL,
          content_status = 'processing'
      WHERE url = ?
    `);
    updateAttemptStmt.run(new Date().toISOString(), url);

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

    // Parse into blocks and filter by content length
    const allBlocks = content
      .split(/\n{2,}/)
      .map((text, index) => ({text, originalIndex: index}))
      .filter(block => block.text.trim());

    // Filter out blocks with less than 100 characters of significant content
    const significantBlocks = allBlocks.filter(block => {
      const textContent = block.text.replace(/[#*`[\]()\-_]/g, '').trim();
      return textContent.length >= 100;
    });

    debugLogger.batching(`Original blocks: ${allBlocks.length}, Significant blocks: ${significantBlocks.length}`);

    if (significantBlocks.length === 0) {
      throw new Error('No significant content blocks found (all blocks < 100 characters)');
    }

    // Create keyed object mapping for significant blocks
    const {keyedBlocks, indexMapping} = createKeyedBlockMapping(significantBlocks, 100);

    debugLogger.keyed(`Created keyed mapping for ${Object.keys(keyedBlocks).length} blocks from ${significantBlocks.length} significant blocks`);

    if (Object.keys(keyedBlocks).length === 0) {
      throw new Error('No blocks meet the minimum character requirement (100 chars)');
    }

    // Get page metadata from database
    const pageStmt = db.db.prepare('SELECT title FROM pages WHERE url = ?');
    const pageData = pageStmt.get(url);
    const meta = {title: pageData?.title || '', url: url};

    // Enhance content with keyed object approach
    const result = await enhanceKeyedBlocksWithContext(keyedBlocks, indexMapping, meta, aiConfig, {test: false});

    if (!result || !result.enhancedBlocks) {
      throw new Error('Context enhancement returned no results');
    }

    // Reconstruct full document with enhanced blocks
    const enhancedBlocks = new Array(allBlocks.length);

    // Map enhanced content back to original block positions using indexMapping
    for (const [key, enhancedText] of Object.entries(result.enhancedBlocks)) {
      const originalIndex = result.indexMapping[key];
      if (originalIndex !== undefined) {
        enhancedBlocks[originalIndex] = enhancedText;
      }
    }

    // Fill in any non-enhanced blocks with original content
    for (let i = 0; i < allBlocks.length; i++) {
      if (enhancedBlocks[i] === undefined) {
        enhancedBlocks[i] = allBlocks[i].text;
      }
    }

    // Track insertions for test mode
    if (insertionTracker.enabled) {
      const fileName = filePath.split('/').pop();
      const allInsertions = [];
      const enhancedBlocksForTracking = [];

      for (const [key, enhancedText] of Object.entries(result.enhancedBlocks)) {
        const originalText = keyedBlocks[key];
        const insertions = extractContextInsertions(enhancedText);
        allInsertions.push(...insertions);

        if (insertions.length > 0) {
          enhancedBlocksForTracking.push({
            fileName,
            blockKey: key,
            original: originalText,
            enhanced: enhancedText,
            insertions
          });
        }
      }

      insertionTracker.trackFile(filePath, allInsertions, enhancedBlocksForTracking);

      if (allInsertions.length > 0) {
        if (process.env.NODE_ENV === 'test') {
          console.log(`[INSERTIONS] ${fileName}: ${allInsertions.length} insertions added`);
        }
      }
    }

    const contextedMarkdown = enhancedBlocks.join('\n\n');

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
    const updateSuccessStmt = db.db.prepare(`
      UPDATE pages 
      SET content_status = 'contexted', 
          context_error = NULL
      WHERE url = ?
    `);
    updateSuccessStmt.run(url);

    const duration = Date.now() - startTime;
    // Only show success logs in test mode
    if (process.env.NODE_ENV === 'test') {
      console.log(`[CONTEXT] ✓ Enhanced: ${url} (${duration}ms)`);
    }

    return {
      success: true,
      url: url,
      processingTime: duration,
      blocksProcessed: Object.keys(result.enhancedBlocks || {}).length
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    // Determine error type for appropriate status
    let contextStatus = 'raw'; // Default fallback
    let contextError = error.message;

    if (error.message.includes('rate limit') || error.message.includes('429')) {
      contextStatus = 'rate_limited';
      // Only show rate limit logs in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] ⚠️  Rate limited: ${url} - will retry later`);
      }
    } else if (error.message.includes('timed out')) {
      contextStatus = 'timeout';
      // Only show timeout logs in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] ⚠️  Timeout: ${url} - will retry later`);
      }
    } else {
      contextStatus = 'failed';
      // Only show failure details in test mode (errors still go to console.error)
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] ❌ Failed: ${url} - ${error.message}`);
      }
    }

    // Update database: error
    const updateErrorStmt = db.db.prepare(`
      UPDATE pages 
      SET content_status = ?, 
          context_error = ?
      WHERE url = ?
    `);
    updateErrorStmt.run(contextStatus, contextError, url);

    return {
      success: false,
      url: url,
      error: error.message,
      processingTime: duration,
      status: contextStatus
    };
  }
}

/**
 * Run TWO-PASS context enrichment for all raw docs in DB.
 * Pass 1: Extract comprehensive entity graph with sliding windows
 * Pass 2: Enhance content blocks using complete entity knowledge
 * @param {string} dbPath - Path to crawl DB
 * @param {object} aiConfig - AI config (provider, host, model, etc)
 * @param {function} progressCallback - Optional callback for progress updates (index, total)
 */
export async function runContextEnrichment(dbOrPath, aiConfig, progressCallback = null) {
  // Accept either a db instance (CrawlDB) or a path
  let db,
    shouldClose = false;
  if (typeof dbOrPath === 'string') {
    db = getDB(dbOrPath);
    shouldClose = true;
  } else {
    db = dbOrPath;
  }

  const rawDocs = db.db.prepare("SELECT url, file_path, title FROM pages WHERE content_status = 'raw'").all();
  // Only show in test mode
  if (process.env.NODE_ENV === 'test') {
    logger.info(`[CONTEXT] Starting optimized context enhancement for ${rawDocs.length} documents`);
  }

  for (let docIndex = 0; docIndex < rawDocs.length; docIndex++) {
    const doc = rawDocs[docIndex];
    try {
      // Only show in test mode
      if (process.env.NODE_ENV === 'test') {
        logger.info(`[CONTEXT] Processing document ${docIndex + 1}/${rawDocs.length}: ${doc.url}`);
      }

      if (!doc.file_path || !fs.existsSync(doc.file_path)) {
        // Only show skip logs in test mode
        if (process.env.NODE_ENV === 'test') {
          console.log(`[CONTEXT] Skipping ${doc.url} - no file path or file doesn't exist`);
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

      // Parse markdown into blocks (simple split, or use a markdown parser for more accuracy)
      const blocks = content
        .split(/\n{2,}/)
        .map(text => ({text}))
        .filter(block => block.text.trim());

      if (blocks.length === 0) {
        // Only show skip logs in test mode
        if (process.env.NODE_ENV === 'test') {
          console.log(`[CONTEXT] Skipping ${doc.url} - no content blocks`);
        }
        continue;
      }

      // Use metadata from DB if present, else empty
      let meta = {title: doc.title || '', url: doc.url};
      try {
        if (doc.metadata) meta = {...meta, ...JSON.parse(doc.metadata)};
      } catch {
        // Continue with basic metadata if parsing fails
      }

      // OPTIMIZED: Skip entity extraction - go directly to context enhancement
      // Only show in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] Context enhancement for ${doc.url} (${blocks.length} blocks) - OPTIMIZED MODE`);
      }

      let result;
      try {
        // Add timeout handling with graceful degradation - increased timeout for batch processing
        const enhancementPromise = enhanceBlocksWithCaching(blocks, meta, aiConfig, {test: false});
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Context enhancement timed out')), 240000); // 4 minute timeout per page
        });

        result = await Promise.race([enhancementPromise, timeoutPromise]);
      } catch (timeoutError) {
        if (timeoutError.message.includes('timed out')) {
          // Only show timeout details in test mode
          if (process.env.NODE_ENV === 'test') {
            console.log(`[CONTEXT] ⚠️  Context enhancement timed out for ${doc.url} - leaving raw for retry later`);
          }
          // Leave the document raw (don't update database status) so it can be retried later
          continue;
        } else {
          throw timeoutError; // Re-throw other errors
        }
      }

      if (!result || !result.blocks) {
        // Only show skip logs in test mode
        if (process.env.NODE_ENV === 'test') {
          console.log(`[CONTEXT] Skipping ${doc.url} - context enhancement failed`);
        }
        continue;
      }

      // Use the enhanced blocks from the optimized caching system
      const processedBlocks = result.blocks;

      // Debug: Check what's in the processed blocks
      const blocksWithInsertions = processedBlocks.filter(
        b => b.contexted && b.contexted !== b.original && b.contexted.includes('[[')
      );
      debugLogger.ai(
        `[CONTEXT] Document ${doc.url}: ${blocksWithInsertions.length}/${processedBlocks.length} blocks have context insertions`
      );

      // Reassemble enriched markdown with [[...]] context insertions
      const contextedMarkdown = processedBlocks.map(b => b.contexted || b.original).join('\n\n');

      // Debug: Check if any insertions were made
      const insertionsCount = contextedMarkdown.match(/\[\[.*?\]\]/g)?.length || 0;
      // Only show insertion count in test mode
      if (process.env.NODE_ENV === 'test') {
        logger.info(`[CONTEXT] Document ${doc.url}: Found ${insertionsCount} context insertions in final markdown`);
      }

      // Preserve frontmatter if present
      let finalMarkdown = contextedMarkdown;
      if (markdown.startsWith('---')) {
        const frontmatterEnd = markdown.indexOf('---', 3);
        if (frontmatterEnd > 0) {
          const frontmatter = markdown.substring(0, frontmatterEnd + 3);
          finalMarkdown = frontmatter + '\n\n' + contextedMarkdown;
        }
      }

      // Write the enriched content back to the file
      // Only show file write details in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] Writing enhanced content to file: ${doc.file_path}`);
      }
      await fs.promises.writeFile(doc.file_path, finalMarkdown, 'utf8');
      // Only show file write success in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] File written successfully`);
      }

      // Update the database to mark as processed
      // Only show database update details in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] Updating database status for ${doc.url} to 'contexted'`);
      }
      try {
        const updateResult = db.db
          .prepare('UPDATE pages SET content_status = ? WHERE url = ?')
          .run('contexted', doc.url);
        // Only show database update results in test mode
        if (process.env.NODE_ENV === 'test') {
          console.log(`[CONTEXT] Database update result:`, updateResult);
        }
        if (updateResult.changes === 0) {
          throw new Error(`No rows updated - URL ${doc.url} not found in database`);
        }
      } catch (dbError) {
        console.error(`[CONTEXT] Database update failed for ${doc.url}:`, dbError);
        throw dbError; // Re-throw to trigger the catch block above
      }

      // Only show completion details in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(`[CONTEXT] ✓ Completed optimized context enhancement for: ${doc.url}`);
      }
      // Only show processing metrics in test mode
      if (process.env.NODE_ENV === 'test') {
        console.log(
          `[CONTEXT] Processing time: ${result.processingTime}ms, Cache hit rate: ${result.cacheMetrics.hitRate}%`
        );
      }
    } catch (err) {
      console.error(`[CONTEXT] Failed processing doc with url=${doc.url}:`, err.message);
      console.error(`[CONTEXT] Full error:`, err);
      console.error(`[CONTEXT] Stack trace:`, err.stack);
      // Continue with next document instead of failing completely
    }
    
    // Update progress callback if provided
    if (progressCallback) {
      progressCallback(docIndex + 1, rawDocs.length, doc.url);
    }
  }

  if (shouldClose) db.close();
}

/**
 * Build entity summary for header
 * @param {Object} entityGraph - Complete entity graph
 * @returns {string} Formatted entity summary
 */
export function buildEntitySummary(entityGraph) {
  const parts = [];

  if (entityGraph.people?.length > 0) {
    const topPeople = entityGraph.people
      .slice(0, 3)
      .map(p => p.name)
      .join(', ');
    parts.push(
      `People: ${topPeople}${entityGraph.people.length > 3 ? ` (+${entityGraph.people.length - 3} more)` : ''}`
    );
  }

  if (entityGraph.places?.length > 0) {
    const topPlaces = entityGraph.places
      .slice(0, 3)
      .map(p => p.name)
      .join(', ');
    parts.push(
      `Places: ${topPlaces}${entityGraph.places.length > 3 ? ` (+${entityGraph.places.length - 3} more)` : ''}`
    );
  }

  if (entityGraph.organizations?.length > 0) {
    const topOrgs = entityGraph.organizations
      .slice(0, 2)
      .map(o => o.name)
      .join(', ');
    parts.push(
      `Organizations: ${topOrgs}${entityGraph.organizations.length > 2 ? ` (+${entityGraph.organizations.length - 2} more)` : ''}`
    );
  }

  if (entityGraph.documents?.length > 0) {
    const topDocs = entityGraph.documents
      .slice(0, 2)
      .map(d => d.title)
      .join(', ');
    parts.push(
      `Documents: ${topDocs}${entityGraph.documents.length > 2 ? ` (+${entityGraph.documents.length - 2} more)` : ''}`
    );
  }

  return parts.join('; ');
}

// Export utility functions for context delimiter management
export {removeContextInsertions, extractContextInsertions};
