import fs from 'fs';
import path from 'path';
import logger from './logger_service.js';

/**
 * Service for file system operations
 */
export class FileService {
  /**
   * Creates a new FileService instance
   * @param {Object} options - Configuration options
   * @param {string} options.outputDir - Base output directory (default: './output')
   */
  constructor(options = {}) {
    this.outputDir = options.outputDir || './output';
    this.flat = options.flat || false;
  }

  /**
   * Ensures a directory exists, creating it if necessary
   * @param {string} dirPath - Directory path
   * @returns {Promise<void>}
   */
  async ensureDir(dirPath) {
    try {
      await fs.promises.access(dirPath);
    } catch (e) {
      await fs.promises.mkdir(dirPath, {recursive: true});
    }
  }

  /**
   * Writes content to a file, creating directories as needed
   * @param {string} filePath - File path
   * @param {string} content - Content to write
   * @returns {Promise<void>}
   */
  async writeFile(filePath, content) {
    const dirPath = path.dirname(filePath);
    await this.ensureDir(dirPath);
    await fs.promises.writeFile(filePath, content, 'utf8');
  }

  /**
   * Reads content from a file
   * @param {string} filePath - File path
   * @param {string} defaultValue - Default value if file doesn't exist
   * @returns {Promise<string>} - File content
   */
  async readFile(filePath, defaultValue = '') {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
      return defaultValue;
    }
  }

  /**
   * Saves debug information about removed blocks to a parallel file
   * @param {string} originalFilePath - Path to the original content file
   * @param {Array} removedBlocks - Array of removed block objects
   * @returns {Promise<string>} - Path to the debug file
   */
  async saveRemovedBlocksDebug(originalFilePath, removedBlocks) {
    if (!removedBlocks || removedBlocks.length === 0) {
      return null;
    }

    // Create a debug file path with _deleted.md suffix
    const parsedPath = path.parse(originalFilePath);
    const debugFilePath = path.join(parsedPath.dir, `${parsedPath.name}_deleted${parsedPath.ext}`);

    // Format the debug content
    let debugContent = `# Removed Blocks Debug Information

This file contains HTML blocks that were removed during content processing.

`;

    // Add each removed block with its reason
    removedBlocks.forEach((block, index) => {
      debugContent += `## Block ${index + 1}: ${block.source}

`;
      debugContent += '```html\n';
      debugContent += block.content;
      debugContent += '\n```\n\n';
    });

    // Write the debug file
    await this.writeFile(debugFilePath, debugContent);
    logger.info(`[DEBUG] Saved removed blocks to ${debugFilePath}`);
    return debugFilePath;
  }

  /**
   * Checks if a file exists
   * @param {string} filePath - File path
   * @returns {Promise<boolean>} - Whether the file exists
   */
  async fileExists(filePath) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Generates a flat filename from a URL path for --flat mode
   * @param {string} urlPath - URL path like '/docs/api/auth'
   * @returns {string} - Flat filename like 'docs_api_auth.md'
   */
  generateFlatFilename(urlPath) {
    // Remove leading slash and convert remaining slashes to underscores
    const cleanPath = urlPath.replace(/^\/+/, '').replace(/\/+/g, '_');
    // Handle root path
    if (!cleanPath || cleanPath === '_') {
      return 'index.md';
    }
    // Add .md extension if not present
    return cleanPath.endsWith('.md') ? cleanPath : `${cleanPath}.md`;
  }

  /**
   * Gets the full path for a file in the output directory
   * @param {string} domain - Domain name
   * @param {string} filename - Filename (typically generated from URL path)
   * @param {boolean} createDir - Whether to create the directory if it doesn't exist
   * @returns {string} - Full file path
   */
  getOutputPath(domain, filename, createDir = true) {
    // Ensure the output directory exists
    if (createDir && !fs.existsSync(this.outputDir)) {
      logger.info(`Creating output directory: ${this.outputDir}`);
      fs.mkdirSync(this.outputDir, {recursive: true});
    }

    if (this.flat) {
      // Flat mode: all files in top-level directory with path-derived names
      return path.join(this.outputDir, this.generateFlatFilename(filename));
    }

    // Hierarchical mode: preserve directory structure
    let outputPath;
    if (filename.includes('/')) {
      // Split the filename into directory path and actual filename
      const lastSlashIndex = filename.lastIndexOf('/');
      const dirPath = filename.substring(0, lastSlashIndex);
      const actualFilename = filename.substring(lastSlashIndex + 1);

      // Create the full directory path
      const fullDirPath = path.join(this.outputDir, dirPath);

      // Create the directory if it doesn't exist
      if (createDir && !fs.existsSync(fullDirPath)) {
        fs.mkdirSync(fullDirPath, {recursive: true});
      }

      outputPath = path.join(this.outputDir, dirPath, actualFilename);
    } else {
      // No path separators, just use the filename directly
      outputPath = path.join(this.outputDir, filename);
    }

    return outputPath;
  }

  /**
   * Saves markdown content to a file in the output directory
   * @param {string} domain - Domain name for subdirectory
   * @param {string} filename - Filename
   * @param {string} content - Markdown content
   * @returns {Promise<string>} - Full file path
   */
  async saveMarkdown(domain, filename, content) {
    let outputPath;
    if (this.flat) {
      // In flat mode, ignore domain and use flat filename generation
      outputPath = this.getOutputPath('', filename);
    } else {
      // In hierarchical mode, save directly to output directory without extra domain subfolder
      // The output directory is already domain-specific when provided by the user
      outputPath = this.getOutputPath('', filename);
    }
    await this.writeFile(outputPath, content);
    return outputPath;
  }

  /**
   * Reads a file and parses it as JSON
   * @param {string} filePath - Path to the file
   * @param {Object} defaultValue - Default value if file doesn't exist
   * @returns {Promise<Object>} - Parsed JSON data
   */
  async readJson(filePath, defaultValue = {}) {
    try {
      const content = await this.readFile(filePath);
      return JSON.parse(content);
    } catch (e) {
      return defaultValue;
    }
  }

  /**
   * Writes JSON data to a file
   * @param {string} filePath - Path to the file
   * @param {Object} data - Data to write
   * @returns {Promise<void>}
   */
  async writeJson(filePath, data) {
    const content = JSON.stringify(data, null, 2);
    await this.writeFile(filePath, content);
  }

  /**
   * Writes binary data to a file, creating directories as needed
   * @param {string} filePath - File path
   * @param {Buffer} data - Binary data to write
   * @returns {Promise<void>}
   */
  async writeBinaryFile(filePath, data) {
    const dirPath = path.dirname(filePath);
    await this.ensureDir(dirPath);
    await fs.promises.writeFile(filePath, data);
  }

  /**
   * Downloads and saves a document file (PDF, DOCX, etc.) to the output directory
   * @param {string} url - URL of the document to download
   * @param {string} baseUrl - Base URL for resolving relative URLs
   * @param {string} hostname - Hostname for organizing files
   * @returns {Promise<Object>} - Object with relative path and full path
   */
  async downloadDocument(url, baseUrl, hostname) {
    try {
      logger.info(`[DOCUMENT] Downloading document from ${url}`);

      // Resolve URL if it's relative
      let absoluteUrl = url;
      if (!url.startsWith('http') && !url.startsWith('//')) {
        try {
          absoluteUrl = new URL(url, baseUrl).href;
        } catch (error) {
          logger.warn(`[DOCUMENT] Error resolving URL: ${url}`, error);
          return {success: false, error: 'Invalid URL'};
        }
      }

      // Fetch the document
      const response = await fetch(absoluteUrl);
      if (!response.ok) {
        logger.warn(`[DOCUMENT] Failed to download document: ${response.status} ${response.statusText}`);
        return {success: false, error: `HTTP error: ${response.status}`};
      }

      // Get the document data as buffer
      const documentData = await response.arrayBuffer();
      const buffer = Buffer.from(documentData);

      // Extract filename from URL or use a hash
      const urlObj = new URL(absoluteUrl);
      let filename = path.basename(urlObj.pathname);

      // If filename is empty or doesn't have an extension, generate one
      if (!filename || !path.extname(filename)) {
        const contentType = response.headers.get('content-type');
        let extension = '.bin';

        if (contentType) {
          if (contentType.includes('pdf')) extension = '.pdf';
          else if (contentType.includes('word') || contentType.includes('docx')) extension = '.docx';
          else if (contentType.includes('excel') || contentType.includes('xlsx')) extension = '.xlsx';
          else if (contentType.includes('powerpoint') || contentType.includes('pptx')) extension = '.pptx';
        }

        // Use URL path as filename or fallback to a timestamp
        const pathParts = urlObj.pathname.split('/');
        const lastPathPart = pathParts[pathParts.length - 1];
        filename = lastPathPart || `document-${Date.now()}${extension}`;
      }

      // Create documents directory within the hostname directory
      const documentsDir = path.join(hostname, 'documents');
      const outputPath = this.getOutputPath(documentsDir, filename);

      // Save the document
      await this.writeBinaryFile(outputPath, buffer);

      // Calculate the relative path from the hostname directory
      const relativePath = path.join('documents', filename);

      logger.info(`[DOCUMENT] Saved document to ${outputPath}`);
      return {
        success: true,
        relativePath,
        fullPath: outputPath,
        filename
      };
    } catch (error) {
      logger.error(`[DOCUMENT] Error downloading document: ${error.message}`);
      return {success: false, error: error.message};
    }
  }

  /**
   * Saves binary file content to a file in the output directory
   * @param {Buffer} data - Binary data to write
   * @param {string} domain - Domain name for subdirectory
   * @param {string} filename - Filename with extension
   * @returns {Promise<string>} - Full file path
   */
  async saveBinaryFile(data, domain, filename) {
    let outputPath;
    if (this.flat) {
      // In flat mode, ignore domain and use flat filename generation
      outputPath = this.getOutputPath('', filename);
    } else {
      // In hierarchical mode, save directly to output directory without extra domain subfolder
      // The output directory is already domain-specific when provided by the user
      outputPath = this.getOutputPath('', filename);
    }
    await this.writeBinaryFile(outputPath, data);
    logger.info(`Saved binary file to: ${outputPath}`);
    return outputPath;
  }
}
