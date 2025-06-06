#!/usr/bin/env node

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

