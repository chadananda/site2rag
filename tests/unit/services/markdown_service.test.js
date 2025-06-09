import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownService } from '../../../src/services/markdown_service.js';
import { load } from 'cheerio';

describe('MarkdownService', () => {
  let markdownService;
  
  beforeEach(() => {
    markdownService = new MarkdownService();
  });
  
  describe('toMarkdown', () => {
    it('should convert basic HTML to markdown', () => {
      const html = '<h1>Title</h1><p>This is a <strong>bold</strong> paragraph.</p>';
      const markdown = markdownService.toMarkdown(html);
      
      expect(markdown).toContain('# Title');
      expect(markdown).toContain('This is a **bold** paragraph.');
    });
    
    it('should handle cheerio elements', () => {
      const $ = load('<div><h2>Heading</h2><p>Content</p></div>');
      const markdown = markdownService.toMarkdown($('div'));
      
      expect(markdown).toContain('## Heading');
      expect(markdown).toContain('Content');
    });
    
    it('should handle tables correctly', () => {
      const html = `
        <table>
          <tr>
            <th>Header 1</th>
            <th>Header 2</th>
          </tr>
          <tr>
            <td>Cell 1</td>
            <td>Cell 2</td>
          </tr>
        </table>
      `;
      
      const markdown = markdownService.toMarkdown(html);
      
      expect(markdown).toContain('| Header 1 | Header 2 |');
      expect(markdown).toContain('| --- | --- |');
      expect(markdown).toContain('| Cell 1 | Cell 2 |');
    });
    
    it('should handle code blocks correctly', () => {
      const html = `
        <pre><code class="language-javascript">
        function example() {
          return "Hello World";
        }
        </code></pre>
      `;
      
      const markdown = markdownService.toMarkdown(html);
      
      expect(markdown).toContain('```javascript');
      expect(markdown).toContain('function example()');
      expect(markdown).toContain('```');
    });
    
    it('should handle errors gracefully', () => {
      // Pass invalid input
      const markdown = markdownService.toMarkdown(null);
      
      expect(markdown).toBe('');
    });
  });
  
  describe('addFrontmatter', () => {
    it('should add basic frontmatter to markdown', () => {
      const markdown = '# Title\n\nContent';
      const metadata = {
        title: 'Page Title',
        date: '2023-01-01',
        tags: ['tag1', 'tag2']
      };
      
      const result = markdownService.addFrontmatter(markdown, metadata);
      
      expect(result).toContain('---');
      expect(result).toContain('title: Page Title');
      expect(result).toContain('date: 2023-01-01');
      expect(result).toContain('tags:');
      expect(result).toContain('  - tag1');
      expect(result).toContain('  - tag2');
      expect(result).toContain('# Title');
      expect(result).toContain('Content');
    });
    
    it('should handle nested metadata objects', () => {
      const markdown = 'Content';
      const metadata = {
        meta: {
          description: 'Page description',
          keywords: 'key, words'
        }
      };
      
      const result = markdownService.addFrontmatter(markdown, metadata);
      
      expect(result).toContain('meta:');
      expect(result).toContain('  description: Page description');
      expect(result).toContain('  keywords: key, words');
    });
    
    it('should quote values with special characters', () => {
      const markdown = 'Content';
      const metadata = {
        title: 'Title: with colon',
        description: 'Contains "quotes" and #hashtags'
      };
      
      const result = markdownService.addFrontmatter(markdown, metadata);
      
      expect(result).toContain('title: "Title: with colon"');
      expect(result).toContain('description: "Contains \\"quotes\\" and #hashtags"');
    });
    
    it('should skip empty metadata', () => {
      const markdown = 'Content';
      const result = markdownService.addFrontmatter(markdown, {});
      
      expect(result).toBe('Content');
      expect(result).not.toContain('---');
    });
    
    it('should filter out undefined values', () => {
      const markdown = 'Content';
      const metadata = {
        title: 'Title',
        description: undefined,
        author: null
      };
      
      const result = markdownService.addFrontmatter(markdown, metadata);
      
      expect(result).toContain('title: Title');
      expect(result).toContain('author: null');
      expect(result).not.toContain('description:');
    });
  });
});
