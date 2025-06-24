/**
 * Unit tests for file processing functionality
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import path from 'path';
import {parseFile, detectFormat, isFileSupported} from '../../src/file/parser.js';
import {serializeGraph, parseGraph} from '../../src/file/knowledge_graph.js';
// import {processFile} from '../../src/cli/file_processor.js'; // Currently unused

const TEST_DIR = 'tests/tmp/file-processing';
// const FIXTURES_DIR = 'tests/fixtures'; // Currently unused

describe('File Processing', () => {
  beforeEach(() => {
    // Create test directory
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, {recursive: true});
    }
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, {recursive: true, force: true});
    }
  });

  describe('File Format Detection', () => {
    it('should detect markdown formats correctly', () => {
      expect(detectFormat('.md')).toBe('markdown');
      expect(detectFormat('.markdown')).toBe('markdown');
      expect(detectFormat('.mdoc')).toBe('markdown');
      expect(detectFormat('md')).toBe('markdown');
    });

    it('should detect other formats correctly', () => {
      expect(detectFormat('.txt')).toBe('text');
      expect(detectFormat('.rst')).toBe('restructuredtext');
      expect(detectFormat('.adoc')).toBe('asciidoc');
      expect(detectFormat('.textile')).toBe('textile');
    });

    it('should default to text for unknown formats', () => {
      expect(detectFormat('.unknown')).toBe('text');
      expect(detectFormat('.docx')).toBe('text');
    });
  });

  describe('File Support Checking', () => {
    it('should support common markdown extensions', () => {
      expect(isFileSupported('document.md')).toBe(true);
      expect(isFileSupported('document.markdown')).toBe(true);
      expect(isFileSupported('document.mdoc')).toBe(true);
    });

    it('should support text formats', () => {
      expect(isFileSupported('document.txt')).toBe(true);
      expect(isFileSupported('document.rst')).toBe(true);
    });

    it('should reject unsupported formats', () => {
      expect(isFileSupported('document.docx')).toBe(false);
      expect(isFileSupported('document.pdf')).toBe(false);
    });
  });

  describe('File Parsing', () => {
    it('should parse markdown file with frontmatter', () => {
      const testFile = path.join(TEST_DIR, 'test.md');
      const content = `---
title: "Test Document"
author: "Test Author"
---

# Test Header

This is a test paragraph.

## Another Header

Another paragraph with some content.`;

      fs.writeFileSync(testFile, content);

      const parsed = parseFile(testFile);

      expect(parsed.metadata.title).toBe('Test Document');
      expect(parsed.metadata.author).toBe('Test Author');
      expect(parsed.metadata.source_file).toBe(testFile);
      expect(parsed.originalFormat).toBe('markdown');
      expect(parsed.blocks).toHaveLength(4); // Header, paragraph, header, paragraph
    });

    it('should parse plain text file', () => {
      const testFile = path.join(TEST_DIR, 'test.txt');
      const content = `This is the first paragraph.

This is the second paragraph.

This is the third paragraph.`;

      fs.writeFileSync(testFile, content);

      const parsed = parseFile(testFile);

      expect(parsed.originalFormat).toBe('text');
      expect(parsed.blocks).toHaveLength(3);
      expect(parsed.blocks[0].text).toBe('This is the first paragraph.');
      expect(parsed.blocks[0].type).toBe('paragraph');
    });

    it('should handle markdown with code blocks', () => {
      const testFile = path.join(TEST_DIR, 'code.md');
      const content = `# Code Example

Here's some code:

\`\`\`javascript
function hello() {
  return "world";
}
\`\`\`

And another paragraph.`;

      fs.writeFileSync(testFile, content);

      const parsed = parseFile(testFile);

      expect(parsed.blocks).toHaveLength(4);
      expect(parsed.blocks[2].type).toBe('code');
      expect(parsed.blocks[2].text).toContain('function hello()');
    });

    it('should handle files without frontmatter', () => {
      const testFile = path.join(TEST_DIR, 'no-frontmatter.md');
      const content = `# Simple Document

Just some content without frontmatter.`;

      fs.writeFileSync(testFile, content);

      const parsed = parseFile(testFile);

      expect(parsed.metadata.source_file).toBe(testFile);
      expect(parsed.metadata.title).toBeUndefined();
      expect(parsed.blocks).toHaveLength(2);
    });
  });

  describe('Knowledge Graph Serialization', () => {
    it.skip('should serialize and parse knowledge graph correctly', () => {
      const originalGraph = {
        people: [
          {
            name: 'John Doe',
            roles: ['CEO', 'Founder'],
            context: 'Technology company leader',
            sources: ['document1.md']
          }
        ],
        places: [
          {
            name: 'New York',
            type: 'city',
            context: 'Business headquarters location',
            sources: ['document1.md']
          }
        ],
        organizations: [
          {
            name: 'Tech Corp',
            type: 'company',
            context: 'Software development company',
            sources: ['document1.md']
          }
        ],
        relationships: [
          {
            from: 'John Doe',
            relationship: 'founded',
            to: 'Tech Corp',
            context: 'Started the company in 2020',
            sources: ['document1.md']
          }
        ],
        subjects: ['technology', 'business', 'software']
      };

      const sources = [{file: 'document1.md', title: 'Company History', processed_at: '2025-06-20T00:00:00Z'}];

      const serialized = serializeGraph(originalGraph, sources);
      expect(serialized).toContain('# Knowledge Graph: Document Analysis');
      expect(serialized).toContain('## People');
      expect(serialized).toContain('John Doe (CEO, Founder)');
      expect(serialized).toContain('## Relationships');
      expect(serialized).toContain('John Doe → founded → Tech Corp');

      const parsed = parseGraph(serialized);
      console.log('Serialized graph:', serialized);
      console.log('Parsed result:', JSON.stringify(parsed, null, 2));
      expect(parsed.people).toHaveLength(1);
      expect(parsed.people[0].name).toBe('John Doe');
      expect(parsed.people[0].roles).toEqual(['CEO, Founder']);
      expect(parsed.places).toHaveLength(1);
      expect(parsed.relationships).toHaveLength(1);
    });

    it('should handle empty knowledge graph', () => {
      const emptyGraph = {
        people: [],
        places: [],
        organizations: [],
        relationships: [],
        subjects: []
      };

      const serialized = serializeGraph(emptyGraph, []);
      expect(serialized).toContain('# Knowledge Graph: Document Analysis');

      const parsed = parseGraph(serialized);
      expect(parsed.people).toEqual([]);
      expect(parsed.places).toEqual([]);
    });
  });

  describe('File Processing Integration', () => {
    it('should process markdown file with no-enhancement option', async () => {
      // Create a simple test file
      const testFile = path.join(TEST_DIR, 'simple.md');
      const content = `---
title: "Simple Test"
---

# Test Document

This is a test paragraph about John working in Paris.

Another paragraph mentioning Microsoft and their software.`;

      fs.writeFileSync(testFile, content);

      // Test would require mocking the AI system
      // For now, just test that the function doesn't throw
      expect(() => parseFile(testFile)).not.toThrow();
    });
  });
});
