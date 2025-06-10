import TurndownService from 'turndown';
import logger from './logger_service.js';

/**
 * Service for HTML to Markdown conversion and content formatting
 */
export class MarkdownService {
  /**
   * Creates a new MarkdownService instance
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      ...options
    });
    
    // Add custom rules
    this.addCustomRules();
  }

  /**
   * Adds custom turndown rules for better Markdown conversion
   * @private
   */
  addCustomRules() {
    // Custom link handling
    this.turndownService.addRule('links', {
      filter: 'a',
      replacement: (content, node) => {
        // Get the href attribute
        const href = node.getAttribute('href');
        if (!href) return content;
        
        // Check if this is a PDF or DOCX link
        const isPdfOrDocx = href.toLowerCase().endsWith('.pdf') || href.toLowerCase().endsWith('.docx');
        
        // Get the title attribute
        const title = node.title ? ` "${node.title}"` : '';
        
        // If it's a PDF or DOCX and it's a relative link, keep it relative
        // Otherwise, make sure it's an absolute URL
        if (isPdfOrDocx && !href.startsWith('http') && !href.startsWith('//')) {
          // For PDF/DOCX, we'll keep the relative path
          // TODO: Download the file to the local folder structure
          logger.info(`[MARKDOWN] Keeping relative link for document: ${href}`);
          return `[${content}](${href}${title})`;
        } else {
          // For all other links, ensure they are absolute
          let absoluteUrl = href;
          
          // If we have a baseUrl in the context, use it to resolve relative URLs
          if (this.baseUrl && !href.startsWith('http') && !href.startsWith('//')) {
            try {
              absoluteUrl = new URL(href, this.baseUrl).href;
            } catch (error) {
              logger.warn(`[MARKDOWN] Error resolving URL: ${href}`, error);
              absoluteUrl = href; // Fallback to original
            }
          }
          
          return `[${content}](${absoluteUrl}${title})`;
        }
      }
    });
    
    // Preserve tables
    this.turndownService.addRule('tables', {
      filter: ['table'],
      replacement: function(content, node) {
        // Simple table handling - could be improved for complex tables
        const rows = node.querySelectorAll('tr');
        if (!rows.length) return '';
        
        let markdown = '\n\n';
        
        // Process each row
        Array.from(rows).forEach((row, rowIndex) => {
          const cells = row.querySelectorAll('th, td');
          
          // Process each cell in the row
          Array.from(cells).forEach((cell, cellIndex) => {
            const cellContent = cell.textContent.trim();
            markdown += `| ${cellContent} `;
            
            // Add trailing pipe at end of row
            if (cellIndex === cells.length - 1) {
              markdown += '|\n';
            }
          });
          
          // Add header separator row
          if (rowIndex === 0 && row.querySelectorAll('th').length) {
            Array.from(cells).forEach(() => {
              markdown += '| --- ';
            });
            markdown += '|\n';
          }
        });
        
        return markdown + '\n\n';
      }
    });
    
    // Better code block handling
    this.turndownService.addRule('codeBlocks', {
      filter: ['pre'],
      replacement: function(content, node) {
        const code = node.querySelector('code');
        const language = code ? (code.className.match(/language-(\w+)/) || [])[1] || '' : '';
        const codeContent = code ? code.textContent : node.textContent;
        
        return `\n\n\`\`\`${language}\n${codeContent.trim()}\n\`\`\`\n\n`;
      }
    });
  }

  /**
   * Converts HTML to Markdown
   * @param {string|Object} html - HTML string or cheerio element
   * @param {string} baseUrl - Base URL for resolving relative links
   * @returns {string} - Markdown content
   */
  toMarkdown(html, baseUrl) {
    try {
      // Store the base URL for link resolution in our custom rules
      this.baseUrl = baseUrl;
      
      // Handle both string and cheerio element
      const content = typeof html === 'string' ? html : html.html();
      const markdown = this.turndownService.turndown(content);
      
      // Clear the baseUrl after conversion
      this.baseUrl = null;
      
      return markdown;
    } catch (e) {
      logger.info(`[MARKDOWN] Error converting to markdown: ${e.message}`);
      return '';
    }
  }

  /**
   * Adds frontmatter to markdown content
   * @param {string} markdown - Markdown content
   * @param {Object} metadata - Metadata to include in frontmatter
   * @returns {string} - Markdown with frontmatter
   */
  addFrontmatter(markdown, metadata = {}) {
    // Filter out undefined values
    const filteredMeta = Object.fromEntries(
      Object.entries(metadata).filter(([_, v]) => v !== undefined)
    );
    
    if (Object.keys(filteredMeta).length === 0) {
      return markdown;
    }
    
    // Format frontmatter
    let frontmatter = '---\n';
    
    for (const [key, value] of Object.entries(filteredMeta)) {
      // Format arrays as YAML arrays
      if (Array.isArray(value)) {
        frontmatter += `${key}:\n`;
        value.forEach(item => {
          frontmatter += `  - ${item}\n`;
        });
      } 
      // Format objects recursively
      else if (typeof value === 'object' && value !== null) {
        frontmatter += `${key}:\n`;
        for (const [subKey, subValue] of Object.entries(value)) {
          frontmatter += `  ${subKey}: ${this.formatYamlValue(subValue)}\n`;
        }
      } 
      // Format strings and other primitives
      else {
        frontmatter += `${key}: ${this.formatYamlValue(value)}\n`;
      }
    }
    
    frontmatter += '---\n\n';
    return frontmatter + markdown;
  }

  /**
   * Formats a value for YAML frontmatter
   * @param {any} value - Value to format
   * @returns {string} - Formatted value
   * @private
   */
  formatYamlValue(value) {
    if (typeof value === 'string') {
      // Escape special characters and wrap in quotes if needed
      if (value.includes(':') || value.includes('#') || value.includes("'") || 
          value.includes('"') || value.match(/^\s/) || value.match(/\s$/)) {
        // Use double quotes and escape internal double quotes
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }
    
    if (value === null || value === undefined) {
      return 'null';
    }
    
    return String(value);
  }
}
