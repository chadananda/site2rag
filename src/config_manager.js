import fs from 'fs';
import path from 'path';
import logger from './services/logger_service.js';

const DEFAULT_CONFIG = {
  output: './output',
  concurrency: 4,
  maxPages: 100,
  maxDepth: 5,
  include: [],
  exclude: [],
  crawlPatterns: ['/*'],
  politeDelay: 300,
  userAgent: 'site2rag-crawler/1.0',
  markdown: {
    frontmatter: true,
    contentDensity: 0.2
  }
};

export class ConfigManager {
  constructor() {
    this.config = {...DEFAULT_CONFIG};
  }

  loadDefaults() {
    this.config = {...DEFAULT_CONFIG};
    return this.config;
  }

  loadFromFile(configPath = 'crawl.json') {
    if (fs.existsSync(configPath)) {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      this.config = {...this.config, ...fileConfig};
    }
    return this.config;
  }

  mergeWithCli(cliOptions = {}) {
    // Merge CLI options (flat structure)
    this.config = {...this.config, ...cliOptions};
    return this.config;
  }

  validate() {
    // Example: check required fields and types
    if (typeof this.config.output !== 'string') throw new Error('output must be a string');
    if (typeof this.config.concurrency !== 'number') throw new Error('concurrency must be a number');
    if (typeof this.config.maxPages !== 'number') throw new Error('maxPages must be a number');
    if (typeof this.config.maxDepth !== 'number') throw new Error('maxDepth must be a number');
    if (!Array.isArray(this.config.include)) throw new Error('include must be an array');
    if (!Array.isArray(this.config.exclude)) throw new Error('exclude must be an array');
    if (typeof this.config.politeDelay !== 'number') throw new Error('politeDelay must be a number');
    if (typeof this.config.userAgent !== 'string') throw new Error('userAgent must be a string');
    if (typeof this.config.markdown !== 'object') throw new Error('markdown must be an object');
    return true;
  }

  saveToFile(configPath = 'crawl.json') {
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
  }

  static exists(configPath = 'crawl.json') {
    return fs.existsSync(configPath);
  }

  /**
   * Writes a config file with all defaults if it does not exist.
   * Returns true if created, false if already existed.
   */
  initConfigFile(configPath = 'crawl.json') {
    if (!fs.existsSync(configPath)) {
      // Ensure the directory exists
      const dirPath = path.dirname(configPath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, {recursive: true});
        logger.info(`Created directory: ${dirPath}`);
      }

      // Write the config file
      fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
      logger.info(`Created config file: ${configPath}`);
      return true;
    }
    return false;
  }
}
