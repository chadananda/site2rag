/**
 * Debug script to demonstrate two-pass entity extraction
 * Captures all prompts, responses, and intermediate results
 */

import { extractEntitiesWithSlidingWindow, enhanceBlocksWithEntityContext } from '../../src/context.js';
import fs from 'fs';
import path from 'path';

// Create debug output directory
const debugDir = path.join(process.cwd(), 'tests/debug/output');
if (!fs.existsSync(debugDir)) {
  fs.mkdirSync(debugDir, { recursive: true });
}

// Mock AI that captures all interactions
class DebugAI {
  constructor() {
    this.interactions = [];
  }

  async mockCall(prompt, schema, aiConfig) {
    console.log(`\n=== AI CALL ${this.interactions.length + 1} ===`);
    console.log('PROMPT:', prompt.substring(0, 200) + '...');
    
    // Save full prompt to file
    const promptFile = path.join(debugDir, `prompt_${this.interactions.length + 1}.txt`);
    fs.writeFileSync(promptFile, prompt);
    
    // Mock response based on schema type
    let mockResponse;
    if (schema.description?.includes('EntityExtraction') || prompt.includes('Extract all entities')) {
      mockResponse = {
        people: [
          { name: 'Chad Jones', roles: [], aliases: ['I'], context: 'Author narrating the Ocean search story' }
        ],
        places: [
          { name: 'Haifa', type: 'city', context: 'In Israel, location of Bahá\'í World Center' },
          { name: 'Israel', type: 'country', context: 'Country where Haifa is located' },
          { name: 'India', type: 'country', context: 'Place where author learned Object Pascal through Delphi' },
          { name: 'China', type: 'country', context: 'Mentioned as place author visited' },
          { name: 'USA', type: 'country', context: 'Where author had conversations with Publishing Trust head' }
        ],
        organizations: [
          { name: 'US Publishing Trust', type: 'organization', context: 'Organization whose head author had conversations with' },
          { name: 'Bahá\'í World Center', type: 'institution', context: 'Place where author did youth service and learned Unix Grep' }
        ],
        dates: [],
        events: [
          { name: 'youth service', location: 'Bahá\'í World Center', context: 'When author learned to use Unix Grep tool' }
        ],
        subjects: ['Ocean search', 'Bahá\'í literature', 'digital world', 'Unix Grep tool', 'Object Pascal', 'Delphi', 'Windows applications'],
        relationships: [
          { from: 'Chad Jones', relationship: 'did youth service at', to: 'Bahá\'í World Center', context: 'Where Unix Grep was learned' },
          { from: 'Chad Jones', relationship: 'had conversations with head of', to: 'US Publishing Trust', context: 'About electronic book plans' }
        ]
      };
    } else {
      // Enhancement response
      const originalText = this.extractOriginalText(prompt);
      mockResponse = {
        contexted_markdown: this.addContextToText(originalText),
        context_summary: 'Added contextual information about people, places, and organizations'
      };
    }
    
    console.log('RESPONSE:', JSON.stringify(mockResponse, null, 2).substring(0, 300) + '...');
    
    this.interactions.push({
      prompt: prompt.substring(0, 500) + '...',
      response: mockResponse,
      timestamp: new Date().toISOString()
    });
    
    return mockResponse;
  }
  
  extractOriginalText(prompt) {
    // Extract the original text from the pre-escaped JSON template
    const match = prompt.match(/The original text is: (".*?")/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        // Fallback if parsing fails
      }
    }
    
    // Fallback: look for simple text patterns
    const lines = prompt.split('\n');
    for (const line of lines) {
      if (line.trim() && !line.startsWith('#') && !line.includes('JSON') && !line.includes('IMPORTANT')) {
        return line.trim();
      }
    }
    
    return 'Enhanced text with contextual information';
  }
  
  addContextToText(originalText) {
    // Conservative enhancement using only document-derived context
    return originalText
      .replace(/\bI\b/g, 'I (Chad Jones)')  // Clarify pronoun with info from document
      .replace(/\bwe\b/g, 'we (at Bahá\'í World Center)')
      .replace(/Publishing Trust/g, 'US Publishing Trust')  // Use full name mentioned in document
      .replace(/\bthey\b/g, 'they (US Publishing Trust)'); // Clarify pronoun reference
  }
  
  saveInteractions() {
    const interactionsFile = path.join(debugDir, 'ai_interactions.json');
    fs.writeFileSync(interactionsFile, JSON.stringify(this.interactions, null, 2));
    console.log(`\n💾 Saved ${this.interactions.length} AI interactions to ${interactionsFile}`);
  }
}

// Sample content from The Ocean Adventure article
const sampleBlocks = [
  { text: 'The story of Ocean search begins with a simple desire to bridge the gap between traditional Bahá\'í literature and the burgeoning digital world.' },
  { text: 'My journey began with youth service at the Bahá\'í World Center in Haifa, Israel, where we learned to use the Unix Grep tool to search the core Bahá\'í library.' },
  { text: 'While visiting the USA, I had enlightening conversations with the head of the US Publishing Trust.' },
  { text: 'At the time, they had plans to sell electronic versions of each book, but the emerging popularity of CDs suggested to me a different opportunity.' },
  { text: 'While in India and China, and then India again, I immersed myself in learning Object Pascal through Delphi, an incredible tool for creating Windows applications.' }
];

const sampleMetadata = {
  title: 'The Ocean Adventure: Making Ocean Search',
  url: 'https://bahai-education.org/the-ocean-adventure',
  description: 'Explore the birth of Ocean 1.0, a digital odyssey transforming Baha\'i literature.'
};

async function runTwoPassDemo() {
  console.log('🚀 Starting Two-Pass Entity Extraction Demo\n');
  
  const debugAI = new DebugAI();
  const aiConfig = { provider: 'debug' };
  
  try {
    // PASS 1: Entity Extraction
    console.log('📊 PASS 1: Entity Extraction with Sliding Windows');
    console.log('=' * 50);
    
    const entityGraph = await extractEntitiesWithSlidingWindow(
      sampleBlocks, 
      sampleMetadata, 
      aiConfig, 
      debugAI.mockCall.bind(debugAI)
    );
    
    console.log('\n✅ Entity Graph Extracted:');
    console.log(`- People: ${entityGraph.people?.length || 0}`);
    console.log(`- Places: ${entityGraph.places?.length || 0}`);
    console.log(`- Organizations: ${entityGraph.organizations?.length || 0}`);
    console.log(`- Subjects: ${entityGraph.subjects?.length || 0}`);
    console.log(`- Relationships: ${entityGraph.relationships?.length || 0}`);
    
    // Save entity graph
    const entityFile = path.join(debugDir, 'entity_graph.json');
    fs.writeFileSync(entityFile, JSON.stringify(entityGraph, null, 2));
    console.log(`💾 Entity graph saved to ${entityFile}`);
    
    // PASS 2: Content Enhancement
    console.log('\n🎯 PASS 2: Content Enhancement with Entity Context');
    console.log('=' * 50);
    
    const enhancedBlocks = await enhanceBlocksWithEntityContext(
      sampleBlocks,
      entityGraph,
      aiConfig,
      debugAI.mockCall.bind(debugAI)
    );
    
    console.log('\n✅ Content Enhancement Completed:');
    console.log(`- Processed blocks: ${enhancedBlocks.length}`);
    
    // Save enhanced content
    const enhancedFile = path.join(debugDir, 'enhanced_content.json');
    fs.writeFileSync(enhancedFile, JSON.stringify(enhancedBlocks, null, 2));
    console.log(`💾 Enhanced content saved to ${enhancedFile}`);
    
    // Create side-by-side comparison
    console.log('\n📝 Before vs After Comparison:');
    console.log('=' * 60);
    
    const comparisonFile = path.join(debugDir, 'before_after_comparison.md');
    let comparison = '# Before vs After Comparison\n\n';
    
    enhancedBlocks.forEach((block, i) => {
      comparison += `## Block ${i + 1}\n\n`;
      comparison += `**BEFORE:**\n${block.original}\n\n`;
      comparison += `**AFTER:**\n${block.contexted}\n\n`;
      comparison += `---\n\n`;
      
      console.log(`Block ${i + 1}:`);
      console.log(`BEFORE: ${block.original.substring(0, 80)}...`);
      console.log(`AFTER:  ${block.contexted.substring(0, 80)}...`);
      console.log('');
    });
    
    fs.writeFileSync(comparisonFile, comparison);
    console.log(`💾 Comparison saved to ${comparisonFile}`);
    
    // Save AI interactions
    debugAI.saveInteractions();
    
    console.log('\n🎉 Two-Pass Demo Completed Successfully!');
    console.log('\n📁 Debug files created:');
    console.log(`   - ${debugDir}/entity_graph.json`);
    console.log(`   - ${debugDir}/enhanced_content.json`);
    console.log(`   - ${debugDir}/before_after_comparison.md`);
    console.log(`   - ${debugDir}/ai_interactions.json`);
    console.log(`   - ${debugDir}/prompt_*.txt (individual prompts)`);
    
  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    debugAI.saveInteractions();
  }
}

// Run the demo
runTwoPassDemo();