import { load } from 'cheerio';
import { aiServiceAvailable, classifyBlocksWithAI } from '../ai_assist.js';
import path from 'path';
import fs from 'fs';
import { URL } from 'url';
import { 
  extractMainContent as extractGenericContent,
  scoreContentElement,
  isLikelyNavigationOrBoilerplate,
  cleanupContent,
  generateConsistentSelector
} from './content_extractor.js';
import logger from './logger_service.js';

/**
 * Service for HTML content processing, extraction, and classification
 */
export class ContentService {
  /**
   * Creates a new ContentService instance
   * @param {Object} options - Configuration options
   * @param {Object} options.aiConfig - AI service configuration
   */
  constructor(options = {}) {
    this.aiConfig = options.aiConfig || null;
    this.debug = options.debug || false;
    this.outputDir = options.outputDir || './output';
    
    // Create debug directory if debug mode is enabled
    if (this.debug) {
      this.debugDir = path.join(this.outputDir, '.site2rag', 'debug');
      logger.info(`[DEBUG] Debug mode enabled, debug info will be saved to ${this.debugDir}`);
      try {
        fs.mkdirSync(this.debugDir, { recursive: true });
      } catch (err) {
        logger.warn(`[DEBUG] Failed to create debug directory: ${err.message}`);
      }
    }
    this.fileService = options.fileService;
  }

  /**
   * Processes HTML content, extracts main content, and removes boilerplate
   * @param {string} html - Raw HTML content
   * @param {string} url - Source URL of the content
   */
  async processHtml(html, url) {
    const $ = load(html);
    
    // Extract links from the entire document BEFORE removing any elements
    const links = this.extractLinks($, $('html'), url);
    
    // Extract metadata from HTML (also before content cleaning)
    const metadata = this.extractMetadata($);
    
    // Initialize debug tracking object early so we can track boilerplate removal
    let removedBlocks = null;
    if (this.debug) {
      logger.info('[DEBUG] Debug mode enabled, initializing removedBlocks tracking');
      removedBlocks = { selectorDecisions: new Map() };
    }
    
    // Extract main content
    const main = await this.extractMainContent($, removedBlocks);
    
    if (!main || main.length === 0) {
      // Only log as warning in debug mode, otherwise use info level
      if (this.debug) {
        logger.warn('No main content found');
      } else {
        logger.info('No main content found');
      }
      return { $, main: null, links, metadata, removedBlocks };
    }
    
    // Clean up the extracted content to remove script tags and other non-content elements
    const cleanedMain = cleanupContent($, main, {
      debug: this.debug,
      removedBlocks,
      trackSelectorDecision: (selector, decision, blocks, reason) => {
        this.trackSelectorDecision(selector, decision, blocks, reason);
      }
    });
    
    // Process links in the main content - convert relative to absolute and handle documents
    if (url && this.fileService) {
      await this.processLinks($, cleanedMain, url);
    }
    
    // Apply AI-based block classification if enabled
    if (this.aiConfig && this.aiConfig.blockClassificationEnabled) {
      try {
        await this.applyBlockClassification($, cleanedMain, removedBlocks);
      } catch (error) {
        logger.error('[AI] Error applying block classification:', error);
      }
    }
    
    // Add a separator in the debug tracking to distinguish between phases
    if (this.debug && removedBlocks && removedBlocks.selectorDecisions) {
      this.trackSelectorDecision('--phase-separator--', 'info', removedBlocks, 'Above: Initial boilerplate removal | Below: Content classification');
      
      // Save debug information if URL is provided
      if (url) {
        this.saveDebugInfo(url, $, cleanedMain, removedBlocks);
      }
    }
    
    return { $, html: $.html(cleanedMain), main: cleanedMain, links, metadata, removedBlocks };
  }
  
  /**
   * Extract main content from HTML using a framework-agnostic approach
   * @param {Object} $ - Cheerio instance
   * @param {Object} removedBlocks - Object to track removed blocks for debugging
   * @returns {Object} - Main content element
   */
  extractMainContent($, removedBlocks = null) {
    try {
      logger.info('[CONTENT] Starting main content extraction with generic approach');
      
      // Setup options for content extraction
      const options = {
        debug: this.debug,
        removedBlocks,
        trackSelectorDecision: (selector, decision, blocks, reason) => {
          this.trackSelectorDecision(selector, decision, blocks, reason);
        }
      };
      
      try {
        // Use our framework-agnostic content extractor
        const extractedContent = extractGenericContent($, $('body'), options);
        
        if (extractedContent && extractedContent.length > 0) {
          logger.info('[CONTENT] Successfully extracted main content');
          return extractedContent;
        }
      } catch (extractError) {
        // Log the specific extraction error but continue with fallbacks
        if (this.debug) {
          logger.warn('[CONTENT] Generic extractor failed, trying fallbacks:', extractError);
        } else {
          logger.info('[CONTENT] Generic extractor failed, trying fallbacks');
        }
      }
      
      // Fallback 1: Try common content selectors
      const commonSelectors = [
        'article', 'main', '[role="main"]', '.content', '#content', '.main-content', 
        '#main-content', '.post-content', '.entry-content', '.article-content'
      ];
      
      for (const selector of commonSelectors) {
        const element = $(selector).first();
        if (element.length > 0 && element.text().trim().length > 100) {
          logger.info(`[CONTENT] Found content using selector: ${selector}`);
          return element;
        }
      }
      
      // Fallback 2: Find the element with the most paragraph tags
      const containers = $('div, section').filter(function() {
        return $(this).find('p').length >= 2 && $(this).text().trim().length > 200;
      });
      
      if (containers.length > 0) {
        // Sort by number of paragraphs (descending)
        const sortedContainers = Array.from(containers).sort((a, b) => {
          return $(b).find('p').length - $(a).find('p').length;
        });
        
        if (sortedContainers.length > 0) {
          logger.info('[CONTENT] Found content using paragraph density heuristic');
          return $(sortedContainers[0]);
        }
      }
      
      // Only log as warning in debug mode, otherwise use info level
      if (this.debug) {
        logger.warn('[CONTENT] No content found after all fallbacks, returning body');
      } else {
        logger.info('[CONTENT] No content found after fallbacks');
      }
      
      // Last resort: return the body element
      return $('body');
    } catch (error) {
      // Only log full error in debug mode
      if (this.debug) {
        logger.error('[CONTENT] Error extracting main content:', error);
      } else {
        // In production, only log for the first few URLs to avoid repetition
        // Use a class property to track error count instead of a static variable
        if (!this.contentExtractionErrorCount) {
          this.contentExtractionErrorCount = 0;
        }
        
        if (this.contentExtractionErrorCount < 3) {
          logger.error('[CONTENT] Error extracting main content');
          this.contentExtractionErrorCount++;
        } else if (this.contentExtractionErrorCount === 3) {
          logger.error('[CONTENT] Additional content extraction errors suppressed to reduce verbosity');
          this.contentExtractionErrorCount++;
        }
      }
      
      // Even in case of error, return the body element as a fallback
      try {
        return $('body');
      } catch (e) {
        // If even that fails, return an empty set
        return $();
      }
    }
  }

  /**
   * Track selector decisions for debugging
   * @param {string} selector - CSS selector
   * @param {string} decision - Decision (keep, remove, skip)
   * @param {Object} removedBlocks - Object to track removed blocks
   * @param {string} reason - Reason for decision
   */
  trackSelectorDecision(selector, decision, removedBlocks, reason) {
    if (this.debug && removedBlocks && removedBlocks.selectorDecisions) {
      removedBlocks.selectorDecisions.set(selector, { decision, reason });
      logger.info(`[DECISION] ${selector}: ${decision} (${reason})`);
    }
  }

  /**
   * Process links in the main content - convert relative to absolute and handle documents
   * @param {Object} $ - Cheerio instance
   * @param {Object} main - Main content element
   * @param {string} baseUrl - Base URL for resolving relative links
   * @returns {Promise<void>}
   */
  async processLinks($, main, baseUrl) {
    if (!main || !baseUrl || !this.fileService) return;
    
    try {
      const { hostname } = new URL(baseUrl);
      const documentDownloads = [];
      
      // Find all links in the main content
      $(main).find('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        
        try {
          // Skip fragment-only links, javascript:, mailto:, tel:, etc.
          if (href.startsWith('#') || 
              href.startsWith('javascript:') || 
              href.startsWith('mailto:') || 
              href.startsWith('tel:')) {
            return;
          }
          
          // Check if this is a PDF or DOCX link
          const isPdfOrDocx = href.toLowerCase().endsWith('.pdf') || 
                             href.toLowerCase().endsWith('.docx');
          
          // For PDF/DOCX links that are relative, we'll download them
          if (isPdfOrDocx && !href.startsWith('http') && !href.startsWith('//')) {
            // Add to download queue - we'll process these after scanning all links
            documentDownloads.push({
              element: el,
              href
            });
          } else if (!href.startsWith('http') && !href.startsWith('//')) {
            // For other relative links, convert to absolute
            try {
              const absoluteUrl = new URL(href, baseUrl).href;
              $(el).attr('href', absoluteUrl);
            } catch (error) {
              logger.warn(`[LINKS] Error resolving URL: ${href}`, error);
            }
          }
        } catch (error) {
          logger.warn(`[LINKS] Error processing link: ${href}`, error);
        }
      });
      
      // Process document downloads
      if (documentDownloads.length > 0) {
        logger.info(`[DOCUMENT] Found ${documentDownloads.length} document links to download`);
        
        for (const item of documentDownloads) {
          const result = await this.fileService.downloadDocument(item.href, baseUrl, hostname);
          
          if (result.success) {
            // Update the link to point to the local file
            $(item.element).attr('href', result.relativePath);
            logger.info(`[DOCUMENT] Updated link to local path: ${result.relativePath}`);
          }
        }
      }
    } catch (error) {
      logger.error(`[LINKS] Error processing links: ${error.message}`);
    }
  }
  
  /**
   * Check if a resource filename represents a binary file
   * @param {string} filename - Filename to check
   * @returns {boolean} - Whether the filename likely represents a binary file
   */
  isBinaryResource(filename) {
    if (!filename) return false;
    
    // Check file extension
    const binaryExtensions = [
      // Document formats
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.odt', '.ods', '.odp', '.rtf',
      
      // Archive formats
      '.zip', '.rar', '.7z', '.tar', '.gz',
      
      // Media formats
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg',
      '.mp3', '.mp4', '.wav', '.avi', '.mov'
    ];
    
    const lowercaseFilename = filename.toLowerCase();
    const result = binaryExtensions.some(ext => lowercaseFilename.endsWith(ext));
    
    if (result) {
      logger.info(`[PDF_TRACKING] ContentService detected binary resource: ${filename}`);
      // Log more details about the file type
      const ext = filename.split('.').pop().toLowerCase();
      if (ext === 'pdf') {
        logger.info(`[PDF_TRACKING] PDF file detected: ${filename}`);
      } else if (ext === 'docx' || ext === 'doc') {
        logger.info(`[PDF_TRACKING] Word document detected: ${filename}`);
      }
    }
    
    return result;
  }
  
  /**
   * Extract links from HTML for crawling
   * @param {Object} $ - Cheerio instance
   * @param {Object} element - Element to extract links from
   * @param {string} baseUrl - Base URL for resolving relative links
   * @returns {Array} - Array of extracted links
   */
  extractLinks($, element, baseUrl) {
    const links = [];
    const seenUrls = new Set();
    let totalFound = 0;
    let totalAdded = 0;
    
    $(element).find('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      totalFound++;
      
      try {
        // Skip javascript: links, mailto:, tel:, etc.
        if (href.startsWith('javascript:') || 
            href.startsWith('mailto:') || 
            href.startsWith('tel:') || 
            href === '#') {
          return;
        }
        
        // Handle both absolute and relative URLs
        let resolvedUrl;
        
        if (href.match(/^https?:\/\//)) {
          // Absolute URL
          resolvedUrl = href;
        } else if (href.startsWith('/')) {
          // Root-relative URL
          try {
            const baseUrlObj = new URL(baseUrl);
            resolvedUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${href}`;
          } catch (e) {
            logger.warn(`[LINKS] Cannot resolve root-relative URL: ${href} with base ${baseUrl}`);
            return;
          }
        } else {
          // Relative URL - use URL constructor
          try {
            resolvedUrl = new URL(href, baseUrl).href;
          } catch (e) {
            logger.warn(`[LINKS] Cannot resolve relative URL: ${href} with base ${baseUrl}`);
            return;
          }
        }
        
        // Skip duplicates
        if (seenUrls.has(resolvedUrl)) return;
        seenUrls.add(resolvedUrl);
        
        // Check if this is a resource link (PDF, DOCX, etc.)
        const urlObj = new URL(resolvedUrl);
        const resourceParam = urlObj.searchParams.get('resource');
        
        if (resourceParam && this.isBinaryResource(resourceParam)) {
          // This is a binary resource link
          // Create a direct URL to the resource
          const directResourceUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
          
          // Enhanced logging for PDF tracking
          const ext = resourceParam.split('.').pop().toLowerCase();
          if (ext === 'pdf') {
            logger.info(`[PDF_TRACKING] Found PDF link: ${resourceParam}`);
            logger.info(`[PDF_TRACKING] Page URL: ${resolvedUrl}`);
            logger.info(`[PDF_TRACKING] Direct URL: ${directResourceUrl}`);
          } else if (ext === 'docx' || ext === 'doc') {
            logger.info(`[PDF_TRACKING] Found Word document link: ${resourceParam}`);
          } else {
            logger.info(`[LINKS] Found binary resource: ${resourceParam} at ${directResourceUrl}`);
          }
          
          // Add both the page URL and the resource URL
          links.push(resolvedUrl);
          totalAdded++;
          links.push(directResourceUrl);
          totalAdded++;
        } else {
          // Regular link
          links.push(resolvedUrl);
          totalAdded++;
        }
        
        // Store metadata for future use if needed
        const metadata = {
          text: $(el).text().trim(),
          title: $(el).attr('title') || '',
          isResource: !!resourceParam
        };
        // We could store this metadata somewhere if needed
      } catch (error) {
        logger.warn(`[LINKS] Error processing URL: ${href} - ${error.message}`);
      }
    });
    
    logger.info(`[LINKS] Found ${totalFound} links, added ${totalAdded} unique URLs from ${baseUrl}`);
    return links;
  }

  /**
   * Extract metadata from HTML
   * @param {Object} $ - Cheerio instance
   * @returns {Object} - Extracted metadata
   */
  extractMetadata($) {
    // Basic metadata - get only the FIRST title element to avoid concatenation
    const metadata = {
      title: $('title').first().text().trim(),
      description: $('meta[name="description"]').attr('content') || '',
      keywords: $('meta[name="keywords"]').attr('content') || '',
      author: $('meta[name="author"]').attr('content') || '',
      language: $('html').attr('lang') || '',
      canonical: $('link[rel="canonical"]').attr('href') || ''
    };
    
    // Open Graph metadata
    metadata.og_title = $('meta[property="og:title"]').attr('content') || '';
    metadata.og_description = $('meta[property="og:description"]').attr('content') || '';
    metadata.og_image = $('meta[property="og:image"]').attr('content') || '';
    metadata.og_type = $('meta[property="og:type"]').attr('content') || '';
    metadata.og_site_name = $('meta[property="og:site_name"]').attr('content') || '';
    
    // Twitter card metadata
    metadata.twitter_card = $('meta[name="twitter:card"]').attr('content') || '';
    metadata.twitter_title = $('meta[name="twitter:title"]').attr('content') || '';
    metadata.twitter_description = $('meta[name="twitter:description"]').attr('content') || '';
    metadata.twitter_image = $('meta[name="twitter:image"]').attr('content') || '';
    
    // Dublin Core metadata
    metadata.dc_title = $('meta[name="DC.title"]').attr('content') || '';
    metadata.dc_creator = $('meta[name="DC.creator"]').attr('content') || '';
    metadata.dc_subject = $('meta[name="DC.subject"]').attr('content') || '';
    metadata.dc_description = $('meta[name="DC.description"]').attr('content') || '';
    
    // Publication metadata
    metadata.published_date = $('meta[name="article:published_time"]').attr('content') || 
                            $('meta[property="article:published_time"]').attr('content') || 
                            $('meta[name="published_date"]').attr('content') || 
                            $('meta[name="date"]').attr('content') || '';
    
    metadata.modified_date = $('meta[name="article:modified_time"]').attr('content') || 
                           $('meta[property="article:modified_time"]').attr('content') || 
                           $('meta[name="modified_date"]').attr('content') || 
                           $('meta[name="last-modified"]').attr('content') || '';
    
    // Additional metadata - scan all meta tags to capture anything we missed
    $('meta').each((i, el) => {
      const name = $(el).attr('name') || $(el).attr('property');
      const content = $(el).attr('content');
      
      if (name && content && !metadata[name.replace(/[:.]/g, '_')]) {
        // Convert names with dots or colons to underscores for valid YAML
        const safeName = name.replace(/[:.]/g, '_').toLowerCase();
        metadata[safeName] = content;
      }
    });
    
    // Remove empty values
    Object.keys(metadata).forEach(key => {
      if (!metadata[key]) {
        delete metadata[key];
      }
    });
    
    return metadata;
  }

  /**
   * Apply heuristic classification to content blocks
   * @param {Object} $ - Cheerio instance
   * @param {Array} elements - Elements to classify
   * @param {Object} removedBlocks - Object to track removed blocks
   */
  applyHeuristicClassification($, elements, removedBlocks) {
    if (!elements || elements.length === 0) return;
    
    elements.forEach((el) => {
      const $el = $(el);
      
      // Skip empty elements
      if ($el.text().trim().length === 0 && !$el.find('img[src]').length) {
        $el.remove();
        
        if (this.debug && removedBlocks) {
          const selector = this.generateConsistentSelector($el);
          this.trackSelectorDecision(selector, 'remove', removedBlocks, 'Empty element');
        }
        return;
      }
      
      // Remove elements that look like navigation or boilerplate
      if (isLikelyNavigationOrBoilerplate($, el)) {
        $el.remove();
        
        if (this.debug && removedBlocks) {
          const selector = this.generateConsistentSelector($el);
          this.trackSelectorDecision(selector, 'remove', removedBlocks, 'Heuristic: Navigation or boilerplate');
        }
        return;
      }
      
      // Recursively apply to children
      this.applyHeuristicClassification($, $el.children().toArray(), removedBlocks);
    });
  }

  /**
   * Apply AI-based classification to content blocks
   * @param {Object} $ - Cheerio instance
   * @param {Object} main - Main content element
   * @param {Object} removedBlocks - Object to track removed blocks
   */
  async applyBlockClassification($, main, removedBlocks) {
    if (!main || main.length === 0) return;
    
    try {
      logger.info('[AI] Applying AI-based block classification');
      
      // Get all blocks to classify
      const blocks = main.children().toArray();
      
      // Skip if no blocks to classify
      if (blocks.length === 0) {
        logger.info('[AI] No blocks to classify');
        return;
      }
      
      // Prepare blocks for classification
      const blocksForAI = blocks.map((block, index) => {
        const $block = $(block);
        return {
          index,
          html: $.html($block),
          text: $block.text().trim(),
          selector: this.generateConsistentSelector($block)
        };
      });
      
      // Classify blocks with AI
      const classifiedBlocks = await classifyBlocksWithAI(blocksForAI, this.aiConfig);
      
      // Process classification results
      classifiedBlocks.forEach((result) => {
        const { index, classification, confidence } = result;
        const block = blocks[index];
        const $block = $(block);
        
        if (classification === 'remove' && confidence > 0.7) {
          $block.remove();
          
          if (this.debug && removedBlocks) {
            const selector = this.generateConsistentSelector($block);
            this.trackSelectorDecision(selector, 'remove', removedBlocks, 
              `AI classification: ${classification} (confidence: ${confidence.toFixed(2)})`);
            
            removedBlocks.aiClassifiedBlocks.push({
              selector,
              html: $.html($block),
              classification,
              confidence
            });
          }
        }
      });
      
      logger.info('[AI] Block classification complete');
    } catch (error) {
      logger.error('[AI] Error applying block classification:', error);
    }
  }

  /**
   * Generate a consistent CSS selector for an element
   * @param {Object} element - Element to generate selector for
   * @returns {String} - CSS selector
   */
  generateConsistentSelector(element) {
    return generateConsistentSelector(null, element);
  }
  
  /**
   * Save debug information to the debug folder
   * @param {string} url - URL of the page
   * @param {Object} $ - Cheerio instance
   * @param {Object} main - Main content element
   * @param {Object} removedBlocks - Object with debug tracking information
   */
  /**
   * Generates debug markdown content showing what was kept and removed
   * @param {Object} $ - Cheerio object
   * @param {Object} main - Main content element
   * @param {Object} removedBlocks - Tracking object for removed blocks
   * @param {string} url - URL of the page
   * @returns {string} - Debug markdown content
   */
  generateDebugMarkdown($, main, removedBlocks, url) {
    // Create a markdown report with frontmatter
    let debugMarkdown = '---\n';
    
    // Add metadata
    debugMarkdown += `url: "${url}"\n`;
    debugMarkdown += `timestamp: "${new Date().toISOString()}"\n`;
    debugMarkdown += `content_length: ${main ? main.html().length : 0}\n`;
    debugMarkdown += `original_length: ${$.html().length}\n`;
    debugMarkdown += `reduction_percent: ${main ? ((1 - (main.html().length / $.html().length)) * 100).toFixed(2) : 0}\n`;
    debugMarkdown += '---\n\n';
    
    // Add summary
    debugMarkdown += `# Debug Report for ${url}\n\n`;
    debugMarkdown += '## Content Statistics\n\n';
    debugMarkdown += `- **Original Length:** ${$.html().length} characters\n`;
    debugMarkdown += `- **Content Length:** ${main ? main.html().length : 0} characters\n`;
    debugMarkdown += `- **Reduction:** ${main ? ((1 - (main.html().length / $.html().length)) * 100).toFixed(2) : 0}%\n\n`;
    
    // Add selector decisions
    debugMarkdown += '## Selector Decisions\n\n';
    debugMarkdown += '| Selector | Decision | Reason | Content Preview |\n';
    debugMarkdown += '| --- | --- | --- | --- |\n';
    
    // Process selector decisions to make them more meaningful
    if (removedBlocks && removedBlocks.selectorDecisions) {
      // Sort decisions by selector path depth (deeper paths first) to show the most specific decisions
      const decisions = Array.from(removedBlocks.selectorDecisions.entries());
      decisions.sort((a, b) => {
        // Count selector depth by number of spaces or > characters
        const depthA = (a[0].match(/ |>/g) || []).length;
        const depthB = (b[0].match(/ |>/g) || []).length;
        return depthB - depthA; // Sort by depth, deepest first
      });
      
      // Only include the most specific decisions (avoid redundant parent elements)
      const processedSelectors = new Set();
      
      decisions.forEach(([selector, info]) => {
        // Skip high-level container selectors that don't provide useful information
        if (selector === 'body' || selector === 'html' || selector === '#__nuxt' || selector === '#__layout') {
          return;
        }
        
        // Check if this selector is a child of an already processed selector
        let isChild = false;
        for (const processed of processedSelectors) {
          if (selector.includes(processed) && selector !== processed) {
            isChild = true;
            break;
          }
        }
        
        // Only add if it's not a child of an already processed selector
        if (!isChild) {
          processedSelectors.add(selector);
          
          // Get a preview of the element's content
          let contentPreview = '';
          try {
            const el = $(selector);
            if (el.length > 0) {
              // Get text content, trim and limit length
              contentPreview = el.text().trim().substring(0, 30);
              if (contentPreview.length === 30) contentPreview += '...';
              // Escape pipe characters that would break markdown tables
              contentPreview = contentPreview.replace(/\|/g, '\\|');
            }
          } catch (e) {
            contentPreview = 'Error getting preview';
          }
          
          debugMarkdown += `| ${selector} | ${info.decision} | ${info.reason} | ${contentPreview} |\n`;
        }
      });
    }
    
    // Add kept content section
    debugMarkdown += '\n## Kept Content\n\n';
    debugMarkdown += '```html\n';
    debugMarkdown += main ? main.html() : 'No content kept';
    debugMarkdown += '\n```\n';
    
    // Add removed content section if available
    if (removedBlocks && removedBlocks.removedHtml) {
      debugMarkdown += '\n## Removed Content (Sample)\n\n';
      debugMarkdown += '```html\n';
      // Limit the size of removed content to avoid huge files
      const removedSample = removedBlocks.removedHtml.length > 5000 ? 
        removedBlocks.removedHtml.substring(0, 5000) + '... (truncated)' : 
        removedBlocks.removedHtml;
      debugMarkdown += removedSample;
      debugMarkdown += '\n```\n';
    }
    
    return debugMarkdown;
  }

  saveDebugInfo(url, $, main, removedBlocks) {
    if (!this.debug || !this.debugDir) return;
    
    try {
      // Parse the URL
      const urlObj = new URL(url);
      
      // Get the filename from the crawl_service by examining the saved file path
      // Extract path from URL and handle internationalized characters
      let pathname = urlObj.pathname;
      
      // Decode URI components to handle non-ASCII characters
      try {
        pathname = decodeURIComponent(pathname);
      } catch (e) {
        // If decoding fails, use the original pathname
        logger.warn(`[DEBUG] Failed to decode pathname: ${pathname}`);
      }
      
      // Remove leading and trailing slashes
      pathname = pathname.replace(/^\/+|\/+$/g, '');
      
      // Use pathname as the filename, preserving directory structure
      const filename = pathname || 'index';
      
      // Generate debug markdown content
      const debugMarkdown = this.generateDebugMarkdown($, main, removedBlocks, url);
      
      // Create the debug file path that matches the content file structure
      // If filename contains path separators, preserve the directory structure
      let debugFilePath;
      if (filename.includes('/')) {
        // Split the filename into directory path and actual filename
        const lastSlashIndex = filename.lastIndexOf('/');
        const dirPath = filename.substring(0, lastSlashIndex);
        const actualFilename = filename.substring(lastSlashIndex + 1);
        
        // Create the full directory path in the debug folder
        const fullDebugDirPath = path.join(this.debugDir, dirPath);
        
        // Create the directory if it doesn't exist
        if (!fs.existsSync(fullDebugDirPath)) {
          fs.mkdirSync(fullDebugDirPath, { recursive: true });
        }
        
        debugFilePath = path.join(this.debugDir, dirPath, `${actualFilename}.md`);
      } else {
        // No path separators, just use the filename directly
        debugFilePath = path.join(this.debugDir, `${filename}.md`);
      }
      
      // Ensure the directory exists
      const debugDir = path.dirname(debugFilePath);
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      
      // Save the debug markdown file
      fs.writeFileSync(debugFilePath, debugMarkdown);
      
      logger.info(`[DEBUG] Saved debug report to ${debugFilePath}`);
    } catch (err) {
      logger.error(`[DEBUG] Error saving debug information: ${err.message}`);
    }
  }
}
