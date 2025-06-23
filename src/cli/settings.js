// cli_settings.js
// CLI menu for AI/user preferences
import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import {aiServiceAvailable} from '../utils/ai_utils.js';
import logger from '../services/logger_service.js';

const GLOBAL_CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.site2rag', 'config.json');

export async function promptForAISettings() {
  // Try to detect Ollama
  let ollamaAvailable = false;
  try {
    ollamaAvailable = await aiServiceAvailable({provider: 'ollama'});
  } catch {
    // Ollama not available - keep ollamaAvailable as false
  }

  const response = await prompts([
    {
      type: 'select',
      name: 'provider',
      message: 'Choose your preferred AI provider',
      choices: [
        {title: ollamaAvailable ? 'Ollama (local, free, detected)' : 'Ollama (local, free)', value: 'ollama'},
        {title: 'Anthropic Claude (remote, paid)', value: 'anthropic'},
        {title: 'OpenAI GPT (remote, paid)', value: 'gpt'}
      ],
      initial: ollamaAvailable ? 0 : 1
    },
    {
      type: prev => (prev === 'ollama' ? 'text' : null),
      name: 'host',
      message: 'Ollama host URL',
      initial: 'http://localhost:11434'
    },
    {
      type: 'text',
      name: 'model',
      message: 'Model name (e.g., llama3.2:latest, claude-3-opus, gpt-4-turbo)',
      initial: 'llama3.2:latest'
    }
  ]);
  return response;
}

export function saveGlobalAISettings(settings) {
  fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), {recursive: true});
  let config = {};
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
  }
  config.ai = settings;
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function loadGlobalAISettings() {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
    return config.ai || {};
  }
  return {};
}

export async function settingsMenu() {
  const current = loadGlobalAISettings();
  logger.info('Current AI settings:', current);
  const updated = await promptForAISettings();
  saveGlobalAISettings(updated);
  logger.info('Settings updated!');
}
