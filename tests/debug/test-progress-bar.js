#!/usr/bin/env node
// Test script to verify AI request progress bar functionality
import {SiteProcessor} from '../../src/site_processor.js';
import {loadAIConfig} from '../../src/core/ai_config.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Test with a simple URL that will have multiple blocks
const testUrl = 'https://www.example.com';
const outputDir = path.join(__dirname, 'test-progress-output');
// Clean up output directory if it exists
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, {recursive: true, force: true});
}
async function testProgressBar() {
  console.log('Testing AI request progress bar...\n');

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
      limit: 3, // Limit to 3 pages for quick test
      maxDepth: 1,
      outputDir: outputDir,
      aiConfig: aiConfig,
      enhancement: true,
      debug: false
    });

    // Run the crawl and processing
    await processor.process();

    console.log('\nTest completed successfully!');
    console.log(`Output saved to: ${outputDir}`);

    // Check if any enhanced files were created
    const enhancedFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md'));
    console.log(`\nEnhanced ${enhancedFiles.length} markdown files`);
  } catch (error) {
    console.error('Test failed:', error.message);
    process.exit(1);
  }
}
// Run the test
testProgressBar().catch(console.error);
