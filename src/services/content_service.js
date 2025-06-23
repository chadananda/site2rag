import {load} from 'cheerio';
import {aiServiceAvailable, classifyBlocksWithAI} from '../utils/ai_utils.js';
import {generateFullSelectorPath, analyzeSelectorPath, isLikelyFrameworkWrapper} from '../utils/dom_utils.js';
import path from 'path';
import fs from 'fs';
import {URL} from 'url';
import logger from './logger_service.js';

// === Content Extraction Functions (merged from content_extractor.js) ===

/**
 * Score an element based on its content characteristics
 * @param {Object} $ - Cheerio instance
 * @param {Object} element - Element to score
 * @returns {Number} - Content score
 */
export function scoreContentElement($, element) {
  let score = 0;
  // Text metrics (more text = more likely to be content)
  const text = $(element).text().trim();
  const textLength = text.length;
  score += Math.min(20, textLength / 100);
  // Content density (paragraphs per text length)
  const paragraphs = $(element).find('p').length;
  if (paragraphs > 0) {
    const paragraphDensity = paragraphs / (textLength / 500);
    score += Math.min(15, paragraphDensity * 5);
  }
  // Presence of headings (h1-h6) indicates structured content
  const headings = $(element).find('h1, h2, h3, h4, h5, h6').length;
  score += headings * 5;
  // Link density (too many links = navigation, not content)
  const links = $(element).find('a').length;
  const linkText = $(element).find('a').text().length;
  const linkDensity = textLength > 0 ? linkText / textLength : 0;
  score -= Math.min(20, linkDensity * 50);
  // Semantic elements boost
  if ($(element).is('article, main, .content, [role="main"]')) {
    score += 25;
  }
  // Class/ID name patterns
  const className = $(element).attr('class') || '';
  const idName = $(element).attr('id') || '';
  const fullName = (className + ' ' + idName).toLowerCase();
  // Positive patterns
  const contentPatterns = ['content', 'article', 'post', 'body', 'entry', 'main', 'text'];
  for (const pattern of contentPatterns) {
    if (fullName.includes(pattern)) {
      score += 10;
      break;
    }
  }
  // Negative patterns
  const navPatterns = ['nav', 'menu', 'sidebar', 'foot', 'header', 'comment', 'widget', 'share', 'related'];
  for (const pattern of navPatterns) {
    if (fullName.includes(pattern)) {
      score -= 15;
      break;
    }
  }
  return score;
}

// === Framework Handler Functions (merged from framework_handler.js) ===

/**
 * Identifies and handles framework-specific wrappers in the DOM
 * @param {Object} $ - Cheerio instance
 * @param {Object} body - Body element
 * @param {Object} options - Options object
 * @returns {Object} - Object containing identified semantic sections
 */
export function handleFrameworkWrappers($, body, options = {}) {
  const debug = options.debug || false;
  const removedBlocks = options.removedBlocks || null;
  logger.info('[FRAMEWORK] Analyzing DOM for framework-specific wrappers');
  // Track decisions if we're in debug mode
  const trackDecision = (selector, decision, reason) => {
    if (debug && removedBlocks && removedBlocks.selectorDecisions) {
      if (typeof removedBlocks.trackSelectorDecision === 'function') {
        removedBlocks.trackSelectorDecision(selector, decision, removedBlocks, reason);
      } else if (typeof options.trackSelectorDecision === 'function') {
        options.trackSelectorDecision(selector, decision, removedBlocks, reason);
      }
    }
  };
  // Find framework wrappers (common patterns in modern JS frameworks)
  const frameworkWrappers = [
    // Nuxt.js
    '#__nuxt',
    '#__layout',
    '#nuxt',
    '.nuxt',
    '[data-v-app]',
    // Next.js
    '#__next',
    '#next',
    // React
    '#root',
    '#app-root',
    '#react-root',
    // Vue
    '#app',
    '.app',
    '[data-v-app]',
    // Angular
    'app-root',
    '[ng-app]',
    '[ng-controller]',
    // Generic
    '.wrapper',
    '.container',
    '.app-container',
    '.page-wrapper'
  ];
  // Find semantic sections regardless of nesting
  const semanticSections = {
    header: null,
    nav: null,
    main: null,
    article: null,
    footer: null,
    content: null
  };
  // Function to recursively search for semantic elements
  const findSemanticElements = (element, depth = 0, path = []) => {
    // Skip if we've gone too deep
    if (depth > 10) return;
    $(element)
      .children()
      .each((i, child) => {
        const $child = $(child);
        const tagName = $child.prop('tagName')?.toLowerCase();
        const id = $child.attr('id') || '';
        const className = $child.attr('class') || '';
        const currentPath = [
          ...path,
          tagName + (id ? `#${id}` : '') + (className ? `.${className.replace(/\s+/g, '.')}` : '')
        ];
        // Check for semantic elements
        if (tagName === 'header' && !semanticSections.header) {
          semanticSections.header = $child;
          trackDecision(currentPath.join(' > '), 'identify', 'Semantic header element');
        } else if (
          (tagName === 'nav' || className.includes('nav') || className.includes('menu')) &&
          !semanticSections.nav
        ) {
          semanticSections.nav = $child;
          trackDecision(currentPath.join(' > '), 'identify', 'Navigation element');
        } else if (tagName === 'main' && !semanticSections.main) {
          semanticSections.main = $child;
          trackDecision(currentPath.join(' > '), 'identify', 'Semantic main element');
        } else if (tagName === 'article' && !semanticSections.article) {
          semanticSections.article = $child;
          trackDecision(currentPath.join(' > '), 'identify', 'Semantic article element');
        } else if (tagName === 'footer' && !semanticSections.footer) {
          semanticSections.footer = $child;
          trackDecision(currentPath.join(' > '), 'identify', 'Semantic footer element');
        } else if (
          !semanticSections.content &&
          (className.includes('content') || id.includes('content') || className.includes('main') || id.includes('main'))
        ) {
          // Check if this is a substantial content element
          const text = $child.text().trim();
          const hasContentElements = $child.find('p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol').length > 0;
          if ((text.length > 200 || hasContentElements) && !isNavigationElement($child)) {
            semanticSections.content = $child;
            trackDecision(currentPath.join(' > '), 'identify', 'Content container element');
          }
        }
        // Recursively search in children
        findSemanticElements(child, depth + 1, currentPath);
      });
  };
  // Helper function to check if an element is likely navigation
  const isNavigationElement = $el => {
    // Check for navigation indicators
    const tagName = $el.prop('tagName')?.toLowerCase();
    const className = $el.attr('class') || '';
    const id = $el.attr('id') || '';
    const role = $el.attr('role') || '';
    // Check for navigation indicators
    if (tagName === 'nav' || role === 'navigation') return true;
    if (/nav|menu|sidebar|header|footer/i.test(className) || /nav|menu|sidebar|header|footer/i.test(id)) return true;
    // Check for link density
    const text = $el.text().trim();
    const linkText = $el.find('a').text().trim();
    const linkRatio = text.length > 0 ? linkText.length / text.length : 0;
    // If more than 70% of text is in links, it's likely navigation
    return linkRatio > 0.7;
  };
  // Start by looking for framework wrappers
  let frameworkWrapper = null;
  for (const selector of frameworkWrappers) {
    const $wrapper = $(selector);
    if ($wrapper.length > 0) {
      frameworkWrapper = $wrapper;
      logger.info(`[FRAMEWORK] Found framework wrapper: ${selector}`);
      trackDecision(selector, 'identify', 'Framework wrapper element');
      break;
    }
  }
  // If we found a framework wrapper, start searching from there
  // Otherwise, start from body
  const startElement = frameworkWrapper || body;
  findSemanticElements(startElement);
  // Log what we found
  Object.entries(semanticSections).forEach(([type, element]) => {
    if (element) {
      logger.info(`[FRAMEWORK] Found ${type} element: ${element.prop('tagName')}`);
    }
  });
  return semanticSections;
}

/**
 * Extracts the main content from a page with framework-specific wrappers
 * @param {Object} $ - Cheerio instance
 * @param {Object} body - Body element
 * @param {Object} options - Options object
 * @returns {Object} - The extracted main content element
 */
export function extractMainContent($, body, options = {}) {
  const debug = options.debug || false;
  const removedBlocks = options.removedBlocks || null;
  logger.info('[FRAMEWORK] Starting content extraction with tree-walking approach');
  // Track decisions if we're in debug mode
  const trackDecision = (selector, decision, reason) => {
    if (debug && removedBlocks && typeof options.trackSelectorDecision === 'function') {
      options.trackSelectorDecision(selector, decision, removedBlocks, reason);
    }
  };
  // First try to find semantic content elements
  const semanticSections = handleFrameworkWrappers($, body, options);
  // If we found semantic content, use it
  let mainContent = semanticSections.main || semanticSections.article || semanticSections.content;
  // If we found content through semantic elements, use it
  if (mainContent && mainContent.length > 0) {
    logger.info('[FRAMEWORK] Found content through semantic elements');
    const selectorPath = generateFullSelectorPath($, mainContent);
    trackDecision(selectorPath, 'keep', 'Semantic content element');
    // Create a clean container for the content
    const contentContainer = $('<div class="site2rag-content-container"></div>');
    contentContainer.append(mainContent.clone());
    // Remove any nested navigation elements
    contentContainer.find('nav, header, footer, [role="navigation"]').each((i, el) => {
      const $el = $(el);
      const navPath = generateFullSelectorPath($, $el);
      trackDecision(navPath, 'remove', 'Navigation element inside content');
      $el.remove();
    });
    return contentContainer;
  }
  // If no semantic content was found, try our tree-walking approach
  logger.info('[FRAMEWORK] No semantic content found, trying tree-walking approach');
  // Store content candidates with their scores
  const contentCandidates = [];
  // Walk the DOM tree to find content candidates
  const walkTree = (element, depth = 0) => {
    if (depth > 10) return; // Prevent infinite recursion
    // Skip invisible elements
    if (element.css('display') === 'none' || element.css('visibility') === 'hidden') {
      return;
    }
    // Get the full selector path for this element
    const selectorPath = generateFullSelectorPath($, element);
    // Analyze the selector path
    const analysis = analyzeSelectorPath(selectorPath);
    // Skip framework wrappers for content scoring
    const frameworkAnalysis = isLikelyFrameworkWrapper(selectorPath);
    if (frameworkAnalysis.isFramework) {
      // Log the framework detection
      logger.info(`[FRAMEWORK] Detected framework wrapper: ${selectorPath} (score: ${frameworkAnalysis.score})`);
      if (debug) {
        trackDecision(
          selectorPath,
          'framework',
          `Framework wrapper detected: ${frameworkAnalysis.detectedPatterns.join(', ')}`
        );
      }
      // But still check their children
      element.children().each((i, child) => {
        walkTree($(child), depth + 1);
      });
      return;
    }
    // Calculate content score based on various factors
    let contentScore = 0;
    // 1. Text length (more text = more likely to be content)
    const text = element.text().trim();
    contentScore += Math.min(10, text.length / 100);
    // 2. Paragraph density
    const paragraphs = element.find('p').length;
    contentScore += paragraphs * 2;
    // 3. Heading presence
    const headings = element.find('h1, h2, h3, h4, h5, h6').length;
    contentScore += headings * 3;
    // 4. Content elements presence
    const contentElements = element.find('blockquote, pre, code, table').length;
    contentScore += contentElements * 2;
    // 5. Image presence (with some content)
    if (element.find('img').length > 0 && text.length > 50) {
      contentScore += 2;
    }
    // 6. Link density (high link density = less likely to be main content)
    const links = element.find('a');
    const linkText = links.text().trim();
    const linkRatio = text.length > 0 ? linkText.length / text.length : 0;
    contentScore -= linkRatio * 10;
    // 7. Add score from selector analysis
    contentScore += analysis.contentScore * 2;
    contentScore -= analysis.navigationScore * 2;
    // 8. Depth penalty (slight preference for elements closer to root)
    contentScore -= depth * 0.5;
    // Add this element as a candidate if it has a reasonable score
    if (contentScore > 5 && text.length > 100) {
      contentCandidates.push({
        element,
        score: contentScore,
        selectorPath,
        textLength: text.length,
        paragraphs,
        headings
      });
    }
    // Always check children unless this is clearly navigation
    if (analysis.type !== 'navigation' || analysis.confidence < 0.7) {
      element.children().each((i, child) => {
        walkTree($(child), depth + 1);
      });
    }
  };
  // Start walking from body children to avoid the body itself
  body.children().each((i, child) => {
    walkTree($(child));
  });
  // Sort candidates by score (descending)
  contentCandidates.sort((a, b) => b.score - a.score);
  // Log top candidates for debugging
  if (contentCandidates.length > 0) {
    logger.info('[FRAMEWORK] Top content candidates:');
    contentCandidates.slice(0, 3).forEach((candidate, i) => {
      logger.info(
        `[FRAMEWORK] Candidate ${i + 1}: Score ${candidate.score.toFixed(1)}, Text length: ${candidate.textLength}, Path: ${candidate.selectorPath}`
      );
    });
  }
  // Use the highest scoring candidate
  if (contentCandidates.length > 0) {
    const bestCandidate = contentCandidates[0];
    logger.info(`[FRAMEWORK] Selected best candidate: ${bestCandidate.selectorPath}`);
    // Track this decision
    trackDecision(
      bestCandidate.selectorPath,
      'keep',
      `Best content candidate (score: ${bestCandidate.score.toFixed(1)})`
    );
    // Create a clean container
    const contentContainer = $('<div class="site2rag-content-container"></div>');
    contentContainer.append(bestCandidate.element.clone());
    // Remove any nested navigation elements
    contentContainer.find('nav, header, footer, [role="navigation"]').each((i, el) => {
      const $el = $(el);
      const navPath = generateFullSelectorPath($, $el);
      trackDecision(navPath, 'remove', 'Navigation element inside content');
      $el.remove();
    });
    return contentContainer;
  }
  // If we couldn't find any content, return null
  logger.info('[FRAMEWORK] No suitable content candidates found');
  return null;
}

/**
 * Check if an element is likely navigation or boilerplate
 * @param {Object} $ - Cheerio instance
 * @param {Object} element - Element to check
 * @returns {Boolean} - True if likely navigation/boilerplate
 */
export function isLikelyNavigationOrBoilerplate($, element) {
  const $el = $(element);
  // Check tag name
  const tagName = $el.prop('tagName')?.toLowerCase();
  if (['nav', 'header', 'footer', 'aside'].includes(tagName)) {
    return true;
  }
  // Check role attribute
  const role = $el.attr('role')?.toLowerCase();
  if (['navigation', 'banner', 'contentinfo'].includes(role)) {
    return true;
  }
  // Check class/id patterns
  const className = $el.attr('class') || '';
  const idName = $el.attr('id') || '';
  const fullName = (className + ' ' + idName).toLowerCase();
  const navPatterns = [
    'nav',
    'navigation',
    'menu',
    'sidebar',
    'widget',
    'header',
    'footer',
    'foot',
    'comment',
    'share',
    'related',
    'social',
    'meta',
    'breadcrumb',
    'pagination'
  ];
  for (const pattern of navPatterns) {
    if (fullName.includes(pattern)) {
      return true;
    }
  }
  // Check link density
  const text = $el.text().trim();
  const textLength = text.length;
  if (textLength > 20) {
    const links = $el.find('a').length;
    const linkText = $el.find('a').text().length;
    const linkDensity = textLength > 0 ? linkText / textLength : 0;
    // High link density indicates navigation
    if (linkDensity > 0.5) {
      return true;
    }
  }
  return false;
}

/**
 * Generate a consistent CSS selector for an element
 * @param {Object} $ - Cheerio instance
 * @param {Object} element - Element to generate selector for
 * @returns {String} - CSS selector
 */
export function generateConsistentSelector($, element) {
  // If $ is null, element is already a cheerio object
  const $el = $ ? $(element) : element;
  // Try ID first
  const id = $el.attr('id');
  if (id) {
    return `#${id}`;
  }
  // Try tag + class
  const tagName = $el.prop('tagName')?.toLowerCase();
  const className = $el.attr('class');
  if (className) {
    // Use first class only for simplicity
    const firstClass = className.split(' ')[0];
    return `${tagName}.${firstClass}`;
  }
  // Fallback to tag name
  return tagName || 'unknown';
}

/**
 * Clean up extracted content by removing nested navigation elements
 * @param {Object} $ - Cheerio instance
 * @param {Object} content - Content element to clean
 * @param {Object} options - Options for cleanup
 * @returns {Object} - Cleaned content
 */
export function cleanupContent($, content, options = {}) {
  const debug = options.debug || false;
  const removedBlocks = options.removedBlocks;
  const trackSelectorDecision = options.trackSelectorDecision;
  // Track removed HTML for debug purposes
  if (debug && removedBlocks) {
    removedBlocks.removedHtml = removedBlocks.removedHtml || '';
  }
  // Process elements in a hierarchical manner to avoid unnecessary traversal
  const processElement = el => {
    const $el = $(el);
    const tagName = $el.prop('tagName')?.toLowerCase();
    // Remove script, style, and other non-content elements
    if (['script', 'style', 'noscript', 'iframe'].includes(tagName)) {
      if (debug && removedBlocks) {
        removedBlocks.removedHtml += $el.toString();
      }
      if (debug && trackSelectorDecision) {
        const selector = generateConsistentSelector($, $el);
        trackSelectorDecision(selector, 'remove', removedBlocks, `Non-content element: ${tagName}`);
      }
      $el.remove();
      return true;
    }
    // Skip processing links, images, and inline elements - we want to preserve these
    if (['a', 'img', 'span', 'strong', 'em', 'b', 'i', 'u', 'code', 'br', 'hr'].includes(tagName)) {
      return false;
    }
    // Handle common container elements that should be processed as a unit
    if (['svg', 'use', 'path', 'g', 'rect', 'circle'].includes(tagName)) {
      if (tagName === 'svg') {
        if ($el.text().trim().length === 0) {
          if (debug && removedBlocks) {
            removedBlocks.removedHtml += $el.toString();
          }
          if (debug && trackSelectorDecision) {
            const selector = generateConsistentSelector($, $el);
            trackSelectorDecision(selector, 'remove', removedBlocks, 'Empty element');
          }
          $el.remove();
          return true;
        }
      }
      return false;
    }
    // Skip if this is an empty element (but keep images)
    if ($el.text().trim().length === 0 && !$el.find('img[src]').length) {
      if (debug && removedBlocks) {
        removedBlocks.removedHtml += $el.toString();
      }
      if (debug && trackSelectorDecision) {
        const selector = generateConsistentSelector($, $el);
        trackSelectorDecision(selector, 'remove', removedBlocks, 'Empty element');
      }
      $el.remove();
      return true;
    }
    // Only remove navigation/boilerplate elements that aren't direct content containers
    if (isLikelyNavigationOrBoilerplate($, el)) {
      const textLength = $el.text().trim().length;
      if (textLength < 100 || tagName === 'nav' || tagName === 'header' || tagName === 'footer') {
        if (debug && removedBlocks) {
          removedBlocks.removedHtml += $el.toString();
        }
        if (debug && trackSelectorDecision) {
          const selector = generateConsistentSelector($, $el);
          trackSelectorDecision(selector, 'remove', removedBlocks, 'Navigation or boilerplate element');
        }
        $el.remove();
        return true;
      }
    }
    return false;
  };
  // Process elements in a breadth-first manner to handle parent elements first
  const processElementsHierarchically = rootEl => {
    const queue = [rootEl];
    while (queue.length > 0) {
      const currentEl = queue.shift();
      const $currentEl = $(currentEl);
      const wasRemoved = processElement(currentEl);
      if (!wasRemoved) {
        $currentEl.children().each((_, childEl) => {
          queue.push(childEl);
        });
      }
    }
  };
  // Start processing from the content root
  processElementsHierarchically(content[0]);
  return content;
}

// Alias for backward compatibility
export const extractGenericContent = extractMainContent;

// === End Content Extraction Functions ===

/**
 * Service for HTML content processing, extraction, and classification
 */
export class ContentService {
  /**
   * Creates a new ContentService instance
   * @param {Object} options - Configuration options
   * @param {Object} options.aiConfig - AI service configuration
   * @param {Object} options.db - Database instance for page persistence
   */
  constructor(options = {}) {
    this.aiConfig = options.aiConfig || null;
    this.debug = options.debug || false;
    this.outputDir = options.outputDir || './output';
    this.db = options.db || null; // Store database instance for crawl service access

    // Create debug directory if debug mode is enabled
    if (this.debug) {
      this.debugDir = path.join(this.outputDir, '.site2rag', 'debug');
      logger.info(`[DEBUG] Debug mode enabled, debug info will be saved to ${this.debugDir}`);
      try {
        fs.mkdirSync(this.debugDir, {recursive: true});
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
      removedBlocks = {selectorDecisions: new Map()};
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
      return {$, main: null, links, metadata, removedBlocks};
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
      this.trackSelectorDecision(
        '--phase-separator--',
        'info',
        removedBlocks,
        'Above: Initial boilerplate removal | Below: Content classification'
      );

      // Save debug information if URL is provided
      if (url) {
        this.saveDebugInfo(url, $, cleanedMain, removedBlocks);
      }
    }

    return {$, html: $.html(cleanedMain), main: cleanedMain, links, metadata, removedBlocks};
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
        'article',
        'main',
        '[role="main"]',
        '.content',
        '#content',
        '.main-content',
        '#main-content',
        '.post-content',
        '.entry-content',
        '.article-content'
      ];

      for (const selector of commonSelectors) {
        const element = $(selector).first();
        if (element.length > 0 && element.text().trim().length > 100) {
          logger.info(`[CONTENT] Found content using selector: ${selector}`);
          return element;
        }
      }

      // Fallback 2: Find the element with the most paragraph tags
      const containers = $('div, section').filter(function () {
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
      removedBlocks.selectorDecisions.set(selector, {decision, reason});
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
      const {hostname} = new URL(baseUrl);
      const documentDownloads = [];

      // Find all links in the main content
      $(main)
        .find('a[href]')
        .each((i, el) => {
          const href = $(el).attr('href');
          if (!href) return;

          try {
            // Skip fragment-only links, javascript:, mailto:, tel:, etc.
            if (
              href.startsWith('#') ||
              href.startsWith('javascript:') ||
              href.startsWith('mailto:') ||
              href.startsWith('tel:')
            ) {
              return;
            }

            // Check if this is a PDF or DOCX link
            const isPdfOrDocx = href.toLowerCase().endsWith('.pdf') || href.toLowerCase().endsWith('.docx');

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
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.odt',
      '.ods',
      '.odp',
      '.rtf',

      // Archive formats
      '.zip',
      '.rar',
      '.7z',
      '.tar',
      '.gz',

      // Media formats
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.bmp',
      '.svg',
      '.mp3',
      '.mp4',
      '.wav',
      '.avi',
      '.mov'
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

    $(element)
      .find('a[href]')
      .each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        totalFound++;

        try {
          // Skip javascript: links, mailto:, tel:, etc.
          if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:') || href === '#') {
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
    metadata.published_date =
      $('meta[name="article:published_time"]').attr('content') ||
      $('meta[property="article:published_time"]').attr('content') ||
      $('meta[name="published_date"]').attr('content') ||
      $('meta[name="date"]').attr('content') ||
      '';

    metadata.modified_date =
      $('meta[name="article:modified_time"]').attr('content') ||
      $('meta[property="article:modified_time"]').attr('content') ||
      $('meta[name="modified_date"]').attr('content') ||
      $('meta[name="last-modified"]').attr('content') ||
      '';

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

    elements.forEach(el => {
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
      classifiedBlocks.forEach(result => {
        const {index, classification, confidence} = result;
        const block = blocks[index];
        const $block = $(block);

        if (classification === 'remove' && confidence > 0.7) {
          $block.remove();

          if (this.debug && removedBlocks) {
            const selector = this.generateConsistentSelector($block);
            this.trackSelectorDecision(
              selector,
              'remove',
              removedBlocks,
              `AI classification: ${classification} (confidence: ${confidence.toFixed(2)})`
            );

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
    debugMarkdown += `reduction_percent: ${main ? ((1 - main.html().length / $.html().length) * 100).toFixed(2) : 0}\n`;
    debugMarkdown += '---\n\n';

    // Add summary
    debugMarkdown += `# Debug Report for ${url}\n\n`;
    debugMarkdown += '## Content Statistics\n\n';
    debugMarkdown += `- **Original Length:** ${$.html().length} characters\n`;
    debugMarkdown += `- **Content Length:** ${main ? main.html().length : 0} characters\n`;
    debugMarkdown += `- **Reduction:** ${main ? ((1 - main.html().length / $.html().length) * 100).toFixed(2) : 0}%\n\n`;

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
      const removedSample =
        removedBlocks.removedHtml.length > 5000
          ? removedBlocks.removedHtml.substring(0, 5000) + '... (truncated)'
          : removedBlocks.removedHtml;
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
          fs.mkdirSync(fullDebugDirPath, {recursive: true});
        }

        debugFilePath = path.join(this.debugDir, dirPath, `${actualFilename}.md`);
      } else {
        // No path separators, just use the filename directly
        debugFilePath = path.join(this.debugDir, `${filename}.md`);
      }

      // Ensure the directory exists
      const debugDir = path.dirname(debugFilePath);
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, {recursive: true});
      }

      // Save the debug markdown file
      fs.writeFileSync(debugFilePath, debugMarkdown);

      logger.info(`[DEBUG] Saved debug report to ${debugFilePath}`);
    } catch (err) {
      logger.error(`[DEBUG] Error saving debug information: ${err.message}`);
    }
  }
}
