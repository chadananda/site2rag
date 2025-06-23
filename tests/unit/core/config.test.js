import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import path from 'path';
import {ConfigManager} from '../../src/config_manager.js';

const TEST_CONFIG = path.resolve('./tests/tmp/test.crawlrc.json');

const SAMPLE_FILE_CONFIG = {
  output: './custom_output',
  concurrency: 2,
  maxPages: 10,
  include: ['foo'],
  markdown: {frontmatter: false}
};

const CLI_OPTIONS = {
  output: './cli_output',
  maxPages: 5,
  newOption: true
};

describe('ConfigManager', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_CONFIG)) fs.unlinkSync(TEST_CONFIG);
  });
  afterEach(() => {
    if (fs.existsSync(TEST_CONFIG)) fs.unlinkSync(TEST_CONFIG);
  });

  it('loads defaults', () => {
    const cm = new ConfigManager();
    expect(cm.loadDefaults()).toHaveProperty('output', './output');
  });

  it('loads and merges from file', () => {
    fs.writeFileSync(TEST_CONFIG, JSON.stringify(SAMPLE_FILE_CONFIG));
    const cm = new ConfigManager();
    cm.loadDefaults();
    cm.loadFromFile(TEST_CONFIG);
    expect(cm.config.output).toBe('./custom_output');
    expect(cm.config.concurrency).toBe(2);
    expect(cm.config.include).toEqual(['foo']);
    expect(cm.config.markdown.frontmatter).toBe(false);
  });

  it('merges CLI options', () => {
    const cm = new ConfigManager();
    cm.loadDefaults();
    cm.mergeWithCli(CLI_OPTIONS);
    expect(cm.config.output).toBe('./cli_output');
    expect(cm.config.maxPages).toBe(5);
    expect(cm.config.newOption).toBe(true);
  });

  it('validates correct config', () => {
    const cm = new ConfigManager();
    cm.loadDefaults();
    expect(() => cm.validate()).not.toThrow();
  });

  it('throws on invalid config', () => {
    const cm = new ConfigManager();
    cm.loadDefaults();
    cm.config.output = 123;
    expect(() => cm.validate()).toThrow('output must be a string');
  });

  it('saves to file', () => {
    const cm = new ConfigManager();
    cm.loadDefaults();
    cm.config.output = './saved_output';
    cm.saveToFile(TEST_CONFIG);
    const loaded = JSON.parse(fs.readFileSync(TEST_CONFIG, 'utf8'));
    expect(loaded.output).toBe('./saved_output');
  });
});
