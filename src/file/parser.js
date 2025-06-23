// parser.js
// Multi-format file parser for site2rag file processing
// Supports markdown, text, rst, adoc, textile formats

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

/**
 * Parse a file into structured content blocks
 * @param {string} filePath - Path to the file to parse
 * @returns {Object} Parsed file data with metadata and blocks
 */
export function parseFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const originalFormat = detectFormat(ext);

  // Parse frontmatter if present
  const parsed = matter(content);
  const metadata = {
    ...parsed.data,
    source_file: filePath,
    original_format: originalFormat,
    file_size: content.length,
    parsed_at: new Date().toISOString()
  };

  // Split content into blocks based on format
  const blocks = splitIntoBlocks(parsed.content, originalFormat);

  return {
    metadata,
    blocks,
    originalFormat,
    rawContent: content
  };
}

/**
 * Detect file format from extension
 * @param {string} ext - File extension (with or without dot)
 * @returns {string} Format name
 */
export function detectFormat(ext) {
  const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;

  const formatMap = {
    md: 'markdown',
    markdown: 'markdown',
    mdoc: 'markdown',
    txt: 'text',
    rst: 'restructuredtext',
    adoc: 'asciidoc',
    textile: 'textile'
  };

  return formatMap[cleanExt.toLowerCase()] || 'text';
}

/**
 * Split content into blocks based on format
 * @param {string} content - File content without frontmatter
 * @param {string} format - Detected format
 * @returns {Array} Array of content blocks
 */
export function splitIntoBlocks(content, format) {
  const blocks = [];

  switch (format) {
    case 'markdown':
      return splitMarkdownBlocks(content);
    case 'restructuredtext':
      return splitRstBlocks(content);
    case 'asciidoc':
      return splitAsciidocBlocks(content);
    case 'textile':
      return splitTextileBlocks(content);
    case 'text':
    default:
      return splitTextBlocks(content);
  }
}

/**
 * Split markdown content into logical blocks
 * @param {string} content - Markdown content
 * @returns {Array} Content blocks
 */
function splitMarkdownBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');
  let currentBlock = '';
  let blockType = 'paragraph';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.match(/^#{1,6}\s/)) {
      // Save previous block
      if (currentBlock.trim()) {
        blocks.push(createBlock(currentBlock.trim(), blockType));
      }
      currentBlock = line;
      blockType = 'header';
    }
    // Code blocks
    else if (line.match(/^```/)) {
      // Save previous block
      if (currentBlock.trim()) {
        blocks.push(createBlock(currentBlock.trim(), blockType));
      }

      // Collect entire code block
      currentBlock = line + '\n';
      i++;
      while (i < lines.length && !lines[i].match(/^```/)) {
        currentBlock += lines[i] + '\n';
        i++;
      }
      if (i < lines.length) {
        currentBlock += lines[i]; // Closing ```
      }

      blocks.push(createBlock(currentBlock.trim(), 'code'));
      currentBlock = '';
      blockType = 'paragraph';
    }
    // Lists
    else if (line.match(/^[\s]*[-*+]\s/) || line.match(/^[\s]*\d+\.\s/)) {
      if (blockType !== 'list') {
        // Save previous block
        if (currentBlock.trim()) {
          blocks.push(createBlock(currentBlock.trim(), blockType));
        }
        currentBlock = line;
        blockType = 'list';
      } else {
        currentBlock += '\n' + line;
      }
    }
    // Empty lines - end current block
    else if (line.trim() === '') {
      if (currentBlock.trim()) {
        blocks.push(createBlock(currentBlock.trim(), blockType));
        currentBlock = '';
        blockType = 'paragraph';
      }
    }
    // Regular content
    else {
      if (currentBlock && blockType !== 'paragraph') {
        // Save previous non-paragraph block
        blocks.push(createBlock(currentBlock.trim(), blockType));
        currentBlock = line;
        blockType = 'paragraph';
      } else {
        currentBlock += (currentBlock ? '\n' : '') + line;
      }
    }
  }

  // Save final block
  if (currentBlock.trim()) {
    blocks.push(createBlock(currentBlock.trim(), blockType));
  }

  return blocks.filter(block => block.text.trim().length > 0);
}

/**
 * Split RestructuredText content into blocks
 * @param {string} content - RST content
 * @returns {Array} Content blocks
 */
function splitRstBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');
  let currentBlock = '';
  let blockType = 'paragraph';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';

    // RST headers (next line is underline)
    if (nextLine && nextLine.match(/^[=\-`':."~^_*+#]{3,}$/)) {
      // Save previous block
      if (currentBlock.trim()) {
        blocks.push(createBlock(currentBlock.trim(), blockType));
      }
      currentBlock = line + '\n' + nextLine;
      blockType = 'header';
      i++; // Skip the underline
    }
    // Code blocks (::)
    else if (line.trim().endsWith('::')) {
      currentBlock += (currentBlock ? '\n' : '') + line;
      // Collect indented code block
      i++;
      while (i < lines.length && (lines[i].startsWith('    ') || lines[i].trim() === '')) {
        currentBlock += '\n' + lines[i];
        i++;
      }
      i--; // Back up one line
      blocks.push(createBlock(currentBlock.trim(), 'code'));
      currentBlock = '';
      blockType = 'paragraph';
    }
    // Empty lines
    else if (line.trim() === '') {
      if (currentBlock.trim()) {
        blocks.push(createBlock(currentBlock.trim(), blockType));
        currentBlock = '';
        blockType = 'paragraph';
      }
    }
    // Regular content
    else {
      currentBlock += (currentBlock ? '\n' : '') + line;
    }
  }

  // Save final block
  if (currentBlock.trim()) {
    blocks.push(createBlock(currentBlock.trim(), blockType));
  }

  return blocks.filter(block => block.text.trim().length > 0);
}

/**
 * Split AsciiDoc content into blocks
 * @param {string} content - AsciiDoc content
 * @returns {Array} Content blocks
 */
function splitAsciidocBlocks(content) {
  // Similar to markdown but with different header syntax
  return splitTextBlocks(content); // Simplified for now
}

/**
 * Split Textile content into blocks
 * @param {string} content - Textile content
 * @returns {Array} Content blocks
 */
function splitTextileBlocks(content) {
  // Simplified implementation
  return splitTextBlocks(content);
}

/**
 * Split plain text into paragraph blocks
 * @param {string} content - Plain text content
 * @returns {Array} Content blocks
 */
function splitTextBlocks(content) {
  const blocks = [];
  const paragraphs = content.split(/\n\s*\n/);

  paragraphs.forEach(paragraph => {
    const trimmed = paragraph.trim();
    if (trimmed) {
      blocks.push(createBlock(trimmed, 'paragraph'));
    }
  });

  return blocks;
}

/**
 * Create a content block object
 * @param {string} text - Block text content
 * @param {string} type - Block type (paragraph, header, code, list)
 * @returns {Object} Content block
 */
function createBlock(text, type = 'paragraph') {
  return {
    text: text,
    type: type,
    word_count: text.split(/\s+/).length,
    char_count: text.length
  };
}

/**
 * Get supported file extensions
 * @returns {Array} Array of supported extensions
 */
export function getSupportedExtensions() {
  return ['.md', '.markdown', '.mdoc', '.txt', '.rst', '.adoc', '.textile'];
}

/**
 * Check if file is supported
 * @param {string} filePath - Path to check
 * @returns {boolean} True if supported
 */
export function isFileSupported(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return getSupportedExtensions().includes(ext);
}
