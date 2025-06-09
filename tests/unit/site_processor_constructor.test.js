import { describe, it, expect } from 'vitest';
import { SiteProcessor } from '../../src/site_processor.js';
import path from 'path';

describe('SiteProcessor Constructor', () => {
  const TEST_URL = 'https://example.com/page';
  
  it('should set default values correctly when no options provided', () => {
    const processor = new SiteProcessor(TEST_URL);
    
    // Check domain extraction
    expect(processor.domain).toBe('https://example.com');
    
    // Check default values
    expect(processor.maxPages).toBe(-1); // Unlimited pages
    expect(processor.maxDepth).toBe(-1); // Unlimited depth
    expect(processor.politeWaitMs).toBe(1000);
    
    // Check output directory is <CWD>/<domain>
    const expectedOutputDir = path.join(process.cwd(), 'example.com');
    expect(processor.outputDir).toBe(expectedOutputDir);
    
    // Check AI config default
    expect(processor.aiConfig).toEqual({});
  });
  
  it('should use provided values when options are specified', () => {
    const customOptions = {
      limit: 10,
      maxDepth: 3,
      politeWaitMs: 2000,
      outputDir: './custom-output',
      aiConfig: { model: 'test-model' }
    };
    
    const processor = new SiteProcessor(TEST_URL, customOptions);
    
    expect(processor.maxPages).toBe(10);
    expect(processor.maxDepth).toBe(3);
    expect(processor.politeWaitMs).toBe(2000);
    expect(processor.outputDir).toBe('./custom-output');
    expect(processor.aiConfig).toEqual({ model: 'test-model' });
  });
  
  it('should handle zero values correctly', () => {
    const zeroOptions = {
      limit: 0,
      maxDepth: 0
    };
    
    const processor = new SiteProcessor(TEST_URL, zeroOptions);
    
    // Zero should be preserved, not converted to default
    expect(processor.maxPages).toBe(0);
    expect(processor.maxDepth).toBe(0);
  });
});
