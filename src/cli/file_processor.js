// file_processor.js
// File processing orchestration for site2rag
// Coordinates parsing, enhancement, and output

import fs from 'fs';
import path from 'path';
import {parseFile, isFileSupported} from '../file/parser.js';
import {enhanceDocumentSimple} from '../core/context_processor_simple.js';
import {loadAIConfig} from '../core/ai_config.js';
import logger from '../services/logger_service.js';

/**
 * Process a file with context enhancement
 * @param {string} filePath - Path to the file to process
 * @param {Object} options - CLI options
 * @returns {Promise<void>}
 */
export async function processFile(filePath, options) {
  logger.info(`Processing: ${filePath}`);

  // Validate file
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!isFileSupported(filePath)) {
    throw new Error(`Unsupported file format: ${path.extname(filePath)}`);
  }

  try {
    // Parse the file
    logger.info(`Parsing file...`);
    const parsed = parseFile(filePath);

    // Load AI configuration
    const aiConfig = await loadAIConfig();

    // Knowledge graph extraction has been removed - focusing on context disambiguation only

    // Determine output path
    const outputPath = determineOutputPath(filePath, options.output);

    if (options.noEnhancement || options.enhancement === false) {
      logger.info(`No enhancement requested - outputting original content`);
      const originalContent = generateOriginalOutput(parsed);
      fs.writeFileSync(outputPath, originalContent, 'utf8');
      logger.info(`Original content saved to: ${outputPath}`);
      return;
    }

    // Skip entity extraction - focus on context disambiguation only
    logger.debug(`Skipping entity extraction - using context-only enhancement...`);

    // Enhance content with context
    logger.info(`Enhancing content with context...`);
    const enhancedBlocks = await enhanceContent(parsed.blocks, parsed.metadata, aiConfig, options);

    // Generate enhanced output
    logger.debug(`Generating enhanced output...`);
    const enhancedContent = generateEnhancedOutput(parsed, enhancedBlocks, options);

    // Write output file
    fs.writeFileSync(outputPath, enhancedContent, 'utf8');
    logger.info(`Enhanced file saved to: ${outputPath}`);

    // Output statistics
    const originalWordCount = parsed.blocks.reduce((sum, block) => sum + block.word_count, 0);
    const enhancedWordCount = enhancedBlocks.reduce(
      (sum, block) => sum + (block.contexted?.split(/\s+/).length || block.original.split(/\s+/).length),
      0
    );
    const improvement = enhancedWordCount - originalWordCount;

    logger.info(`Processing complete:`);
    logger.info(`  - Original blocks: ${parsed.blocks.length}`);
    logger.info(`  - Original word count: ${originalWordCount}`);
    logger.info(`  - Enhanced word count: ${enhancedWordCount} (+${improvement}`);
    logger.info(`  - Enhancement improvement: ${((improvement / originalWordCount) * 100).toFixed(1)}%`);
  } catch (error) {
    logger.error(`Processing failed: ${error.message}`);
    throw error;
  }
}

/**
 * Generate original output content without enhancement
 * @param {Object} parsed - Parsed file data
 * @returns {string} Original content
 */
function generateOriginalOutput(parsed) {
  const lines = [];

  // Add original frontmatter if present
  if (Object.keys(parsed.metadata).length > 2) {
    // More than just source_file and parsed_at
    lines.push('---');
    Object.entries(parsed.metadata).forEach(([key, value]) => {
      if (typeof value === 'object') {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    });
    lines.push('---');
    lines.push('');
  }

  // Add original content blocks
  parsed.blocks.forEach((block, index) => {
    lines.push(block.text || block.content || block.original);

    // Add spacing between blocks (except last)
    if (index < parsed.blocks.length - 1) {
      lines.push('');
    }
  });

  return lines.join('\n');
}

/**
 * Enhance content blocks with context-only disambiguation
 * @param {Array} blocks - Content blocks to enhance
 * @param {Object} metadata - Document metadata
 * @param {Object} aiConfig - AI configuration
 * @param {Object} options - CLI options
 * @returns {Promise<Array>} Enhanced blocks
 */
async function enhanceContent(blocks, metadata, aiConfig, options) {
  logger.info(`Using simplified context enhancement...`);
  // Convert blocks to simple array format
  const blockTexts = blocks.map(b => b.text || b.content || b.original || b);
  
  // Use the simple processor
  const enhancedTexts = await enhanceDocumentSimple(blockTexts, metadata, aiConfig, {
    onProgress: null
  });
  
  // Convert back to expected format
  return enhancedTexts.map((text, index) => ({
    original: blocks[index].text || blocks[index].content || blocks[index].original || blocks[index],
    contexted: text
  }));
}

/**
 * Determine output file path
 * @param {string} inputPath - Input file path
 * @param {string|undefined} outputOption - CLI output option
 * @returns {string} Output file path
 */
function determineOutputPath(inputPath, outputOption) {
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
 * @param {Object} options - CLI options
 * @returns {string} Enhanced content
 */
function generateEnhancedOutput(parsed, enhancedBlocks, options) {
  const lines = [];

  // Add enhanced frontmatter
  const enhancedMetadata = {
    ...parsed.metadata,
    enhanced_at: new Date().toISOString(),
    enhancement_method: 'context-optimized',
    word_count_improvement: calculateWordCountImprovement(parsed.blocks, enhancedBlocks)
  };

  // Add frontmatter if original had it or if we're adding metadata
  if (Object.keys(parsed.metadata).length > 2 || options.addMetadata) {
    // More than just source_file and parsed_at
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
    percentage: (((enhancedWords - originalWords) / originalWords) * 100).toFixed(1)
  };
}

/**
 * Process multiple files in batch
 * @param {Array<string>} filePaths - Array of file paths
 * @param {Object} options - CLI options
 * @returns {Promise<void>}
 */
export async function processFiles(filePaths, options) {
  logger.info(`Batch processing ${filePaths.length} files`);

  const results = [];

  for (const filePath of filePaths) {
    try {
      await processFile(filePath, options);
      results.push({file: filePath, status: 'success'});
    } catch (error) {
      logger.error(`Failed to process ${filePath}: ${error.message}`);
      results.push({file: filePath, status: 'failed', error: error.message});
    }
  }

  // Summary
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;

  logger.info(`Batch processing complete:`);
  logger.info(`  - Successful: ${successful}`);
  logger.info(`  - Failed: ${failed}`);

  if (failed > 0) {
    logger.info(`  - Failed files:`);
    results
      .filter(r => r.status === 'failed')
      .forEach(r => {
        logger.info(`    - ${r.file}: ${r.error}`);
      });
  }
}
