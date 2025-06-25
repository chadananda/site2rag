#!/usr/bin/env node
// Test script to verify AI request progress bar with local file
import {SiteProcessor} from '../../src/site_processor.js';
import {loadAIConfig} from '../../src/core/ai_config.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Test with local HTML file
const testFile = path.join(__dirname, 'test-content.html');
const testUrl = `file://${testFile}`;
const outputDir = path.join(__dirname, 'test-progress-local-output');
// Clean up output directory if it exists
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, {recursive: true, force: true});
}
async function testProgressBar() {
  console.log('Testing AI request progress bar with local content...\n');

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
      limit: 1, // Just process the single file
      maxDepth: 0,
      outputDir: outputDir,
      aiConfig: aiConfig,
      enhancement: true,
      debug: true // Enable debug to see more details
    });

    // Run the crawl and processing
    await processor.process();

    console.log('\nTest completed successfully!');
    console.log(`Output saved to: ${outputDir}`);

    // Check if any enhanced files were created
    const files = fs.readdirSync(outputDir);
    const enhancedFiles = files.filter(f => f.endsWith('.md'));
    console.log(`\nFound ${enhancedFiles.length} markdown files`);

    // Show enhancement results
    if (enhancedFiles.length > 0) {
      const firstFile = path.join(outputDir, enhancedFiles[0]);
      const content = fs.readFileSync(firstFile, 'utf8');
      const insertions = (content.match(/\[\[.*?\]\]/g) || []).length;
      console.log(`\nEnhancement results:`);
      console.log(`- Total context insertions: ${insertions}`);

      // Show first few insertions
      const firstInsertions = (content.match(/\[\[.*?\]\]/g) || []).slice(0, 5);
      if (firstInsertions.length > 0) {
        console.log('\nSample context insertions:');
        firstInsertions.forEach(ins => console.log(`  ${ins}`));
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
