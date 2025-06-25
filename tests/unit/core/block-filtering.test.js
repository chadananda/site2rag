import {describe, it, expect} from 'vitest';

// Copy the createKeyedBlocks function for testing
function createKeyedBlocks(blocks, minChars = 30) {
  const keyedBlocks = {};
  const indexMapping = {};

  blocks.forEach((block, index) => {
    // Extract text content only (no markdown formatting)
    const textOnly = (block.text || block.content || block).replace(/[#*`[\]()\-_]/g, '').trim();

    if (textOnly.length >= minChars) {
      const key = `block_${index}`;
      keyedBlocks[key] = block.text || block.content || block;
      indexMapping[key] = index;
    }
  });

  return {keyedBlocks, indexMapping};
}

describe('Block Filtering for AI Enhancement', () => {
  it('should include blocks with 30+ characters after removing markdown', () => {
    const blocks = [
      {text: '# Short Header'}, // 12 chars clean
      {text: '## Longer Section Header'}, // 21 chars clean
      {text: 'This is a paragraph with enough content.'}, // 40 chars
      {text: '- Short bullet'}, // 13 chars clean
      {text: '**Bold text that is long enough to pass**'} // 35 chars clean
    ];

    const {keyedBlocks} = createKeyedBlocks(blocks, 30);

    // Should include blocks 2 and 4 (indices 2 and 4)
    expect(Object.keys(keyedBlocks)).toHaveLength(2);
    expect(keyedBlocks.block_2).toBe(blocks[2].text);
    expect(keyedBlocks.block_4).toBe(blocks[4].text);
  });

  it('should filter more blocks with old 100-char threshold', () => {
    const blocks = [
      {text: '# Document Title'}, // Too short
      {text: 'A medium paragraph with some content but not quite enough for the old 100 character threshold.'}, // 94 chars
      {
        text: 'This is a much longer paragraph that contains well over one hundred characters and would definitely pass the old threshold without any issues.'
      } // 140+ chars
    ];

    // Old threshold (100 chars)
    const oldResult = createKeyedBlocks(blocks, 100);
    expect(Object.keys(oldResult.keyedBlocks)).toHaveLength(1);
    expect(oldResult.keyedBlocks.block_2).toBeDefined();

    // New threshold (30 chars)
    const newResult = createKeyedBlocks(blocks, 30);
    expect(Object.keys(newResult.keyedBlocks)).toHaveLength(2);
    expect(newResult.keyedBlocks.block_1).toBeDefined();
    expect(newResult.keyedBlocks.block_2).toBeDefined();
  });

  it('should preserve exact block text including markdown', () => {
    const blocks = [{text: '### Section Header with **bold** and _italic_ text that is long enough'}];

    const {keyedBlocks} = createKeyedBlocks(blocks, 30);

    // Should preserve the original markdown
    expect(keyedBlocks.block_0).toBe(blocks[0].text);
    expect(keyedBlocks.block_0).toContain('**bold**');
    expect(keyedBlocks.block_0).toContain('_italic_');
  });

  it('should correctly map block indices', () => {
    const blocks = [
      {text: 'Too short'}, // Filtered
      {text: 'This block has enough characters to pass the filter'}, // Passes
      {text: 'Short'}, // Filtered
      {text: 'Another block with sufficient content to be included'} // Passes
    ];

    const {keyedBlocks, indexMapping} = createKeyedBlocks(blocks, 30);

    expect(Object.keys(keyedBlocks)).toHaveLength(2);
    expect(indexMapping.block_1).toBe(1);
    expect(indexMapping.block_3).toBe(3);
  });
});
