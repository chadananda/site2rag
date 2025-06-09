import fs from 'fs';
import path from 'path';

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
      await fs.promises.mkdir(dirPath, { recursive: true });
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
   * Gets the full path for a file in the output directory
   * @param {string} domain - Domain name 
   * @param {string} filename - Filename (typically generated from URL path)
   * @param {boolean} createDir - Whether to create the directory if it doesn't exist
   * @returns {string} - Full file path
   */
  getOutputPath(domain, filename, createDir = true) {
    // Ensure the output directory exists
    if (createDir && !fs.existsSync(this.outputDir)) {
      console.log(`Creating output directory: ${this.outputDir}`);
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    
    // Extract directory path from filename if it contains path separators
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
        fs.mkdirSync(fullDirPath, { recursive: true });
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
    const outputPath = this.getOutputPath(domain, filename);
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
   * Saves binary file content to a file in the output directory
   * @param {string} domain - Domain name for subdirectory
   * @param {string} filename - Filename with extension
   * @param {Buffer} data - Binary data to write
   * @returns {Promise<string>} - Full file path
   */
  async saveBinaryFile(domain, filename, data) {
    const outputPath = this.getOutputPath(domain, filename);
    await this.writeBinaryFile(outputPath, data);
    console.log(`Saved binary file to: ${outputPath}`);
    return outputPath;
  }
}
