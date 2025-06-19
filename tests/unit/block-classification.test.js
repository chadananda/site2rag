import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentService } from '../../src/services/content_service.js';
import * as aiAssist from '../../src/ai_assist.js';

// Mock the AI assist functions
vi.mock('../../src/ai_assist.js', () => ({
  aiServiceAvailable: vi.fn(),
  classifyBlocksWithAI: vi.fn()
}));

describe('Block Classification in ContentService', () => {
  let contentService;
  const mockHtml = `
    <html>
      <body>
        <main>
          <div id="block1">Main content</div>
          <div id="block2">Important info</div>
          <div id="block3">Navigation menu</div>
          <div id="block4">Footer content</div>
          <div id="block5">Copyright notice</div>
        </main>
      </body>
    </html>
  `;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create content service instance
    contentService = new ContentService({
      aiConfig: {
        provider: 'test-provider',
        model: 'test-model'
      }
    });
  });
  
  it('should process HTML without AI when service is unavailable', async () => {
    // Mock AI service as unavailable
    aiAssist.aiServiceAvailable.mockResolvedValue(false);
    
    const result = await contentService.processHtml(mockHtml, 'https://example.com');
    
    // Verify AI service availability was checked
    expect(aiAssist.aiServiceAvailable).toHaveBeenCalledWith(contentService.aiConfig);
    
    // Verify classifyBlocksWithAI was not called
    expect(aiAssist.classifyBlocksWithAI).not.toHaveBeenCalled();
    
    // Verify main content is returned intact
    expect(result.main.children()).toHaveLength(5);
  });
  
  it('should use AI to remove boilerplate blocks when service is available', async () => {
    // Mock AI service as available
    aiAssist.aiServiceAvailable.mockResolvedValue(true);
    
    // Mock classification result - indices 1 and 3 are boilerplate (block2 and block4)
    aiAssist.classifyBlocksWithAI.mockResolvedValue([1, 3]);
    
    const result = await contentService.processHtml(mockHtml, 'https://example.com');
    
    // Verify AI service availability was checked
    expect(aiAssist.aiServiceAvailable).toHaveBeenCalledWith(contentService.aiConfig);
    
    // Verify classifyBlocksWithAI was called with block HTML contents
    expect(aiAssist.classifyBlocksWithAI).toHaveBeenCalled();
    expect(aiAssist.classifyBlocksWithAI.mock.calls[0][1]).toBe(contentService.aiConfig);
    
    // Verify blocks were removed (should have 3 left instead of 5)
    expect(result.main.children()).toHaveLength(3);
    
    // Verify the right blocks remain (blocks 1, 3, and 5 should be present)
    const remainingIds = result.main.children().map((_, el) => result.$(el).attr('id')).get();
    expect(remainingIds).toContain('block1');
    expect(remainingIds).toContain('block3');
    expect(remainingIds).toContain('block5');
    expect(remainingIds).not.toContain('block2');
    expect(remainingIds).not.toContain('block4');
  });
  
  it('should handle errors in block classification gracefully', async () => {
    // Mock AI service as available but throws an error
    aiAssist.aiServiceAvailable.mockResolvedValue(true);
    aiAssist.classifyBlocksWithAI.mockRejectedValue(new Error('Classification failed'));
    
    // Spy on console.log
    const consoleSpy = vi.spyOn(console, 'log');
    
    const result = await contentService.processHtml(mockHtml, 'https://example.com');
    
    // Verify error was logged
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error in block classification'));
    
    // Verify main content is returned intact despite error
    expect(result.main.children()).toHaveLength(5);
    
    // Restore console.log
    consoleSpy.mockRestore();
  });
  
  it('should not attempt classification with too few blocks', async () => {
    // Create HTML with only 2 blocks
    const simpleHtml = `
      <html>
        <body>
          <main>
            <div>Block 1</div>
            <div>Block 2</div>
          </main>
        </body>
      </html>
    `;
    
    // Mock AI service as available
    aiAssist.aiServiceAvailable.mockResolvedValue(true);
    
    const result = await contentService.processHtml(simpleHtml, 'https://example.com');
    
    // With only 2 blocks, AI service availability should not be checked
    expect(aiAssist.aiServiceAvailable).not.toHaveBeenCalled();
    
    // Verify classifyBlocksWithAI was not called because there are too few blocks
    expect(aiAssist.classifyBlocksWithAI).not.toHaveBeenCalled();
    
    // Verify both blocks remain
    expect(result.main.children()).toHaveLength(2);
  });
});
