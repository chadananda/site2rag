/**
 * Debug script to demonstrate cache-optimized disambiguation
 * Compares cache-optimized vs traditional approach
 */

import { extractEntitiesWithSlidingWindow, enhanceBlocksWithCaching, enhanceBlocksWithEntityContext } from '../../src/context.js';
import fs from 'fs';
import path from 'path';

// Create debug output directory
const debugDir = path.join(process.cwd(), 'tests/debug/cache-output');
if (!fs.existsSync(debugDir)) {
  fs.mkdirSync(debugDir, { recursive: true });
}

// Enhanced mock AI that simulates context caching behavior
class CacheAwareDebugAI {
  constructor() {
    this.interactions = [];
    this.contextCache = '';
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  async mockCall(prompt, schema, aiConfig) {
    console.log(`\n=== AI CALL ${this.interactions.length + 1} ===`);
    
    // Simulate cache hit detection
    const isSessionCall = prompt.includes('# DOCUMENT DISAMBIGUATION SESSION');
    const hasContextCache = this.contextCache.length > 0;
    const sharedPrefix = hasContextCache && prompt.startsWith(this.contextCache);
    
    if (sharedPrefix) {
      this.cacheHits++;
      console.log('🟢 CACHE HIT - Reusing cached context');
    } else {
      this.cacheMisses++;
      console.log('🔴 CACHE MISS - Processing full prompt');
    }
    
    // Update cache for session-based calls
    if (isSessionCall) {
      this.contextCache = prompt.substring(0, prompt.indexOf('## Current Block to Enhance') || prompt.length);
    }
    
    console.log(`Cache Stats: ${this.cacheHits} hits, ${this.cacheMisses} misses (${this.getCacheHitRate()}% hit rate)`);
    console.log('PROMPT LENGTH:', prompt.length, 'chars');
    
    // Save full prompt to file
    const promptFile = path.join(debugDir, `cache_prompt_${this.interactions.length + 1}.txt`);
    fs.writeFileSync(promptFile, prompt);
    
    // Mock response based on schema type
    let mockResponse;
    if (schema.description?.includes('EntityExtraction') || prompt.includes('Extract all entities')) {
      mockResponse = this.mockEntityExtraction();
    } else {
      // Enhancement response with improved disambiguation
      const originalText = this.extractOriginalText(prompt);
      mockResponse = {
        contexted_markdown: this.addEnhancedContext(originalText),
        context_summary: 'Applied enhanced disambiguation rules with cache optimization'
      };
    }
    
    this.interactions.push({
      prompt: prompt.substring(0, 300) + '...',
      response: mockResponse,
      timestamp: new Date().toISOString(),
      cacheHit: sharedPrefix,
      promptLength: prompt.length
    });
    
    return mockResponse;
  }
  
  mockEntityExtraction() {
    return {
      people: [
        { name: 'Chad Jones', roles: ['software developer', 'author'], aliases: ['I'], context: 'Author and creator of Ocean search software' }
      ],
      places: [
        { name: 'Haifa', type: 'city', context: 'In Israel, location of Bahá\'í World Center where author learned Unix Grep' },
        { name: 'Israel', type: 'country', context: 'Country where Haifa is located' },
        { name: 'India', type: 'country', context: 'Where author learned Object Pascal through Delphi and distributed Ocean' },
        { name: 'China', type: 'country', context: 'Country visited by author during development period' },
        { name: 'USA', type: 'country', context: 'Where author had conversations with US Publishing Trust head' },
        { name: 'Myanmar', type: 'country', context: 'Burma, destination for Ocean CD distribution by Mr. Shah' }
      ],
      organizations: [
        { name: 'US Publishing Trust', type: 'organization', context: 'Bahá\'í publishing organization with electronic book plans' },
        { name: 'Bahá\'í World Center', type: 'institution', context: 'Place in Haifa where author did youth service and learned Unix Grep' }
      ],
      dates: [
        { date: '1990s', context: 'Era of early internet and Ocean development' }
      ],
      events: [
        { name: 'youth service', location: 'Bahá\'í World Center', context: 'When author learned to use Unix Grep tool' }
      ],
      subjects: ['Ocean search software', 'Bahá\'í literature digitization', 'Unix Grep tool', 'Object Pascal', 'Delphi', 'CD distribution'],
      relationships: [
        { from: 'Chad Jones', relationship: 'did youth service at', to: 'Bahá\'í World Center', context: 'Where Unix Grep was learned' },
        { from: 'Chad Jones', relationship: 'had conversations with head of', to: 'US Publishing Trust', context: 'About electronic book plans' },
        { from: 'Mr. Shah', relationship: 'distributed CDs to', to: 'Myanmar', context: 'Brought Ocean CDs to Bahá\'ís in Burma' }
      ]
    };
  }
  
  extractOriginalText(prompt) {
    const match = prompt.match(/Original text: (\".*?\")/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        // Fallback
      }
    }
    
    // Look for current block
    const blockMatch = prompt.match(/\*\*Current Block:\*\*\n(.*?)(?:\n\n|$)/s);
    if (blockMatch) {
      return blockMatch[1].trim();
    }
    
    return 'Enhanced text with contextual information';
  }
  
  addEnhancedContext(originalText) {
    // Apply enhanced disambiguation rules
    return originalText
      .replace(/\bI\b/g, 'I (Chad Jones, author)')
      .replace(/\bwe\b/g, 'we (at Bahá\'í World Center)')
      .replace(/Publishing Trust/g, 'US Publishing Trust')
      .replace(/\bthey\b/g, 'they (US Publishing Trust)')
      .replace(/\bOcean\b/g, 'Ocean (Bahá\'í literature search software)')
      .replace(/back then/g, 'back then (in the 1990s)')
      .replace(/\bIndia\b/g, 'India (where author learned programming)')
      .replace(/Mr\. Shah/g, 'Mr. Shah (project supporter and Myanmar distributor)')
      .replace(/\bCDs\b/g, 'CDs (Ocean software distribution medium)')
      .replace(/\bUS\b/g, 'United States')
      .replace(/this mailing/g, 'the global CD distribution');
  }
  
  getCacheHitRate() {
    const total = this.cacheHits + this.cacheMisses;
    return total > 0 ? Math.round((this.cacheHits / total) * 100) : 0;
  }
  
  saveInteractions() {
    const interactionsFile = path.join(debugDir, 'cache_interactions.json');
    fs.writeFileSync(interactionsFile, JSON.stringify({
      interactions: this.interactions,
      summary: {
        totalCalls: this.interactions.length,
        cacheHits: this.cacheHits,
        cacheMisses: this.cacheMisses,
        hitRate: this.getCacheHitRate(),
        avgPromptLength: Math.round(this.interactions.reduce((sum, i) => sum + i.promptLength, 0) / this.interactions.length)
      }
    }, null, 2));
    console.log(`\n💾 Saved ${this.interactions.length} AI interactions to ${interactionsFile}`);
  }
}

// Sample content from The Ocean Adventure article  
const sampleBlocks = [
  { text: 'The story of Ocean search begins with a simple desire to bridge the gap between traditional Bahá\'í literature and the burgeoning digital world.' },
  { text: 'My journey began with youth service at the Bahá\'í World Center in Haifa, Israel, where we learned to use the Unix Grep tool to search the core Bahá\'í library.' },
  { text: 'While visiting the USA, I had enlightening conversations with the head of the US Publishing Trust.' },
  { text: 'At the time, they had plans to sell electronic versions of each book, but the emerging popularity of CDs suggested to me a different opportunity.' },
  { text: 'While in India and China, and then India again, I immersed myself in learning Object Pascal through Delphi, an incredible tool for creating Windows applications.' },
  { text: 'When I approached Mr. Shah with the complete version of Ocean, aware of its potential controversy, his encouragement was a beacon.' },
  { text: 'You have to remember that back then, search engines like Google were just beginning.' },
  { text: 'We mailed these globally to Auxiliary Board Members and Counsellors, a massive undertaking considering the era\'s limited internet capabilities.' }
];

const sampleMetadata = {
  title: 'The Ocean Adventure: Making Ocean Search',
  url: 'https://bahai-education.org/the-ocean-adventure',
  description: 'Explore the birth of Ocean 1.0, a digital odyssey transforming Baha\'i literature.'
};

async function runCacheDemo() {
  console.log('🚀 Starting Cache-Optimized Disambiguation Demo\n');
  
  const debugAI = new CacheAwareDebugAI();
  const aiConfig = { provider: 'debug' };
  
  try {
    // PASS 1: Entity Extraction (same as before)
    console.log('📊 PASS 1: Entity Extraction');
    console.log('=' * 40);
    
    const entityGraph = await extractEntitiesWithSlidingWindow(
      sampleBlocks.slice(0, 3), // Smaller sample for demo
      sampleMetadata, 
      aiConfig, 
      debugAI.mockCall.bind(debugAI)
    );
    
    console.log('✅ Entity Graph Created');
    
    // PASS 2A: Traditional Approach (for comparison)
    console.log('\n🔄 PASS 2A: Traditional Enhancement (No Caching)');
    console.log('=' * 50);
    
    const traditionalAI = new CacheAwareDebugAI(); // Fresh AI for comparison
    const traditionalStart = Date.now();
    
    const traditionalResult = await enhanceBlocksWithEntityContext(
      sampleBlocks.slice(0, 4),
      entityGraph,
      aiConfig,
      traditionalAI.mockCall.bind(traditionalAI)
    );
    
    const traditionalDuration = Date.now() - traditionalStart;
    console.log(`⏱️  Traditional approach: ${traditionalDuration}ms`);
    
    // PASS 2B: Cache-Optimized Approach
    console.log('\n⚡ PASS 2B: Cache-Optimized Enhancement');
    console.log('=' * 50);
    
    const cachedStart = Date.now();
    
    const cachedResult = await enhanceBlocksWithCaching(
      sampleBlocks.slice(0, 4),
      entityGraph,
      sampleMetadata,
      aiConfig,
      debugAI.mockCall.bind(debugAI)
    );
    
    console.log(`⏱️  Cache-optimized approach: ${cachedResult.duration}ms`);
    
    // Performance Comparison
    console.log('\n📊 PERFORMANCE COMPARISON');
    console.log('=' * 40);
    console.log(`Traditional calls: ${traditionalAI.interactions.length}`);
    console.log(`Cache-optimized calls: ${debugAI.interactions.length}`);
    console.log(`Speed improvement: ${Math.round((traditionalDuration / cachedResult.duration) * 100) / 100}x`);
    console.log(`Cache hit rate: ${debugAI.getCacheHitRate()}%`);
    
    // Save results
    const comparisonFile = path.join(debugDir, 'cache_comparison.md');
    let comparison = '# Cache-Optimized vs Traditional Disambiguation\\n\\n';
    
    comparison += '## Performance Metrics\\n\\n';
    comparison += `- **Traditional**: ${traditionalDuration}ms, ${traditionalAI.interactions.length} AI calls\\n`;
    comparison += `- **Cache-optimized**: ${cachedResult.duration}ms, ${debugAI.interactions.length} AI calls\\n`;
    comparison += `- **Speed improvement**: ${Math.round((traditionalDuration / cachedResult.duration) * 100) / 100}x faster\\n`;
    comparison += `- **Cache hit rate**: ${debugAI.getCacheHitRate()}%\\n\\n`;
    
    comparison += '## Enhanced Text Comparison\\n\\n';
    
    cachedResult.blocks.forEach((block, i) => {
      comparison += `### Block ${i + 1}\\n\\n`;
      comparison += `**ORIGINAL:**\\n${block.original}\\n\\n`;
      comparison += `**ENHANCED:**\\n${block.contexted}\\n\\n`;
      comparison += '---\\n\\n';
    });
    
    fs.writeFileSync(comparisonFile, comparison);
    console.log(`💾 Comparison saved to ${comparisonFile}`);
    
    // Save AI interactions
    debugAI.saveInteractions();
    traditionalAI.saveInteractions();
    
    console.log('\\n🎉 Cache Demo Completed Successfully!');
    console.log('\\n📁 Debug files created:');
    console.log(`   - ${debugDir}/cache_comparison.md`);
    console.log(`   - ${debugDir}/cache_interactions.json`);
    console.log(`   - ${debugDir}/cache_prompt_*.txt`);
    
  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    debugAI.saveInteractions();
  }
}

// Run the demo
runCacheDemo();