// knowledge_graph.js
// Knowledge graph extraction and operations for site2rag file processing
// Human-readable plain text format for portability

import fs from 'fs';
import path from 'path';
import {parseFile} from './parser.js';
import {extractEntitiesWithSlidingWindow} from '../core/context_processor.js';
import {loadAIConfig} from '../core/ai_config.js';

/**
 * Extract knowledge graph from one or more files
 * @param {Array<string>} filePaths - Array of file paths to process
 * @param {string|null} outputPath - Output file path or null for stdout
 * @returns {Promise<void>}
 */
export async function extractGraph(filePaths, outputPath = null) {
  console.log(`[KNOWLEDGE_GRAPH] Extracting entities from ${filePaths.length} file(s)`);

  const allEntities = [];
  const sources = [];

  for (const filePath of filePaths) {
    try {
      console.log(`[KNOWLEDGE_GRAPH] Processing: ${filePath}`);

      // Parse the file
      const parsed = parseFile(filePath);
      sources.push({
        file: filePath,
        title: parsed.metadata.title || path.basename(filePath),
        processed_at: new Date().toISOString()
      });

      // Extract entities using existing two-pass system
      const aiConfig = await loadAIConfig();
      const entityGraph = await extractEntitiesWithSlidingWindow(parsed.blocks, parsed.metadata, aiConfig);

      // Add source attribution to entities
      addSourceAttribution(entityGraph, filePath);
      allEntities.push(entityGraph);
    } catch (error) {
      console.error(`[KNOWLEDGE_GRAPH] Failed to process ${filePath}: ${error.message}`);
    }
  }

  // Merge all entity graphs
  const mergedGraph = mergeEntityGraphs(allEntities);

  // Serialize to human-readable format
  const serialized = serializeGraph(mergedGraph, sources);

  // Output result
  if (outputPath) {
    fs.writeFileSync(outputPath, serialized, 'utf8');
    console.log(`[KNOWLEDGE_GRAPH] Knowledge graph saved to: ${outputPath}`);
  } else {
    console.log(serialized);
  }
}

/**
 * Add source attribution to entity graph
 * @param {Object} entityGraph - Entity graph to annotate
 * @param {string} sourceFile - Source file path
 */
function addSourceAttribution(entityGraph, sourceFile) {
  const fileName = path.basename(sourceFile);

  // Add source to all entity types
  ['people', 'places', 'organizations', 'dates', 'events', 'documents'].forEach(entityType => {
    if (entityGraph[entityType]) {
      entityGraph[entityType].forEach(entity => {
        if (!entity.sources) entity.sources = [];
        entity.sources.push(fileName);
      });
    }
  });

  // Add source to relationships
  if (entityGraph.relationships) {
    entityGraph.relationships.forEach(rel => {
      if (!rel.sources) rel.sources = [];
      rel.sources.push(fileName);
    });
  }
}

/**
 * Merge multiple entity graphs with deduplication
 * @param {Array<Object>} entityGraphs - Array of entity graphs to merge
 * @returns {Object} Merged entity graph
 */
function mergeEntityGraphs(entityGraphs) {
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

  for (const graph of entityGraphs) {
    // Merge each entity type
    Object.keys(merged).forEach(entityType => {
      if (graph[entityType]) {
        graph[entityType].forEach(entity => {
          const existing = findExistingEntity(merged[entityType], entity);
          if (existing) {
            // Merge with existing entity
            mergeEntityData(existing, entity);
          } else {
            // Add new entity
            merged[entityType].push({...entity});
          }
        });
      }
    });
  }

  return merged;
}

/**
 * Find existing entity by name/key
 * @param {Array} entities - Array of entities to search
 * @param {Object} newEntity - Entity to find
 * @returns {Object|null} Existing entity or null
 */
function findExistingEntity(entities, newEntity) {
  const key = newEntity.name || newEntity.title || newEntity.date || newEntity.from;
  return entities.find(entity => {
    const entityKey = entity.name || entity.title || entity.date || entity.from;
    return entityKey && entityKey.toLowerCase() === key?.toLowerCase();
  });
}

/**
 * Merge data from new entity into existing entity
 * @param {Object} existing - Existing entity to update
 * @param {Object} newEntity - New entity data to merge
 */
function mergeEntityData(existing, newEntity) {
  // Merge roles
  if (newEntity.roles && existing.roles) {
    newEntity.roles.forEach(role => {
      if (!existing.roles.includes(role)) {
        existing.roles.push(role);
      }
    });
  } else if (newEntity.roles) {
    existing.roles = [...newEntity.roles];
  }

  // Merge aliases
  if (newEntity.aliases && existing.aliases) {
    newEntity.aliases.forEach(alias => {
      if (!existing.aliases.includes(alias)) {
        existing.aliases.push(alias);
      }
    });
  } else if (newEntity.aliases) {
    existing.aliases = [...newEntity.aliases];
  }

  // Merge sources
  if (newEntity.sources && existing.sources) {
    newEntity.sources.forEach(source => {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }
    });
  } else if (newEntity.sources) {
    existing.sources = [...newEntity.sources];
  }

  // Merge context (keep more detailed one)
  if (newEntity.context && (!existing.context || newEntity.context.length > existing.context.length)) {
    existing.context = newEntity.context;
  }
}

/**
 * Serialize entity graph to human-readable text format
 * @param {Object} entityGraph - Entity graph to serialize
 * @param {Array} sources - Source file information
 * @returns {string} Human-readable knowledge graph
 */
export function serializeGraph(entityGraph, sources = []) {
  const lines = [];

  // Header
  lines.push('# Knowledge Graph: Document Analysis');
  lines.push(`# Generated: ${new Date().toISOString()}`);

  if (sources.length > 0) {
    lines.push(`# Sources: ${sources.map(s => s.file).join(', ')}`);
  }

  lines.push('');

  // People
  if (entityGraph.people && entityGraph.people.length > 0) {
    lines.push('## People');
    entityGraph.people.forEach(person => {
      let line = person.name;

      // Add primary role
      if (person.roles && person.roles.length > 0) {
        line += `: ${person.roles[0]}`;
        if (person.roles.length > 1) {
          line += `, ${person.roles.slice(1).join(', ')}`;
        }
      }

      // Add key details
      const details = [];
      if (person.aliases && person.aliases.length > 0) {
        details.push(`also known as ${person.aliases.join(', ')}`);
      }
      if (person.context) {
        details.push(person.context);
      }

      if (details.length > 0) {
        line += ` | ${details.join(', ')}`;
      }

      lines.push(line);
    });
    lines.push('');
  }

  // Places
  if (entityGraph.places && entityGraph.places.length > 0) {
    lines.push('## Places');
    entityGraph.places.forEach(place => {
      let line = place.name;

      // Add type
      if (place.type) {
        line += `: ${place.type}`;
      }

      // Add key details
      const details = [];
      if (place.aliases && place.aliases.length > 0) {
        details.push(`also known as ${place.aliases.join(', ')}`);
      }
      if (place.context) {
        details.push(place.context);
      }

      if (details.length > 0) {
        line += ` | ${details.join(', ')}`;
      }

      lines.push(line);
    });
    lines.push('');
  }

  // Organizations
  if (entityGraph.organizations && entityGraph.organizations.length > 0) {
    lines.push('## Organizations');
    entityGraph.organizations.forEach(org => {
      const facts = [org.name];

      if (org.type) {
        facts.push(`type: ${org.type}`);
      }

      if (org.aliases && org.aliases.length > 0) {
        facts.push(`aliases: ${org.aliases.join(', ')}`);
      }

      if (org.context) {
        facts.push(org.context);
      }

      lines.push(facts.join(' | '));
    });
    lines.push('');
  }

  // Events
  if (entityGraph.events && entityGraph.events.length > 0) {
    lines.push('## Events');
    entityGraph.events.forEach(event => {
      const facts = [event.name];

      if (event.timeframe) {
        facts.push(`time: ${event.timeframe}`);
      }

      if (event.location) {
        facts.push(`location: ${event.location}`);
      }

      if (event.participants && event.participants.length > 0) {
        facts.push(`participants: ${event.participants.join(', ')}`);
      }

      if (event.context) {
        facts.push(event.context);
      }

      lines.push(facts.join(' | '));
    });
    lines.push('');
  }

  // Documents
  if (entityGraph.documents && entityGraph.documents.length > 0) {
    lines.push('## Documents');
    entityGraph.documents.forEach(doc => {
      let line = doc.title;

      // Add type and author in natural format
      if (doc.type && doc.author) {
        line += `: ${doc.type} by ${doc.author}`;
      } else if (doc.type) {
        line += `: ${doc.type}`;
      } else if (doc.author) {
        line += ` by ${doc.author}`;
      }

      // Add key details
      const details = [];
      if (doc.subject_matter && doc.subject_matter.length > 0) {
        details.push(doc.subject_matter.join(', '));
      }
      if (doc.date) {
        details.push(doc.date);
      }
      if (doc.context) {
        details.push(doc.context);
      }

      if (details.length > 0) {
        line += ` | ${details.join(', ')}`;
      }

      lines.push(line);
    });
    lines.push('');
  }

  // Subjects
  if (entityGraph.subjects && entityGraph.subjects.length > 0) {
    lines.push('## Subjects');
    // Filter and ensure all subjects are valid strings
    const validSubjects = entityGraph.subjects.filter(s => s && typeof s === 'string' && s.trim()).map(s => s.trim());
    if (validSubjects.length > 0) {
      lines.push(validSubjects.join(', '));
    }
    lines.push('');
  }

  // Relationships
  if (entityGraph.relationships && entityGraph.relationships.length > 0) {
    lines.push('## Relationships');
    entityGraph.relationships.forEach(rel => {
      const facts = [`${rel.from} → ${rel.relationship} → ${rel.to}`];

      if (rel.context) {
        facts.push(rel.context);
      }

      lines.push(facts.join(' | '));
    });
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse human-readable knowledge graph back to structured data
 * @param {string} graphText - Text format knowledge graph
 * @returns {Object} Parsed entity graph
 */
export function parseGraph(graphText) {
  const lines = graphText.split('\n');
  const graph = {
    people: [],
    places: [],
    organizations: [],
    dates: [],
    events: [],
    documents: [],
    subjects: [],
    relationships: []
  };

  let currentSection = null;
  let currentEntity = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section headers
    if (trimmed.startsWith('## ')) {
      const section = trimmed.slice(3).toLowerCase();
      currentSection = section;
      currentEntity = null;
      continue;
    }

    // Entity properties (indented)
    if (trimmed.startsWith('- ') && currentEntity) {
      const [key, ...valueParts] = trimmed.slice(2).split(': ');
      const value = valueParts.join(': ');

      if (key === 'Context') {
        currentEntity.context = value;
      } else if (key === 'Aliases') {
        currentEntity.aliases = value.split(', ');
      } else if (key === 'Sources') {
        currentEntity.sources = value.split(', ');
      } else if (key === 'Date') {
        currentEntity.date = value;
      } else if (key === 'Subject Matter') {
        currentEntity.subject_matter = value.split(', ').map(s => s.trim());
      }
      continue;
    }

    // Entity or relationship
    if (currentSection && trimmed) {
      if (currentSection === 'relationships') {
        const parts = trimmed.split(' → ');
        if (parts.length === 3) {
          currentEntity = {
            from: parts[0].trim(),
            relationship: parts[1].trim(),
            to: parts[2].trim()
          };
          graph.relationships.push(currentEntity);
        }
      } else if (currentSection === 'subjects') {
        graph.subjects = trimmed.split(', ').map(s => s.trim());
        currentEntity = null;
      } else if (currentSection === 'documents') {
        // Parse documents: "Title (type) by Author" or "Title (type)" or "Title by Author"
        const docMatch = trimmed.match(/^(.+?)(?:\s*\(([^)]+)\))?(?:\s+by\s+(.+))?$/);
        if (docMatch) {
          currentEntity = {
            title: docMatch[1].trim()
          };

          if (docMatch[2]) {
            currentEntity.type = docMatch[2].trim();
          }

          if (docMatch[3]) {
            currentEntity.author = docMatch[3].trim();
          }

          graph.documents.push(currentEntity);
        }
      } else {
        // Parse entity with optional type in parentheses
        const match = trimmed.match(/^(.+?)(?:\s*\(([^)]+)\))?$/);
        if (match) {
          currentEntity = {
            name: match[1].trim()
          };

          if (match[2]) {
            if (currentSection === 'people') {
              currentEntity.roles = match[2].split(', ').map(r => r.trim());
            } else if (currentSection === 'places') {
              currentEntity.type = match[2];
            } else if (currentSection === 'organizations') {
              currentEntity.type = match[2];
            }
          }

          if (graph[currentSection]) {
            graph[currentSection].push(currentEntity);
          }
        }
      }
    }
  }

  return graph;
}

/**
 * Merge multiple knowledge graph files
 * @param {Array<string>} graphPaths - Paths to graph files to merge
 * @param {string} outputPath - Output path for merged graph
 * @returns {Promise<void>}
 */
export async function mergeGraphs(graphPaths, outputPath) {
  console.log(`[KNOWLEDGE_GRAPH] Merging ${graphPaths.length} knowledge graphs`);

  const graphs = [];
  const sources = [];

  for (const graphPath of graphPaths) {
    try {
      const content = fs.readFileSync(graphPath, 'utf8');
      const parsed = parseGraph(content);
      graphs.push(parsed);
      sources.push({
        file: graphPath,
        title: path.basename(graphPath),
        processed_at: new Date().toISOString()
      });

      console.log(`[KNOWLEDGE_GRAPH] Loaded: ${graphPath}`);
    } catch (error) {
      console.error(`[KNOWLEDGE_GRAPH] Failed to load ${graphPath}: ${error.message}`);
    }
  }

  const merged = mergeEntityGraphs(graphs);
  const serialized = serializeGraph(merged, sources);

  if (outputPath) {
    fs.writeFileSync(outputPath, serialized, 'utf8');
    console.log(`[KNOWLEDGE_GRAPH] Merged graph saved to: ${outputPath}`);
  } else {
    console.log(serialized);
  }
}

/**
 * Validate knowledge graph format and consistency
 * @param {string} graphPath - Path to knowledge graph file
 * @returns {Promise<void>}
 */
export async function validateGraph(graphPath) {
  console.log(`[KNOWLEDGE_GRAPH] Validating: ${graphPath}`);

  try {
    const content = fs.readFileSync(graphPath, 'utf8');
    const parsed = parseGraph(content);

    // Basic validation
    const entityTypes = ['people', 'places', 'organizations', 'events', 'documents'];
    let totalEntities = 0;

    entityTypes.forEach(type => {
      const count = parsed[type] ? parsed[type].length : 0;
      console.log(`[VALIDATION] ${type}: ${count} entities`);
      totalEntities += count;
    });

    const relationshipCount = parsed.relationships ? parsed.relationships.length : 0;
    console.log(`[VALIDATION] relationships: ${relationshipCount} relationships`);

    // Check for orphaned relationships
    const allEntityNames = new Set();
    entityTypes.forEach(type => {
      if (parsed[type]) {
        parsed[type].forEach(entity => {
          allEntityNames.add(entity.name);
          if (entity.aliases) {
            entity.aliases.forEach(alias => allEntityNames.add(alias));
          }
        });
      }
    });

    let orphanedRelationships = 0;
    if (parsed.relationships) {
      parsed.relationships.forEach(rel => {
        if (!allEntityNames.has(rel.from) || !allEntityNames.has(rel.to)) {
          orphanedRelationships++;
        }
      });
    }

    console.log(`[VALIDATION] Total entities: ${totalEntities}`);
    console.log(`[VALIDATION] Orphaned relationships: ${orphanedRelationships}`);

    if (orphanedRelationships === 0) {
      console.log(`[VALIDATION] ✅ Knowledge graph is valid`);
    } else {
      console.log(`[VALIDATION] ⚠️  Found ${orphanedRelationships} orphaned relationships`);
    }
  } catch (error) {
    console.error(`[VALIDATION] ❌ Validation failed: ${error.message}`);
    process.exit(1);
  }
}
