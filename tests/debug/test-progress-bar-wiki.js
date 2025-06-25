#!/usr/bin/env node
// Test script to verify AI request progress bar functionality with Wikipedia
import {SiteProcessor} from '../../src/site_processor.js';
import {loadAIConfig} from '../../src/core/ai_config.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Test with a Wikipedia page that has substantial content
const testUrl = 'https://en.wikipedia.org/wiki/Artificial_intelligence';
const outputDir = path.join(__dirname, 'test-progress-wiki-output');
// Clean up output directory if it exists
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, {recursive: true, force: true});
}
async function testProgressBar() {
  console.log('Testing AI request progress bar with Wikipedia content...\n');

  try {
    // Load AI configuration
    const aiConfig = await loadAIConfig();

    if (!aiConfig || !aiConfig.provider) {
      console.error('No AI configuration found. Please configure an AI provider first.');
      process.exit(1);
    }

    console.log(`Using AI provider: ${aiConfig.provider}/${aiConfig.model}\n`);

    // Create site processor with enhancement enabled
    const processor = new SiteProcessor(testUrl, {
      limit: 2, // Limit to 2 pages
      maxDepth: 0, // Don't follow links
      outputDir: outputDir,
      aiConfig: aiConfig,
      enhancement: true,
      debug: false,
      sameDomain: true
    });

    // Run the crawl and processing
    await processor.process();

    console.log('\nTest completed successfully!');
    console.log(`Output saved to: ${outputDir}`);

    // Check if any enhanced files were created
    const enhancedFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md'));
    console.log(`\nEnhanced ${enhancedFiles.length} markdown files`);

    // Show a sample of the first enhanced file
    if (enhancedFiles.length > 0) {
      const firstFile = path.join(outputDir, enhancedFiles[0]);
      const content = fs.readFileSync(firstFile, 'utf8');
      const insertions = (content.match(/\[\[.*?\]\]/g) || []).length;
      console.log(`\nFirst file has ${insertions} context insertions`);

      // Show first few insertions
      const firstInsertions = (content.match(/\[\[.*?\]\]/g) || []).slice(0, 3);
      if (firstInsertions.length > 0) {
        console.log('\nSample insertions:');
        firstInsertions.forEach(ins => console.log(`  - ${ins}`));
      }
    }
  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}
// Run the test
testProgressBar().catch(console.error);
