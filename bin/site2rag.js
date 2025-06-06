#!/usr/bin/env node

import { ConfigManager } from '../src/config_manager.js';
import { SiteProcessor } from '../src/site_processor.js';
import { DefaultCrawlState } from '../src/crawl_state.js';
import { CrawlDB } from '../src/db.js';
import fs from 'fs';
import path from 'path';

// Basic CLI arg parsing
const args = process.argv.slice(2);
const hasInit = args.includes('--init');
const domainArg = args.find(arg => !arg.startsWith('--'));
const configPath = 'crawl.json';

const configMgr = new ConfigManager();
const created = configMgr.initConfigFile(configPath);

if (hasInit) {
  if (created) {
    console.log('Created crawl.json with default configuration. Edit this file before running site2rag.');
  } else {
    console.log('crawl.json already exists.');
  }
  process.exit(0);
}

// Always load config from file (now guaranteed to exist)
configMgr.loadFromFile(configPath);
// Optionally merge CLI options here (not shown for brevity)
configMgr.validate();

if (!domainArg) {
  console.error('Usage: npx site2rag <domain> [options]');
  process.exit(1);
}

// Example: run the crawler
const crawlState = new DefaultCrawlState(new CrawlDB('site2rag.sqlite'));
const processor = new SiteProcessor(domainArg, {
  crawlState,
  outputDir: configMgr.config.output,
  limit: configMgr.config.maxPages,
  concurrency: configMgr.config.concurrency,
  politeDelay: configMgr.config.politeDelay
});

processor.process().then(() => {
  console.log('Crawl complete.');
  process.exit(0);
}).catch(e => {
  console.error('Crawl failed:', e);
  process.exit(1);
});

// site2rag CLI entry point
// This file implements the main CLI logic for the site2rag tool.
// For now, we use 'commander' for argument parsing. Add more commands as needed.

import { program } from 'commander';


program
  .name('site2rag')
  .description('A CLI tool for crawling sites and generating AI-friendly markdown.')
  .version('0.1.0');

program
  .argument('[url]', 'The URL to crawl (required unless using --status or --clean)')
  .option('-o, --output <dir>', 'Output directory (default: ./<domain>)')
  .option('--max-depth <num>', 'Maximum crawl depth (default: 3)', '3')
  .option('--limit <num>', 'Limit the number of pages downloaded', null)
  .option('--update', 'Update existing crawl (only changed content)')
  .option('--status', 'Show status for a previous crawl')
  .option('--clean', 'Clean/reset crawl state for the output directory')
  .option('--dry-run', 'Show what would be crawled without downloading')
  .action((url, options) => {
    if (options.status) {
      console.log('Showing crawl status' + (options.output ? ` for ${options.output}` : ''));
      // TODO: Implement status logic
      return;
    }
    if (options.clean) {
      console.log('Cleaning crawl state' + (options.output ? ` for ${options.output}` : ''));
      // TODO: Implement clean logic
      return;
    }
    if (!url) {
      program.help();
      return;
    }
    // Set output default to ./<domain> if not provided
    let outputDir = options.output;
    if (!outputDir && url) {
      try {
        const { hostname } = new URL(/^https?:\/\//.test(url) ? url : 'https://' + url);
        outputDir = `./${hostname}`;
      } catch {
        outputDir = './output';
      }
    }
    if (options.update) {
      console.log(`Updating crawl for ${url} (output: ${options.output})`);
      // TODO: Implement update logic
      return;
    }
    if (options.dryRun) {
      console.log(`[Dry Run] Would crawl: ${url} (output: ${outputDir})`);
      if (options.limit) console.log(`Limit: ${options.limit} pages`);
      // TODO: Implement dry-run logic
      return;
    }
    // Default crawl
    console.log(`Crawling: ${url}`);
    console.log(`Output dir: ${outputDir}`);
    console.log(`Max depth: ${options.maxDepth}`);
    if (options.limit) console.log(`Limit: ${options.limit} pages`);
    // TODO: Implement crawling logic
  });

program.parse(process.argv);

