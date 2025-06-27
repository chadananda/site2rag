// context_processor.js
// Entity extraction functionality for knowledge graph generation
// Note: Context disambiguation has been moved to context_enrichment.js
import {z} from 'zod';
import pLimit from 'p-limit';
import debugLogger from '../services/debug_logger.js';
import {callAI} from './ai_client.js';
/**
 * Simple wrapper to call AI and parse response with schema
 * @param {string} prompt - AI prompt
 * @param {Object} schema - Zod schema for validation
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - AI implementation (for testing)
 * @returns {Promise<Object>} Parsed response
 */
async function parseAIResponse(prompt, schema, aiConfig, callAIImpl = callAI) {
  return await callAIImpl(prompt, schema, aiConfig);
}
// Schema definitions for entity extraction
export const DocumentAnalysisSchema = z.object({
  summary: z.string().describe('Brief summary of document content and context'),
  document_type: z.string().describe('Type of document (article, blog, documentation, etc.)'),
  main_topics: z.array(z.string()).describe('Primary topics discussed'),
  writing_style: z.string().describe('Writing style (technical, narrative, academic, etc.)'),
  time_period: z.string().optional().describe('Time period discussed if temporal elements are present'),
  perspective: z.string().optional().describe('Perspective or point of view if relevant')
});
export const EntityExtractionSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string(),
        aliases: z.array(z.string()).optional(),
        roles: z.array(z.string()).optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  places: z
    .array(
      z.object({
        name: z.string(),
        aliases: z.array(z.string()).optional(),
        type: z.string().optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  organizations: z
    .array(
      z.object({
        name: z.string(),
        aliases: z.array(z.string()).optional(),
        type: z.string().optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  dates: z
    .array(
      z.object({
        date: z.string(),
        event: z.string().optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  relationships: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        relationship: z.string(),
        context: z.string().optional()
      })
    )
    .optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        timeframe: z.string().optional(),
        location: z.string().optional(),
        participants: z.array(z.string()).optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  documents: z
    .array(
      z.object({
        title: z.string(),
        author: z.string().optional(),
        type: z.string().optional(),
        date: z.string().optional(),
        subject_matter: z.array(z.string()).optional(),
        context: z.string().optional()
      })
    )
    .optional(),
  subjects: z.array(z.string()).optional()
});
export const EntityGraphSchema = z.object({
  documentAnalysis: DocumentAnalysisSchema.optional(),
  people: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).optional(),
      roles: z.array(z.string()).optional(),
      context: z.string().optional()
    })
  ),
  places: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).optional(),
      type: z.string().optional(),
      context: z.string().optional()
    })
  ),
  organizations: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).optional(),
      type: z.string().optional(),
      context: z.string().optional()
    })
  ),
  dates: z.array(
    z.object({
      date: z.string(),
      event: z.string().optional(),
      context: z.string().optional()
    })
  ),
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      relationship: z.string(),
      context: z.string().optional()
    })
  ),
  events: z.array(
    z.object({
      name: z.string(),
      timeframe: z.string().optional(),
      location: z.string().optional(),
      participants: z.array(z.string()).optional(),
      context: z.string().optional()
    })
  ),
  documents: z.array(
    z.object({
      title: z.string(),
      author: z.string().optional(),
      type: z.string().optional(),
      date: z.string().optional(),
      subject_matter: z.array(z.string()).optional(),
      context: z.string().optional()
    })
  ),
  subjects: z.array(z.string())
});
/**
 * Extract entities using sliding window approach for better coverage
 * @param {Array} blocks - Document content blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - AI call implementation (for testing)
 * @returns {Promise<Object>} Entity graph
 */
export async function extractEntitiesWithSlidingWindow(blocks, metadata, aiConfig, callAIImpl = callAI) {
  debugLogger.ai('Starting entity extraction with sliding window approach...');
  debugLogger.ai(`Processing ${blocks.length} blocks`);
  // Phase 1: Analyze the document structure and context
  debugLogger.ai('Phase 1: Analyzing document structure...');
  const documentAnalysis = await analyzeDocument(blocks, metadata, aiConfig, callAIImpl);
  // Phase 2: Extract entities using sliding windows
  debugLogger.ai('Phase 2: Extracting entities with sliding windows...');
  const WINDOW_SIZE = 5;
  const OVERLAP_SIZE = 2;
  const windows = createSlidingWindows(blocks, WINDOW_SIZE, OVERLAP_SIZE);
  debugLogger.ai(`Created ${windows.length} sliding windows`);
  // Process windows in parallel with rate limiting
  const limiter = pLimit(3);
  const extractionPromises = windows.map((window, index) =>
    limiter(async () => {
      debugLogger.ai(`Processing window ${index + 1}/${windows.length} (blocks ${window.start}-${window.end})`);
      const windowText = window.blocks.join('\n\n');
      const previousContext = index > 0 ? windows[index - 1].blocks.slice(-2).join('\n\n') : '';
      const prompt = `Extract all named entities and their relationships from this text segment.
${documentAnalysis ? `Document context: ${JSON.stringify(documentAnalysis)}` : ''}
${previousContext ? `Previous context: ${previousContext}` : ''}
Current text segment:
${windowText}
Focus on:
- People: full names, roles, and their context
- Places: locations, buildings, cities, countries
- Organizations: companies, institutions, groups
- Important dates and time periods
- Events: significant occurrences
- Documents: mentioned works, papers, books
- Relationships: connections between entities
- Key subjects and themes
Capture as much detail as possible, including context and alternative names/aliases.
Return empty arrays for categories with no entities found.`;
      try {
        const entityExtraction = await parseAIResponse(prompt, EntityExtractionSchema, aiConfig, callAIImpl);
        debugLogger.ai(
          `Window ${index + 1} extracted: ${JSON.stringify({
            people: entityExtraction.people?.length || 0,
            places: entityExtraction.places?.length || 0,
            organizations: entityExtraction.organizations?.length || 0,
            dates: entityExtraction.dates?.length || 0,
            events: entityExtraction.events?.length || 0,
            documents: entityExtraction.documents?.length || 0,
            relationships: entityExtraction.relationships?.length || 0
          })}`
        );
        return entityExtraction;
      } catch (error) {
        debugLogger.ai(`Failed to extract entities from window ${index + 1}: ${error.message}`);
        return {
          people: [],
          places: [],
          organizations: [],
          dates: [],
          relationships: [],
          events: [],
          documents: [],
          subjects: []
        };
      }
    })
  );
  const extractions = await Promise.all(extractionPromises);
  // Merge all extractions
  debugLogger.ai('Phase 3: Merging entity extractions...');
  const mergedEntities = mergeEntityExtractions(extractions);
  // Add document analysis to the entity graph
  const entityGraph = {
    documentAnalysis,
    ...mergedEntities
  };
  // Log summary
  debugLogger.ai('Entity extraction complete:');
  debugLogger.ai(
    `- People: ${entityGraph.people.length} (${entityGraph.people
      .slice(0, 3)
      .map(p => p.name)
      .join(', ')}${entityGraph.people.length > 3 ? '...' : ''})`
  );
  debugLogger.ai(
    `- Places: ${entityGraph.places.length} (${entityGraph.places
      .slice(0, 3)
      .map(p => p.name)
      .join(', ')}${entityGraph.places.length > 3 ? '...' : ''})`
  );
  debugLogger.ai(`- Organizations: ${entityGraph.organizations.length}`);
  debugLogger.ai(`- Dates: ${entityGraph.dates.length}`);
  debugLogger.ai(`- Events: ${entityGraph.events.length}`);
  debugLogger.ai(`- Documents: ${entityGraph.documents.length}`);
  debugLogger.ai(`- Relationships: ${entityGraph.relationships.length}`);
  debugLogger.ai(`- Subjects: ${entityGraph.subjects.length}`);
  return entityGraph;
}
/**
 * Create sliding windows from blocks
 * @param {Array} blocks - Document blocks
 * @param {number} windowSize - Size of each window
 * @param {number} overlapSize - Overlap between windows
 * @returns {Array} Array of windows
 */
export function createSlidingWindows(blocks, windowSize, overlapSize) {
  const windows = [];
  const step = windowSize - overlapSize;
  for (let i = 0; i < blocks.length; i += step) {
    const windowBlocks = blocks.slice(i, i + windowSize);
    windows.push({
      start: i,
      end: Math.min(i + windowSize - 1, blocks.length - 1),
      blocks: windowBlocks.map(b => (typeof b === 'string' ? b : b.content || b.text || ''))
    });
    // Stop if we've covered all blocks
    if (i + windowSize >= blocks.length) break;
  }
  return windows;
}
/**
 * Merge entity extractions from multiple windows
 * @param {Array} extractions - Array of entity extractions
 * @returns {Object} Merged entity graph
 */
export function mergeEntityExtractions(extractions) {
  const merged = {
    people: [],
    places: [],
    organizations: [],
    dates: [],
    relationships: [],
    events: [],
    documents: [],
    subjects: []
  };
  for (const extraction of extractions) {
    merged.people = mergeEntities(merged.people, extraction.people || [], 'name');
    merged.places = mergeEntities(merged.places, extraction.places || [], 'name');
    merged.organizations = mergeEntities(merged.organizations, extraction.organizations || [], 'name');
    merged.dates = mergeEntities(merged.dates, extraction.dates || [], 'date');
    merged.events = mergeEntities(merged.events, extraction.events || [], 'name');
    merged.documents = mergeEntities(merged.documents, extraction.documents || [], 'title');
    merged.relationships = mergeRelationships(merged.relationships, extraction.relationships || []);
    // Merge subjects (simple string array)
    if (extraction.subjects) {
      extraction.subjects.forEach(subject => {
        if (!merged.subjects.includes(subject)) {
          merged.subjects.push(subject);
        }
      });
    }
  }
  return merged;
}
/**
 * Merge entities with deduplication
 * @param {Array} existing - Existing entities
 * @param {Array} newEntities - New entities to merge
 * @param {string} keyField - Field to use for matching
 * @returns {Array} Merged entities
 */
export function mergeEntities(existing, newEntities, keyField) {
  const merged = [...existing];
  for (const newEntity of newEntities) {
    const existingIndex = merged.findIndex(e => e[keyField]?.toLowerCase() === newEntity[keyField]?.toLowerCase());
    if (existingIndex >= 0) {
      // Merge properties
      const existingEntity = merged[existingIndex];
      // Merge aliases
      if (newEntity.aliases) {
        existingEntity.aliases = existingEntity.aliases || [];
        newEntity.aliases.forEach(alias => {
          if (!existingEntity.aliases.includes(alias)) {
            existingEntity.aliases.push(alias);
          }
        });
      }
      // Merge roles (for people)
      if (newEntity.roles) {
        existingEntity.roles = existingEntity.roles || [];
        newEntity.roles.forEach(role => {
          if (!existingEntity.roles.includes(role)) {
            existingEntity.roles.push(role);
          }
        });
      }
      // Keep the more detailed context
      if (newEntity.context && (!existingEntity.context || newEntity.context.length > existingEntity.context.length)) {
        existingEntity.context = newEntity.context;
      }
    } else {
      merged.push(newEntity);
    }
  }
  return merged;
}
/**
 * Merge relationships with deduplication
 * @param {Array} existing - Existing relationships
 * @param {Array} newRelationships - New relationships to merge
 * @returns {Array} Merged relationships
 */
export function mergeRelationships(existing, newRelationships) {
  const merged = [...existing];
  for (const newRel of newRelationships) {
    const exists = merged.some(
      r =>
        r.from?.toLowerCase() === newRel.from?.toLowerCase() &&
        r.to?.toLowerCase() === newRel.to?.toLowerCase() &&
        r.relationship?.toLowerCase() === newRel.relationship?.toLowerCase()
    );
    if (!exists) {
      merged.push(newRel);
    }
  }
  return merged;
}
/**
 * Analyze document structure and context
 * @param {Array} blocks - Document blocks
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Function} callAIImpl - AI call implementation
 * @returns {Promise<Object>} Document analysis
 */
export async function analyzeDocument(blocks, metadata, aiConfig, callAIImpl = callAI) {
  const sampleBlocks = blocks
    .slice(0, 10)
    .map(b => (typeof b === 'string' ? b : b.content || b.text || ''))
    .join('\n\n');
  const prompt = `Analyze this document and provide a high-level understanding:
Title: ${metadata.title || 'Unknown'}
URL: ${metadata.url || 'Unknown'}
Description: ${metadata.description || 'None'}
Sample content:
${sampleBlocks}
Provide:
1. A brief summary of what this document is about
2. The type of document (article, blog post, documentation, etc.)
3. Main topics discussed
4. Writing style (technical, narrative, academic, etc.)
5. Time period (if temporal elements are present)
6. Perspective or point of view (if relevant)`;
  try {
    const analysis = await parseAIResponse(prompt, DocumentAnalysisSchema, aiConfig, callAIImpl);
    debugLogger.ai(`Document analysis: ${analysis.summary}`);
    return analysis;
  } catch (error) {
    debugLogger.ai(`Document analysis failed: ${error.message}`);
    return null;
  }
}
