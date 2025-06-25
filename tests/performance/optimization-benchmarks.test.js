import {describe, it, expect} from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  extractEntitiesWithSlidingWindow,
  enhanceBlocksWithEntityContext,
  enhanceBlocksWithCaching
} from '../../src/context.js';

const PERF_OUTPUT_DIR = path.join(process.cwd(), 'tests', 'tmp', 'performance');

// Realistic Mock AI that simulates processing times and caching behavior
class RealisticMockAI {
  constructor(name, baseDelay = 100) {
    this.name = name;
    this.baseDelay = baseDelay;
    this.callCount = 0;
    this.totalTime = 0;
    this.cache = new Map();
  }
  async mockCall(prompt) {
    this.callCount++;
    const start = Date.now();
    const promptPrefix = prompt.substring(0, 1000);
    const isCacheHit = this.cache.has(promptPrefix);
    if (isCacheHit) {
      await this.delay(this.baseDelay * 0.2);
    } else {
      await this.delay(this.baseDelay + prompt.length / 100);
      this.cache.set(promptPrefix, true);
    }
    const duration = Date.now() - start;
    this.totalTime += duration;
    if (prompt.includes('Extract all entities')) {
      return this.mockEntityResponse();
    } else {
      return this.mockEnhancementResponse(prompt);
    }
  }
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  mockEntityResponse() {
    return {
      people: [{name: 'Test Person', roles: ['author'], context: 'Creator context'}],
      places: [{name: 'Test Location', type: 'location', context: 'Geographic context'}],
      organizations: [{name: 'Test Organization', type: 'organization', context: 'Business context'}],
      dates: [],
      events: [],
      subjects: ['performance testing', 'optimization', 'AI processing'],
      relationships: []
    };
  }
  mockEnhancementResponse(prompt) {
    const originalMatch = prompt.match(/Original text: (".*?")/);
    let originalText = 'Enhanced text';
    if (originalMatch) {
      try {
        originalText = JSON.parse(originalMatch[1]);
      } catch {
        // Use fallback
      }
    }
    const enhanced = originalText
      .replace(/\\bAI\\b/g, 'AI (Artificial Intelligence)')
      .replace(/\\btesting\\b/g, 'testing (quality assurance)')
      .replace(/\\boptimization\\b/g, 'optimization (performance improvement)');
    return {
      contexted_markdown: enhanced,
      context_summary: 'Applied performance disambiguation rules'
    };
  }
  getStats() {
    return {
      name: this.name,
      calls: this.callCount,
      totalTime: this.totalTime,
      avgTime: this.callCount > 0 ? Math.round(this.totalTime / this.callCount) : 0,
      cacheHits: Array.from(this.cache.keys()).length
    };
  }
}

// Realistic test content for benchmarking
const benchmarkBlocks = [
  {
    text: 'Performance optimization is crucial for modern web applications, requiring careful analysis of bottlenecks and systematic improvements.'
  },
  {
    text: 'Caching strategies can dramatically reduce processing time by storing frequently accessed data in memory or persistent storage.'
  },
  {
    text: 'AI-powered content enhancement involves entity extraction, context disambiguation, and intelligent text processing workflows.'
  },
  {
    text: 'Integration testing ensures that optimization changes maintain system reliability while improving performance metrics.'
  },
  {
    text: 'Benchmarking tools help developers measure the impact of performance improvements across different system configurations.'
  },
  {
    text: 'Caching strategies can dramatically reduce processing time by storing frequently accessed data in memory or persistent storage.'
  } // Duplicate to test caching
];

const benchmarkMetadata = {
  title: 'Performance Optimization Guide',
  url: 'https://example.com/performance-guide',
  description: 'Comprehensive guide to system performance optimization techniques'
};

describe('Performance: Optimization Benchmarks', () => {
  it('benchmarks traditional vs cache-optimized processing', async () => {
    console.log('🚀 Performance Benchmark: Traditional vs Cache-Optimized\\n');
    if (!fs.existsSync(PERF_OUTPUT_DIR)) {
      fs.mkdirSync(PERF_OUTPUT_DIR, {recursive: true});
    }
    // Traditional approach benchmark
    console.log('📊 Traditional Approach (No Caching)');
    const traditionalAI = new RealisticMockAI('Traditional', 150);
    const traditionalStart = Date.now();
    const entityGraph = await extractEntitiesWithSlidingWindow(
      benchmarkBlocks.slice(0, 3),
      benchmarkMetadata,
      {provider: 'mock'},
      traditionalAI.mockCall.bind(traditionalAI)
    );
    await enhanceBlocksWithEntityContext(
      benchmarkBlocks,
      entityGraph,
      {provider: 'mock'},
      traditionalAI.mockCall.bind(traditionalAI)
    );
    const traditionalDuration = Date.now() - traditionalStart;
    const traditionalStats = traditionalAI.getStats();
    // Cache-optimized approach benchmark
    console.log('\\n⚡ Cache-Optimized Approach');
    const cachedAI = new RealisticMockAI('Cache-Opt', 150);
    const cachedEntityGraph = await extractEntitiesWithSlidingWindow(
      benchmarkBlocks.slice(0, 3),
      benchmarkMetadata,
      {provider: 'mock'},
      cachedAI.mockCall.bind(cachedAI)
    );
    const cachedResult = await enhanceBlocksWithCaching(
      benchmarkBlocks,
      cachedEntityGraph,
      benchmarkMetadata,
      {provider: 'mock'},
      cachedAI.mockCall.bind(cachedAI)
    );
    const cachedStats = cachedAI.getStats();
    // Performance comparison
    const speedImprovement = traditionalDuration / cachedResult.duration;
    const callReduction = Math.round((1 - cachedStats.calls / traditionalStats.calls) * 100);
    const efficiencyGain = Math.round(((traditionalDuration - cachedResult.duration) / traditionalDuration) * 100);
    console.log('\\n📈 PERFORMANCE COMPARISON');
    console.log(`Traditional:     ${traditionalDuration}ms (${traditionalStats.calls} calls)`);
    console.log(`Cache-optimized: ${cachedResult.duration}ms (${cachedStats.calls} calls)`);
    console.log(`Speed improvement: ${speedImprovement.toFixed(1)}x faster`);
    console.log(`Call reduction: ${callReduction}%`);
    console.log(`Efficiency gain: ${efficiencyGain}%`);
    // Performance expectations
    expect(cachedResult.duration).toBeLessThan(traditionalDuration);
    expect(cachedStats.calls).toBeLessThanOrEqual(traditionalStats.calls);
    expect(speedImprovement).toBeGreaterThan(1);
    // Save benchmark results
    const perfResults = {
      testConfig: {
        blockCount: benchmarkBlocks.length,
        baseDelay: '150ms',
        testDate: new Date().toISOString()
      },
      traditional: {
        duration: traditionalDuration,
        calls: traditionalStats.calls,
        avgCallTime: traditionalStats.avgTime
      },
      cacheOptimized: {
        duration: cachedResult.duration,
        calls: cachedStats.calls,
        avgCallTime: cachedStats.avgTime
      },
      improvements: {
        speedMultiplier: Math.round(speedImprovement * 10) / 10,
        callReduction,
        efficiencyGain
      }
    };
    const perfFile = path.join(PERF_OUTPUT_DIR, 'benchmark_results.json');
    fs.writeFileSync(perfFile, JSON.stringify(perfResults, null, 2));
    console.log(`\\n💾 Benchmark results saved to ${perfFile}`);
  }, 60000);

  it('measures two-pass entity extraction performance', async () => {
    console.log('Starting two-pass entity extraction benchmark');
    if (!fs.existsSync(PERF_OUTPUT_DIR)) {
      fs.mkdirSync(PERF_OUTPUT_DIR, {recursive: true});
    }
    const mockAI = new RealisticMockAI('TwoPass', 120);
    const testBlocks = benchmarkBlocks.slice(0, 4); // Use subset for faster testing
    const start = Date.now();
    // First pass: Extract entities from sample blocks
    const firstPassBlocks = testBlocks.slice(0, 2);
    const entityGraph = await extractEntitiesWithSlidingWindow(
      firstPassBlocks,
      benchmarkMetadata,
      {provider: 'mock'},
      mockAI.mockCall.bind(mockAI)
    );
    const firstPassDuration = Date.now() - start;
    // Second pass: Enhance all blocks with extracted entities
    const secondPassStart = Date.now();
    const enhancedBlocks = await enhanceBlocksWithEntityContext(
      testBlocks,
      entityGraph,
      {provider: 'mock'},
      mockAI.mockCall.bind(mockAI)
    );
    const secondPassDuration = Date.now() - secondPassStart;
    const totalDuration = Date.now() - start;
    const stats = mockAI.getStats();
    // Verify results
    expect(entityGraph.subjects.length).toBeGreaterThan(0);
    expect(enhancedBlocks.length).toBe(testBlocks.length);
    expect(stats.calls).toBeGreaterThan(0);
    // Save two-pass results
    const twoPassResults = {
      testConfig: {
        blockCount: testBlocks.length,
        firstPassBlocks: firstPassBlocks.length,
        testDate: new Date().toISOString()
      },
      timing: {
        firstPassDuration,
        secondPassDuration,
        totalDuration
      },
      aiStats: stats,
      entityGraph: {
        peopleCount: entityGraph.people.length,
        placesCount: entityGraph.places.length,
        subjectsCount: entityGraph.subjects.length
      }
    };
    const twoPassFile = path.join(PERF_OUTPUT_DIR, 'two_pass_results.json');
    fs.writeFileSync(twoPassFile, JSON.stringify(twoPassResults, null, 2));
    console.log(`Two-pass benchmark completed in ${totalDuration}ms with ${stats.calls} AI calls`);
  }, 45000);

  it('demonstrates caching effectiveness with repeated content', async () => {
    console.log('Starting cache effectiveness demonstration');
    if (!fs.existsSync(PERF_OUTPUT_DIR)) {
      fs.mkdirSync(PERF_OUTPUT_DIR, {recursive: true});
    }
    const mockAI = new RealisticMockAI('CacheDemo', 100);
    // Create blocks with intentional repetition to trigger caching
    const repeatedBlocks = [
      {text: 'Cache optimization reduces redundant AI processing calls.'},
      {text: 'Performance testing validates system efficiency improvements.'},
      {text: 'Cache optimization reduces redundant AI processing calls.'}, // Repeat
      {text: 'Integration workflows ensure reliable system operation.'},
      {text: 'Performance testing validates system efficiency improvements.'}, // Repeat
      {text: 'Unique content that should not benefit from caching.'}
    ];
    const entityGraph = {
      people: [],
      places: [],
      organizations: [],
      dates: [],
      events: [],
      subjects: ['caching', 'performance', 'optimization'],
      relationships: []
    };
    const start = Date.now();
    const result = await enhanceBlocksWithCaching(
      repeatedBlocks,
      entityGraph,
      benchmarkMetadata,
      {provider: 'mock'},
      mockAI.mockCall.bind(mockAI)
    );
    const duration = Date.now() - start;
    const stats = mockAI.getStats();
    // Verify caching worked (fewer calls than total blocks due to repetition)
    expect(stats.calls).toBeLessThan(repeatedBlocks.length);
    expect(result.enhanced_blocks.length).toBe(repeatedBlocks.length);
    expect(result.cache_stats.cache_hits).toBeGreaterThan(0);
    const cacheEfficiency = Math.round((1 - stats.calls / repeatedBlocks.length) * 100);
    console.log(`Cache demonstration: ${cacheEfficiency}% reduction in AI calls`);
    // Save cache demonstration results
    const cacheResults = {
      testConfig: {
        totalBlocks: repeatedBlocks.length,
        uniqueBlocks: new Set(repeatedBlocks.map(b => b.text)).size,
        testDate: new Date().toISOString()
      },
      performance: {
        duration,
        aiCalls: stats.calls,
        cacheEfficiency: `${cacheEfficiency}%`
      },
      cacheStats: result.cache_stats
    };
    const cacheFile = path.join(PERF_OUTPUT_DIR, 'cache_demo_results.json');
    fs.writeFileSync(cacheFile, JSON.stringify(cacheResults, null, 2));
  }, 30000);
});
