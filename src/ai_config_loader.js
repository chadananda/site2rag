// ai_config_loader.js
// Loads AI config for content block classification from project and global config files.
import fs from 'fs';
import path from 'path';

const DEFAULT_AI_CONFIG = {
  provider: 'ollama',
  host: 'http://localhost:11434',
  model: 'llama3.2:latest'
};

function loadJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return null;
}

/**
 * Loads AI config, merging (in order of priority):
 *   1. Project config (./.site2rag/crawl.json)
 *   2. Global config (~/.site2rag/config.json)
 *   3. Environment variables
 *   4. Defaults
 * @param {string} projectRoot - Absolute path to the site project root
 * @returns {object} - AI config object
 */
export function loadAIConfig(projectRoot = process.cwd()) {
  const projectConfigPath = path.join(projectRoot, '.site2rag', 'crawl.json');
  const globalConfigPath = path.join(process.env.HOME || process.env.USERPROFILE, '.site2rag', 'config.json');

  let config = { ...DEFAULT_AI_CONFIG };

  // Merge global config
  const globalConfig = loadJsonIfExists(globalConfigPath);
  if (globalConfig && globalConfig.ai) {
    config = { ...config, ...globalConfig.ai };
  }
  // Merge project config
  const projectConfig = loadJsonIfExists(projectConfigPath);
  if (projectConfig && projectConfig.ai) {
    config = { ...config, ...projectConfig.ai };
  }
  // Merge env vars
  if (process.env.AI_PROVIDER) config.provider = process.env.AI_PROVIDER;
  if (process.env.AI_HOST) config.host = process.env.AI_HOST;
  if (process.env.AI_MODEL) config.model = process.env.AI_MODEL;

  return config;
}
