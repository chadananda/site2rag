// ai_config_loader.js
// Loads AI config for content block classification from project and global config files.
import fs from 'fs';
import path from 'path';

// No default AI processing - config must be explicitly provided

function loadJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    // File doesn't exist or isn't readable - return null
  }
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

  // Start with null config (no AI processing by default)
  let config = null;

  // Check global config
  const globalConfig = loadJsonIfExists(globalConfigPath);
  if (globalConfig && globalConfig.ai) {
    config = {...globalConfig.ai};
  }
  
  // Check project config (overrides global)
  const projectConfig = loadJsonIfExists(projectConfigPath);
  if (projectConfig && projectConfig.ai) {
    config = {...(config || {}), ...projectConfig.ai};
  }
  
  // Check env vars (highest priority)
  if (process.env.AI_PROVIDER || process.env.AI_MODEL) {
    config = config || {};
    if (process.env.AI_PROVIDER) config.provider = process.env.AI_PROVIDER;
    if (process.env.AI_HOST) config.host = process.env.AI_HOST;
    if (process.env.AI_MODEL) config.model = process.env.AI_MODEL;
  }

  // If we have a config, add API keys
  if (config) {
    if (config.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      config.apiKey = process.env.ANTHROPIC_API_KEY;
    } else if (config.provider === 'openai' && process.env.OPENAI_API_KEY) {
      config.apiKey = process.env.OPENAI_API_KEY;
    }
    
    // Set default timeout if not specified
    if (!config.timeout) {
      config.timeout = 20000;
    }
  }

  return config;
}

/**
 * Map CLI LLM flags to AI config
 * @param {object} options - CLI options object
 * @returns {object|null} - AI config for the specified LLM or null if no flag
 */
export function getLLMConfigFromFlags(options) {
  // Check for LLM-specific flags and validate API keys
  // Commander.js uses underscore format, not camelCase
  if (options.use_haiku || options.useHaiku) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for --use_haiku');
    }
    return {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 20000
    };
  }

  if (options.use_gpt4o || options.useGpt4o) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required for --use_gpt4o');
    }
    return {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000
    };
  }

  if (options.use_ollama || options.useOllama) {
    // Ollama runs locally, no API key needed
    return {
      provider: 'ollama',
      host: 'http://localhost:11434',
      model: 'qwen2.5:14b',
      timeout: 20000
    };
  }

  return null; // No LLM flag specified
}

