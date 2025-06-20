// file_processor.js
// File processing orchestration for site2rag
// Coordinates parsing, enhancement, and output

import fs from 'fs';
import path from 'path';
import { parseFile, isFileSupported } from '../file/parser.js';
import { parseGraph } from '../file/knowledge_graph.js';
import { enhanceBlocksWithCaching, enhanceBlocksWithEntityContext, extractEntitiesWithSlidingWindow } from '../context.js';
import { loadAIConfig } from '../ai_config_loader.js';

/**
 * Process a file with context enhancement
 * @param {string} filePath - Path to the file to process
 * @param {Object} options - CLI options
 * @returns {Promise<void>}
 */
export async function processFile(filePath, options) {
  console.log(`[FILE_PROCESSOR] Processing: ${filePath}`);
  
  // Validate file
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  if (!isFileSupported(filePath)) {
    throw new Error(`Unsupported file format: ${path.extname(filePath)}`);
  }
  
  try {
    // Parse the file
    console.log(`[FILE_PROCESSOR] Parsing file...`);
    const parsed = parseFile(filePath);
    
    // Load AI configuration
    const aiConfig = await loadAIConfig();
    
    // Load external knowledge graph if provided
    let externalEntityGraph = null;
    if (options.knowledgeGraph) {
      console.log(`[FILE_PROCESSOR] Loading external knowledge graph: ${options.knowledgeGraph}`);
      externalEntityGraph = await loadExternalKnowledgeGraph(options.knowledgeGraph);
    }
    
    // Determine output path
    const outputPath = determineOutputPath(filePath, options.output, parsed.originalFormat);
    
    if (options.noEnhancement) {
      // Only extract entities, don't enhance content
      console.log(`[FILE_PROCESSOR] Extracting entities only...`);
      const entityGraph = await extractEntitiesWithSlidingWindow(
        parsed.blocks,
        parsed.metadata,
        aiConfig
      );
      
      // Output entity graph as JSON
      const entityOutputPath = outputPath.replace(/\.[^.]+$/, '.entities.json');
      fs.writeFileSync(entityOutputPath, JSON.stringify(entityGraph, null, 2), 'utf8');
      console.log(`[FILE_PROCESSOR] Entities saved to: ${entityOutputPath}`);
      return;
    }
    
    // Extract entities from document
    console.log(`[FILE_PROCESSOR] Extracting document entities...`);
    const documentEntityGraph = await extractEntitiesWithSlidingWindow(
      parsed.blocks,
      parsed.metadata,
      aiConfig
    );
    
    // Merge with external knowledge graph if provided
    const combinedEntityGraph = externalEntityGraph 
      ? mergeEntityGraphs(documentEntityGraph, externalEntityGraph)
      : documentEntityGraph;
    
    // Enhance content with context
    console.log(`[FILE_PROCESSOR] Enhancing content with context...`);
    const enhancedBlocks = await enhanceContent(
      parsed.blocks,
      combinedEntityGraph,
      parsed.metadata,
      aiConfig,
      options
    );
    
    // Generate enhanced output
    console.log(`[FILE_PROCESSOR] Generating enhanced output...`);
    const enhancedContent = generateEnhancedOutput(
      parsed,
      enhancedBlocks,
      combinedEntityGraph,
      options
    );
    
    // Write output file
    fs.writeFileSync(outputPath, enhancedContent, 'utf8');
    console.log(`[FILE_PROCESSOR] Enhanced file saved to: ${outputPath}`);
    
    // Output statistics
    const originalWordCount = parsed.blocks.reduce((sum, block) => sum + block.word_count, 0);
    const enhancedWordCount = enhancedBlocks.reduce((sum, block) => sum + (block.contexted?.split(/\s+/).length || block.original.split(/\s+/).length), 0);
    const improvement = enhancedWordCount - originalWordCount;
    
    console.log(`[FILE_PROCESSOR] Processing complete:`);
    console.log(`  - Original blocks: ${parsed.blocks.length}`);
    console.log(`  - Original word count: ${originalWordCount}`);
    console.log(`  - Enhanced word count: ${enhancedWordCount} (+${improvement})`);
    console.log(`  - Enhancement improvement: ${((improvement / originalWordCount) * 100).toFixed(1)}%`);
    
  } catch (error) {
    console.error(`[FILE_PROCESSOR] Processing failed: ${error.message}`);
    throw error;
  }
}

/**
 * Load external knowledge graph from file
 * @param {string} graphPath - Path to knowledge graph file
 * @returns {Promise<Object>} Parsed knowledge graph
 */
async function loadExternalKnowledgeGraph(graphPath) {
  if (!fs.existsSync(graphPath)) {
    throw new Error(`Knowledge graph file not found: ${graphPath}`);
  }
  
  try {
    const content = fs.readFileSync(graphPath, 'utf8');
    
    // Support both JSON and text formats
    if (graphPath.endsWith('.json')) {
      return JSON.parse(content);
    } else {
      return parseGraph(content);
    }
  } catch (error) {
    throw new Error(`Failed to parse knowledge graph: ${error.message}`);
  }
}

/**
 * Merge document entity graph with external knowledge graph
 * @param {Object} documentGraph - Entity graph from document
 * @param {Object} externalGraph - External knowledge graph
 * @returns {Object} Merged entity graph
 */
function mergeEntityGraphs(documentGraph, externalGraph) {
  const merged = JSON.parse(JSON.stringify(documentGraph)); // Deep copy
  
  // Merge each entity type
  ['people', 'places', 'organizations', 'dates', 'events', 'subjects', 'relationships'].forEach(entityType => {
    if (externalGraph[entityType] && Array.isArray(externalGraph[entityType])) {
      if (!merged[entityType]) merged[entityType] = [];
      
      externalGraph[entityType].forEach(externalEntity => {
        // Check if entity already exists in document graph
        const existing = findExistingEntity(merged[entityType], externalEntity, entityType);
        if (!existing) {
          // Add external entity (mark as external)
          const entityCopy = { ...externalEntity, external: true };
          merged[entityType].push(entityCopy);
        }
      });
    }
  });
  
  console.log(`[FILE_PROCESSOR] Merged knowledge graphs:`);
  console.log(`  - Document entities: ${JSON.stringify(getEntityCounts(documentGraph))}`);
  console.log(`  - External entities: ${JSON.stringify(getEntityCounts(externalGraph))}`);
  console.log(`  - Combined entities: ${JSON.stringify(getEntityCounts(merged))}`);
  
  return merged;
}

/**
 * Find existing entity in array by name/key
 * @param {Array} entities - Array to search
 * @param {Object} searchEntity - Entity to find
 * @param {string} entityType - Type of entity
 * @returns {Object|null} Found entity or null
 */
function findExistingEntity(entities, searchEntity, entityType) {
  const searchKey = getEntityKey(searchEntity, entityType);
  if (!searchKey) return null;
  
  return entities.find(entity => {
    const entityKey = getEntityKey(entity, entityType);
    return entityKey && entityKey.toLowerCase() === searchKey.toLowerCase();
  });
}

/**
 * Get unique key for entity comparison
 * @param {Object} entity - Entity object
 * @param {string} entityType - Type of entity
 * @returns {string|null} Entity key
 */
function getEntityKey(entity, entityType) {
  switch (entityType) {
    case 'people':
    case 'places':
    case 'organizations':
    case 'events':
      return entity.name;
    case 'dates':
      return entity.date;
    case 'relationships':
      return `${entity.from}-${entity.relationship}-${entity.to}`;
    default:
      return entity.name || entity.value;
  }
}

/**
 * Get entity counts for logging
 * @param {Object} entityGraph - Entity graph
 * @returns {Object} Count object
 */
function getEntityCounts(entityGraph) {
  const counts = {};
  ['people', 'places', 'organizations', 'dates', 'events'].forEach(type => {
    counts[type] = entityGraph[type] ? entityGraph[type].length : 0;
  });
  return counts;
}

/**
 * Enhance content blocks with context
 * @param {Array} blocks - Content blocks to enhance
 * @param {Object} entityGraph - Combined entity graph
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Object} options - CLI options
 * @returns {Promise<Array>} Enhanced blocks
 */
async function enhanceContent(blocks, entityGraph, metadata, aiConfig, options) {
  if (options.cacheContext) {
    // Use cache-optimized enhancement
    console.log(`[FILE_PROCESSOR] Using cache-optimized enhancement...`);
    const result = await enhanceBlocksWithCaching(blocks, entityGraph, metadata, aiConfig);
    return result.blocks || result; // Handle both response formats
  } else {
    // Use traditional enhancement
    console.log(`[FILE_PROCESSOR] Using traditional enhancement...`);
    return await enhanceBlocksWithEntityContext(blocks, entityGraph, aiConfig);
  }
}

/**
 * Determine output file path
 * @param {string} inputPath - Input file path
 * @param {string|undefined} outputOption - CLI output option
 * @param {string} originalFormat - Original file format
 * @returns {string} Output file path
 */
function determineOutputPath(inputPath, outputOption, originalFormat) {
  if (outputOption) {
    return outputOption;
  }
  
  // Default: add "-enhanced" suffix
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  const dir = path.dirname(inputPath);
  
  return path.join(dir, `${base}-enhanced${ext}`);
}

/**
 * Generate enhanced output content
 * @param {Object} parsed - Parsed file data
 * @param {Array} enhancedBlocks - Enhanced content blocks
 * @param {Object} entityGraph - Entity graph
 * @param {Object} options - CLI options
 * @returns {string} Enhanced content
 */
function generateEnhancedOutput(parsed, enhancedBlocks, entityGraph, options) {
  const lines = [];
  
  // Add enhanced frontmatter
  const enhancedMetadata = {
    ...parsed.metadata,
    enhanced_at: new Date().toISOString(),
    enhancement_method: options.cacheContext ? 'cache-optimized' : 'traditional',
    entity_counts: getEntityCounts(entityGraph),
    word_count_improvement: calculateWordCountImprovement(parsed.blocks, enhancedBlocks)
  };
  
  // Add frontmatter if original had it or if we're adding metadata
  if (Object.keys(parsed.metadata).length > 2 || options.addMetadata) { // More than just source_file and parsed_at
    lines.push('---');
    Object.entries(enhancedMetadata).forEach(([key, value]) => {
      if (typeof value === 'object') {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    });
    lines.push('---');
    lines.push('');
  }
  
  // Add enhanced content blocks
  enhancedBlocks.forEach((block, index) => {
    const content = block.contexted || block.original;
    lines.push(content);
    
    // Add spacing between blocks (except last)
    if (index < enhancedBlocks.length - 1) {
      lines.push('');
    }
  });
  
  return lines.join('\n');
}

/**
 * Calculate word count improvement
 * @param {Array} originalBlocks - Original blocks
 * @param {Array} enhancedBlocks - Enhanced blocks
 * @returns {Object} Improvement statistics
 */
function calculateWordCountImprovement(originalBlocks, enhancedBlocks) {
  const originalWords = originalBlocks.reduce((sum, block) => sum + block.word_count, 0);
  const enhancedWords = enhancedBlocks.reduce((sum, block) => {
    const content = block.contexted || block.original;
    return sum + content.split(/\s+/).length;
  }, 0);
  
  return {
    original: originalWords,
    enhanced: enhancedWords,
    added: enhancedWords - originalWords,
    percentage: ((enhancedWords - originalWords) / originalWords * 100).toFixed(1)
  };
}

/**
 * Process multiple files in batch
 * @param {Array<string>} filePaths - Array of file paths
 * @param {Object} options - CLI options
 * @returns {Promise<void>}
 */
export async function processFiles(filePaths, options) {
  console.log(`[FILE_PROCESSOR] Batch processing ${filePaths.length} files`);
  
  const results = [];
  
  for (const filePath of filePaths) {
    try {
      await processFile(filePath, options);
      results.push({ file: filePath, status: 'success' });
    } catch (error) {
      console.error(`[FILE_PROCESSOR] Failed to process ${filePath}: ${error.message}`);
      results.push({ file: filePath, status: 'failed', error: error.message });
    }
  }
  
  // Summary
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  
  console.log(`[FILE_PROCESSOR] Batch processing complete:`);
  console.log(`  - Successful: ${successful}`);
  console.log(`  - Failed: ${failed}`);
  
  if (failed > 0) {
    console.log(`  - Failed files:`);
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`    - ${r.file}: ${r.error}`);
    });
  }
}