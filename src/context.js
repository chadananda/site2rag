// context.js
// Contextual enrichment task for site2rag
// This module will process documents with content_status='raw' and add disambiguating context using AI.
// It uses a centralized callAI(prompt, schema, aiConfig) function for all AI calls.
// Zod is used for schema validation.

import { getDB } from './db.js';
// All DB access must use getDB() from src/db.js. Never instantiate CrawlDB directly.
import { z } from 'zod';
import { callAI } from './call_ai.js';
import fs from 'fs';

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
    people: z.array(z.object({ name: z.string(), role: z.string().optional() })).optional(),
    places: z.array(z.object({ name: z.string(), context: z.string().optional() })).optional(),
    organizations: z.array(z.object({ name: z.string(), context: z.string().optional() })).optional(),
    themes: z.array(z.string()).optional()
  }),
  context_summary: z.string()
});

export const ContextedDocSchema = z.object({
  contexted_markdown: z.string(),
  context_summary: z.string().optional(),
});

// Zod schema for entity extraction (Pass 1)
export const EntityExtractionSchema = z.object({
  people: z.array(z.object({
    name: z.string(),
    roles: z.array(z.string()).optional(),
    aliases: z.array(z.string()).optional(),
    context: z.string().optional()
  })).optional(),
  places: z.array(z.object({
    name: z.string(),
    context: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    type: z.string().optional() // city, country, building, etc.
  })).optional(),
  organizations: z.array(z.object({
    name: z.string(),
    context: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    type: z.string().optional() // company, institution, etc.
  })).optional(),
  dates: z.array(z.object({
    date: z.string(),
    context: z.string().optional(),
    precision: z.string().optional() // exact, approximate, range
  })).optional(),
  events: z.array(z.object({
    name: z.string(),
    timeframe: z.string().optional(),
    participants: z.array(z.string()).optional(),
    location: z.string().optional(),
    context: z.string().optional()
  })).optional(),
  subjects: z.array(z.string()),
  relationships: z.array(z.object({
    from: z.string(),
    relationship: z.string(),
    to: z.string(),
    context: z.string().optional()
  })).optional()
});

// Combined entity graph from all chunks
export const EntityGraphSchema = z.object({
  people: z.array(z.object({
    name: z.string(),
    roles: z.array(z.string()).optional(),
    aliases: z.array(z.string()).optional(),
    context: z.string().optional()
  })).optional(),
  places: z.array(z.object({
    name: z.string(),
    context: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    type: z.string().optional()
  })).optional(),
  organizations: z.array(z.object({
    name: z.string(),
    context: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    type: z.string().optional()
  })).optional(),
  dates: z.array(z.object({
    date: z.string(),
    context: z.string().optional(),
    precision: z.string().optional()
  })).optional(),
  events: z.array(z.object({
    name: z.string(),
    timeframe: z.string().optional(),
    participants: z.array(z.string()).optional(),
    location: z.string().optional(),
    context: z.string().optional()
  })).optional(),
  subjects: z.array(z.string()),
  relationships: z.array(z.object({
    from: z.string(),
    relationship: z.string(),
    to: z.string(),
    context: z.string().optional()
  })).optional()
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
  const windowSize = 4000; // words per chunk
  const overlapSize = 500; // overlap between windows
  
  console.log(`[ENTITIES] Pass 1: Extracting entities from ${blocks.length} blocks`);
  
  // Create sliding windows
  const windows = createSlidingWindows(blocks, windowSize, overlapSize);
  console.log(`[ENTITIES] Created ${windows.length} sliding windows`);
  
  // Extract entities from each window
  const entityExtractions = [];
  for (let i = 0; i < windows.length; i++) {
    console.log(`[ENTITIES] Processing window ${i + 1}/${windows.length}`);
    
    const windowText = windows[i].join('\n\n');
    const metadataEscaped = JSON.stringify(metadata);
    const contentEscaped = JSON.stringify(windowText);
    
    const prompt = `Extract all entities, subjects, and relationships from this document section. 
Focus on people, places, organizations, dates, events, and main subjects/topics.

Document metadata: ${metadataEscaped}
Content section ${i + 1}/${windows.length}: ${contentEscaped}

IMPORTANT: Return exactly this JSON structure:
{
  "people": [],
  "places": [],
  "organizations": [],
  "dates": [],
  "events": [],
  "subjects": [],
  "relationships": []
}

Fill the arrays with extracted entities. Use this format for each entity type:
- people: {"name": "string", "roles": ["array"], "aliases": ["array"], "context": "string"}
- places: {"name": "string", "context": "string", "aliases": ["array"], "type": "string"}
- organizations: {"name": "string", "context": "string", "aliases": ["array"], "type": "string"}
- dates: {"date": "string", "context": "string", "precision": "string"}
- events: {"name": "string", "timeframe": "string", "participants": ["array"], "location": "string", "context": "string"}
- subjects: ["string"] (main topics/subjects)
- relationships: {"from": "string", "relationship": "string", "to": "string", "context": "string"}

Return valid JSON only, no other text or explanation.`;

    try {
      const extraction = await callAIImpl(prompt, EntityExtractionSchema, aiConfig);
      if (extraction) {
        entityExtractions.push(extraction);
      }
    } catch (err) {
      console.log(`[ENTITIES] Failed to extract from window ${i + 1}: ${err.message}`);
    }
  }
  
  // Merge all extractions into single entity graph
  const entityGraph = mergeEntityExtractions(entityExtractions);
  console.log(`[ENTITIES] Merged entities: ${entityGraph.people?.length || 0} people, ${entityGraph.places?.length || 0} places, ${entityGraph.subjects?.length || 0} subjects`);
  
  return entityGraph;
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
    if (extraction.subjects) {
      merged.subjects = [...new Set([...merged.subjects, ...extraction.subjects])];
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
  existing.forEach(entity => existingMap.set(entity[keyField].toLowerCase(), entity));
  
  for (const newEntity of newEntities) {
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
      existingMap.set(key, { ...newEntity });
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
    existing.map(r => `${r.from}|${r.relationship}|${r.to}`)
  );
  
  const merged = [...existing];
  for (const rel of newRelationships) {
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
  let wordBudget = 3000, used = 0, selected = [];
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
export function buildEntityAwareContextWindow(blockIndex, allBlocks, processedBlocks, entityGraph, {
  prevBudget = 2000, nextBudget = 1000, entityBudget = 2000, totalBudget = 24000
} = {}) {
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
    relationships: []
  };
  
  // Find people mentioned (including aliases)
  if (entityGraph.people) {
    for (const person of entityGraph.people) {
      if (blockLower.includes(person.name.toLowerCase()) ||
          person.aliases?.some(alias => blockLower.includes(alias.toLowerCase()))) {
        relevant.people.push(person);
      }
    }
  }
  
  // Find places mentioned
  if (entityGraph.places) {
    for (const place of entityGraph.places) {
      if (blockLower.includes(place.name.toLowerCase()) ||
          place.aliases?.some(alias => blockLower.includes(alias.toLowerCase()))) {
        relevant.places.push(place);
      }
    }
  }
  
  // Find organizations mentioned
  if (entityGraph.organizations) {
    for (const org of entityGraph.organizations) {
      if (blockLower.includes(org.name.toLowerCase()) ||
          org.aliases?.some(alias => blockLower.includes(alias.toLowerCase()))) {
        relevant.organizations.push(org);
      }
    }
  }
  
  // Find relevant relationships
  if (entityGraph.relationships) {
    const mentionedEntities = [
      ...relevant.people.map(p => p.name),
      ...relevant.places.map(p => p.name), 
      ...relevant.organizations.map(o => o.name)
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
  
  if (relevantEntities.relationships?.length > 0) {
    const relsText = relevantEntities.relationships
      .map(r => `${r.from} ${r.relationship} ${r.to}`)
      .join('; ');
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
    
    const enrichPrompt = `Using the provided entity context, enhance this content block with disambiguating information. Add context that helps readers understand references, abbreviations, and implicit knowledge while preserving the original meaning and flow.

${contextWindow}

IMPORTANT: Return exactly this JSON structure with the enhanced text:
{
  "contexted_markdown": ${originalEscaped},
  "context_summary": "brief summary of changes made"
}

Replace the content inside contexted_markdown with your enhanced version, keeping the same JSON string format. The original text is: ${originalEscaped}

Enhance the text and return valid JSON only, no other text or explanation.`;

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
export function buildContextWindow(blockIndex, allBlocks, processedBlocks, documentAnalysis, {
  prevBudget = 3000, nextBudget = 1500, entityBudget = 500, totalBudget = 24000
} = {}) {
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
  let context = '', charCount = 0;
  for (let i = processedBlocks.length - 1; i >= 0; i--) {
    const block = processedBlocks[i].contexted;
    if (charCount + block.length > maxChars) break;
    context = block + '\n\n' + context;
    charCount += block.length + 2;
  }
  return context.trim();
}

export function getFollowingContext(allBlocks, currentIndex, maxChars) {
  let context = '', charCount = 0;
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
  if (contentAnalysis.people) entities.push('People: ' + contentAnalysis.people.map(p => p.name + (p.role ? ` (${p.role})` : '')).join(', '));
  if (contentAnalysis.places) entities.push('Places: ' + contentAnalysis.places.map(p => p.name).join(', '));
  if (contentAnalysis.organizations) entities.push('Organizations: ' + contentAnalysis.organizations.map(o => o.name).join(', '));
  if (contentAnalysis.themes) entities.push('Themes: ' + contentAnalysis.themes.join(', '));
  let out = entities.join(' | ');
  return out.length > maxChars ? out.slice(0, maxChars) + '...' : out;
}

export function optimizeForTokenLimit(components, tokenLimit) {
  // Strict char-based enforcement, including headers and joiners
  const joiner = '\n\n---\n\n';
  let out = '', parts = [];
  for (const [k, v] of Object.entries(components)) {
    if (v && v.length) parts.push(`## ${k}\n${v}`);
  }
  // Add parts one by one until budget is hit
  let acc = '', i = 0;
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
 * Run TWO-PASS context enrichment for all raw docs in DB.
 * Pass 1: Extract comprehensive entity graph with sliding windows
 * Pass 2: Enhance content blocks using complete entity knowledge
 * @param {string} dbPath - Path to crawl DB
 * @param {object} aiConfig - AI config (provider, host, model, etc)
 */
export async function runContextEnrichment(dbOrPath, aiConfig) {
  // Accept either a db instance (CrawlDB) or a path
  let db, shouldClose = false;
  if (typeof dbOrPath === 'string') {
    db = getDB(dbOrPath);
    shouldClose = true;
  } else {
    db = dbOrPath;
  }
  
  const rawDocs = db.db.prepare("SELECT url, file_path, title FROM pages WHERE content_status = 'raw'").all();
  console.log(`[CONTEXT] Starting two-pass enrichment for ${rawDocs.length} documents`);
  
  for (const doc of rawDocs) {
    try {
      console.log(`[CONTEXT] Processing: ${doc.url}`);
      
      if (!doc.file_path || !fs.existsSync(doc.file_path)) {
        console.log(`[CONTEXT] Skipping ${doc.url} - no file path or file doesn't exist`);
        continue;
      }

      const markdown = await fs.promises.readFile(doc.file_path, 'utf8');
      
      // Parse markdown into blocks (simple split, or use a markdown parser for more accuracy)
      const blocks = markdown.split(/\n{2,}/).map(text => ({ text }));
      
      if (blocks.length === 0) {
        console.log(`[CONTEXT] Skipping ${doc.url} - no content blocks`);
        continue;
      }

      // Use metadata from DB if present, else empty
      let meta = { title: doc.title || '', url: doc.url };
      try { 
        if (doc.metadata) meta = { ...meta, ...JSON.parse(doc.metadata) }; 
      } catch (e) {
        // Continue with basic metadata if parsing fails
      }

      // PASS 1: Extract entities with sliding window for comprehensive coverage
      console.log(`[CONTEXT] PASS 1: Entity extraction for ${doc.url} (${blocks.length} blocks)`);
      const entityGraph = await extractEntitiesWithSlidingWindow(blocks, meta, aiConfig);
      
      if (!entityGraph) {
        console.log(`[CONTEXT] Skipping ${doc.url} - entity extraction failed`);
        continue;
      }

      // PASS 2: Enhance blocks with complete entity knowledge
      console.log(`[CONTEXT] PASS 2: Content enhancement for ${doc.url}`);
      const processedBlocks = await enhanceBlocksWithEntityContext(blocks, entityGraph, aiConfig);

      // Reassemble enriched markdown
      const contextedMarkdown = processedBlocks.map(b => b.contexted).join('\n\n');
      
      // Create comprehensive header with subjects and entity summary
      const subjectMap = entityGraph.subjects?.length > 0 ? entityGraph.subjects.join(', ') : '';
      const entitySummary = buildEntitySummary(entityGraph);
      
      const headerContent = [
        subjectMap ? `Subjects: ${subjectMap}` : '',
        entitySummary ? `Key Entities: ${entitySummary}` : ''
      ].filter(Boolean).join('\n');
      
      const finalMarkdown = headerContent ? 
        `> ENTITY CONTEXT\n> ${headerContent}\n\n${contextedMarkdown}` : 
        contextedMarkdown;

      // Write the enriched content back to the file
      await fs.promises.writeFile(doc.file_path, finalMarkdown, 'utf8');
      
      // Update the database to mark as processed
      db.db.prepare('UPDATE pages SET content_status = "contexted" WHERE url = ?').run(doc.url);
      
      console.log(`[CONTEXT] ✓ Completed two-pass enrichment for: ${doc.url}`);
      console.log(`[CONTEXT] Extracted: ${entityGraph.people?.length || 0} people, ${entityGraph.places?.length || 0} places, ${entityGraph.subjects?.length || 0} subjects`);
      
    } catch (err) {
      console.error(`[CONTEXT] Failed processing doc with url=${doc.url}:`, err.message);
      // Continue with next document instead of failing completely
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
    const topPeople = entityGraph.people.slice(0, 3).map(p => p.name).join(', ');
    parts.push(`People: ${topPeople}${entityGraph.people.length > 3 ? ` (+${entityGraph.people.length - 3} more)` : ''}`);
  }
  
  if (entityGraph.places?.length > 0) {
    const topPlaces = entityGraph.places.slice(0, 3).map(p => p.name).join(', ');
    parts.push(`Places: ${topPlaces}${entityGraph.places.length > 3 ? ` (+${entityGraph.places.length - 3} more)` : ''}`);
  }
  
  if (entityGraph.organizations?.length > 0) {
    const topOrgs = entityGraph.organizations.slice(0, 2).map(o => o.name).join(', ');
    parts.push(`Organizations: ${topOrgs}${entityGraph.organizations.length > 2 ? ` (+${entityGraph.organizations.length - 2} more)` : ''}`);
  }
  
  return parts.join('; ');
}
