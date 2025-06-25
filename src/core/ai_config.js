// ai_config_loader.js
// Loads AI config for content block classification from project and global config files.
import fs from 'fs';
import path from 'path';

const DEFAULT_AI_CONFIG = {
  provider: 'ollama',
  host: 'http://localhost:11434',
  model: 'qwen2.5:14b'
};

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

  let config = {...DEFAULT_AI_CONFIG};

  // Merge global config
  const globalConfig = loadJsonIfExists(globalConfigPath);
  if (globalConfig && globalConfig.ai) {
    config = {...config, ...globalConfig.ai};
  }
  // Merge project config
  const projectConfig = loadJsonIfExists(projectConfigPath);
  if (projectConfig && projectConfig.ai) {
    config = {...config, ...projectConfig.ai};
  }
  // Merge env vars
  if (process.env.AI_PROVIDER) config.provider = process.env.AI_PROVIDER;
  if (process.env.AI_HOST) config.host = process.env.AI_HOST;
  if (process.env.AI_MODEL) config.model = process.env.AI_MODEL;

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
  if (options.use_opus4 || options.useOpus4) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for --use_opus4');
    }
    return {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 30000
    };
  }

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

  if (options.use_gpt4o_mini || options.useGpt4oMini) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required for --use_gpt4o_mini');
    }
    return {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000 // 60s timeout for complex prompts with large context
    };
  }

  if (options.use_gpt4_turbo || options.useGpt4Turbo) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required for --use_gpt4_turbo');
    }
    return {
      provider: 'openai',
      model: 'gpt-4-turbo',
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 45000
    };
  }

  if (options.use_o1_mini || options.useO1Mini) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required for --use_o1_mini');
    }
    return {
      provider: 'openai',
      model: 'o1-mini',
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000 // o1 models are slower
    };
  }

  if (options.use_mistral_large || options.useMistralLarge) {
    if (!process.env.MISTRAL_API_KEY) {
      throw new Error('MISTRAL_API_KEY environment variable is required for --use_mistral_large');
    }
    return {
      provider: 'mistral',
      model: 'mistral-large-latest',
      apiKey: process.env.MISTRAL_API_KEY,
      timeout: 30000
    };
  }

  if (options.use_perplexity || options.usePerplexity) {
    if (!process.env.PERPLEXITY_API_KEY) {
      throw new Error('PERPLEXITY_API_KEY environment variable is required for --use_perplexity');
    }
    return {
      provider: 'perplexity',
      model: 'llama-3.1-sonar-large-128k-online',
      apiKey: process.env.PERPLEXITY_API_KEY,
      timeout: 30000
    };
  }

  if (options.use_r1_grok || options.useR1Grok) {
    if (!process.env.XAI_API_KEY) {
      throw new Error('XAI_API_KEY environment variable is required for --use_r1_grok');
    }
    return {
      provider: 'xai',
      model: 'grok-beta',
      apiKey: process.env.XAI_API_KEY,
      timeout: 30000
    };
  }

  return null; // No LLM flag specified
}

/**
 * Create fallback LLM configuration based on quality ranking and API key availability
 * @param {object} options - CLI options object
 * @returns {object|null} - Fallback config or null if not enabled
 */
export function createFallbackConfig(options) {
  if (!options.autoFallback && !options.auto_fallback) {
    return null; // Fallback not enabled
  }

  // Default fallback order optimized for speed/cost (gpt4o-mini is ideal for context disambiguation)
  const defaultOrder = ['gpt4o-mini', 'gpt4o', 'opus4', 'gpt4-turbo', 'ollama'];

  // Parse custom fallback order if provided
  let fallbackOrder = defaultOrder;
  if (options.fallbackOrder || options.fallback_order) {
    const customOrder = (options.fallbackOrder || options.fallback_order).split(',').map(s => s.trim());
    fallbackOrder = customOrder;
  }

  console.log(`🔄 Auto-fallback enabled, trying: ${fallbackOrder.join(' → ')}`);

  // Create list of available LLMs with their configs
  const availableLLMs = [];

  for (const llm of fallbackOrder) {
    try {
      let config = null;

      switch (llm.toLowerCase()) {
        case 'gpt4o':
          if (process.env.OPENAI_API_KEY) {
            config = {
              provider: 'openai',
              model: 'gpt-4o',
              apiKey: process.env.OPENAI_API_KEY,
              timeout: 60000, // 60s for large context windows
              fallbackName: 'gpt4o'
            };
          }
          break;

        case 'gpt4o-mini':
          if (process.env.OPENAI_API_KEY) {
            config = {
              provider: 'openai',
              model: 'gpt-4o-mini',
              apiKey: process.env.OPENAI_API_KEY,
              timeout: 60000, // 60s for large context windows with gpt4o-mini
              fallbackName: 'gpt4o-mini'
            };
          }
          break;

        case 'opus4':
          if (process.env.ANTHROPIC_API_KEY) {
            config = {
              provider: 'anthropic',
              model: 'claude-3-5-sonnet-20241022',
              apiKey: process.env.ANTHROPIC_API_KEY,
              timeout: 30000,
              fallbackName: 'opus4'
            };
          }
          break;

        case 'gpt4-turbo':
          if (process.env.OPENAI_API_KEY) {
            config = {
              provider: 'openai',
              model: 'gpt-4-turbo',
              apiKey: process.env.OPENAI_API_KEY,
              timeout: 45000,
              fallbackName: 'gpt4-turbo'
            };
          }
          break;

        case 'ollama':
          // Always available (local)
          config = {
            provider: 'ollama',
            host: 'http://localhost:11434',
            model: 'qwen2.5:14b',
            timeout: 20000,
            fallbackName: 'ollama'
          };
          break;
      }

      if (config) {
        availableLLMs.push(config);
        console.log(`  ✅ ${config.fallbackName}: ${config.provider}/${config.model} available`);
      } else {
        console.log(`  ❌ ${llm}: API key missing or invalid`);
      }
    } catch (error) {
      console.log(`  ❌ ${llm}: Configuration error - ${error.message}`);
    }
  }

  if (availableLLMs.length === 0) {
    console.log('⚠️  No LLMs available for fallback');
    return null;
  }

  return {
    type: 'fallback',
    availableLLMs,
    fallbackOrder
  };
}
