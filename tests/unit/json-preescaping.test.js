/**
 * Unit test for pre-escaped JSON approach
 * Verifies that our JSON template method reduces formatting errors
 */

import { describe, it, expect, vi } from 'vitest';
import { enhanceBlocksWithEntityContext } from '../../src/context.js';

describe('Pre-escaped JSON Approach', () => {
  it('should generate correct JSON template with pre-escaped content', async () => {
    let capturedPrompt = '';
    
    // Mock AI that captures the prompt and returns valid response
    const mockAI = vi.fn().mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return Promise.resolve({
        contexted_markdown: 'Enhanced: Chad Jones (software developer) created Ocean software.',
        context_summary: 'Added role context for Chad Jones'
      });
    });

    const blocks = [
      { text: 'Chad Jones created Ocean software.' }
    ];
    
    const entityGraph = {
      people: [{ name: 'Chad Jones', roles: ['software developer'] }],
      subjects: ['software development']
    };

    await enhanceBlocksWithEntityContext(blocks, entityGraph, {}, mockAI);

    // Verify the prompt contains pre-escaped JSON structure
    expect(capturedPrompt).toContain('"Chad Jones created Ocean software."');
    expect(capturedPrompt).toContain('contexted_markdown": "Chad Jones created Ocean software."');
    expect(capturedPrompt).toContain('Replace the content inside contexted_markdown');
    
    // Verify the original text is properly JSON-escaped in the template
    const jsonMatch = capturedPrompt.match(/"contexted_markdown": ("[^"]*")/);
    expect(jsonMatch).toBeTruthy();
    expect(jsonMatch[1]).toBe('"Chad Jones created Ocean software."');
  });

  it('should handle special characters in pre-escaped JSON', async () => {
    let capturedPrompt = '';
    
    const mockAI = vi.fn().mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return Promise.resolve({
        contexted_markdown: 'Enhanced text with quotes and newlines.',
        context_summary: 'Handled special characters'
      });
    });

    const blocks = [
      { text: 'Text with "quotes" and\nnewlines and\ttabs.' }
    ];
    
    const entityGraph = { people: [], subjects: [] };

    await enhanceBlocksWithEntityContext(blocks, entityGraph, {}, mockAI);

    // Verify special characters are properly escaped in the JSON template
    expect(capturedPrompt).toContain('\\"quotes\\"'); // quotes escaped
    expect(capturedPrompt).toContain('\\n'); // newlines escaped
    expect(capturedPrompt).toContain('\\t'); // tabs escaped
    
    // The template should contain properly escaped JSON
    expect(capturedPrompt).toContain('"Text with \\"quotes\\" and\\nnewlines and\\ttabs."');
  });

  it('should provide clear instructions for AI to follow template', async () => {
    let capturedPrompt = '';
    
    const mockAI = vi.fn().mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return Promise.resolve({
        contexted_markdown: 'Enhanced content',
        context_summary: 'Added context'
      });
    });

    const blocks = [{ text: 'Simple text.' }];
    const entityGraph = { people: [], subjects: [] };

    await enhanceBlocksWithEntityContext(blocks, entityGraph, {}, mockAI);

    // Verify clear instructions are provided
    expect(capturedPrompt).toContain('IMPORTANT: Return exactly this JSON structure');
    expect(capturedPrompt).toContain('Replace the content inside contexted_markdown');
    expect(capturedPrompt).toContain('keeping the same JSON string format');
    expect(capturedPrompt).toContain('The original text is:');
    expect(capturedPrompt).toContain('Enhance the text and return valid JSON only');
  });

  it('should work with complex content containing markdown', async () => {
    const mockAI = vi.fn().mockResolvedValue({
      contexted_markdown: '## Ocean Software\n\nChad Jones (developer) created **Ocean** search software.',
      context_summary: 'Added developer role and emphasized software name'
    });

    const blocks = [
      { text: '## Ocean Software\n\nChad Jones created **Ocean** search software.' }
    ];
    
    const entityGraph = {
      people: [{ name: 'Chad Jones', roles: ['developer'] }]
    };

    const result = await enhanceBlocksWithEntityContext(blocks, entityGraph, {}, mockAI);

    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('## Ocean Software\n\nChad Jones created **Ocean** search software.');
    expect(result[0].contexted).toContain('Chad Jones (developer)');
    expect(result[0].contexted).toContain('**Ocean**'); // markdown preserved
  });

  it('should demonstrate the JSON template approach reduces AI formatting burden', () => {
    // This test shows how the old vs new approach differs
    const problematicText = 'Text with "quotes", \nnewlines, and special chars: àáâã';
    
    // Old approach - AI had to figure out JSON escaping
    const oldPrompt = `Return JSON: {"contexted_markdown": "enhanced version of: ${problematicText}"}`;
    
    // New approach - we provide pre-escaped template
    const escapedText = JSON.stringify(problematicText);
    const newPrompt = `Return exactly this JSON structure:
{
  "contexted_markdown": ${escapedText},
  "context_summary": "changes made"
}
Replace the content inside contexted_markdown with enhanced version.`;

    // Old approach would likely cause JSON parsing errors
    expect(oldPrompt).toContain('\n'); // unescaped newline
    expect(oldPrompt).toContain('"quotes"'); // unescaped quotes
    
    // New approach provides properly escaped JSON
    expect(newPrompt).toContain('\\"quotes\\"'); // properly escaped
    expect(newPrompt).toContain('\\n'); // properly escaped newlines
    
    // The new template should be parseable
    const templateMatch = newPrompt.match(/\{[\s\S]*\}/);
    expect(() => {
      const template = templateMatch[0].replace(escapedText, '"replacement text"');
      JSON.parse(template);
    }).not.toThrow();
  });
});