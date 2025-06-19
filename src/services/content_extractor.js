/**
 * Generic Content Extractor
 * Framework-agnostic approach to extract main content from HTML pages
 * Focuses on content characteristics rather than specific frameworks or structures
 */

import logger from './logger_service.js';

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
    'nav', 'navigation', 'menu', 'sidebar', 'widget', 
    'header', 'footer', 'foot', 'comment', 'share',
    'related', 'social', 'meta', 'breadcrumb', 'pagination'
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
 * Recursively analyze DOM tree to find best content candidate
 * @param {Object} $ - Cheerio instance
 * @param {Object} root - Root element to start analysis from
 * @param {Object} options - Options for analysis
 * @returns {Object} - Best content candidate
 */
function analyzeContentTree($, root, options = {}) {
  const candidates = [];
  const debug = options.debug || false;
  const removedBlocks = options.removedBlocks;
  const trackSelectorDecision = options.trackSelectorDecision;
  
  // Helper function to recursively score elements
  const scoreElement = (element, depth = 0) => {
    if (depth > 10) return; // Avoid infinite recursion
    
    const $el = $(element);
    
    // Skip tiny elements or elements with no text
    const text = $el.text().trim();
    if (text.length < 20) return;
    
    // Skip likely navigation or boilerplate
    if (isLikelyNavigationOrBoilerplate($, element)) {
      if (debug && trackSelectorDecision) {
        const selector = generateConsistentSelector($, $el);
        trackSelectorDecision(selector, 'skip', removedBlocks, 'Likely navigation or boilerplate');
      }
      return;
    }
    
    // Score this element
    const score = scoreContentElement($, element);
    
    // Add to candidates if score is positive
    if (score > 0) {
      candidates.push({
        element: $el,
        score: score
      });
    }
    
    // Recursively score children
    $el.children().each((i, child) => {
      scoreElement(child, depth + 1);
    });
  };
  
  // Start recursive scoring from root
  scoreElement(root);
  
  // Sort candidates by score (descending)
  candidates.sort((a, b) => b.score - a.score);
  
  // Return the highest scoring candidate, or null if none found
  return candidates.length > 0 ? candidates[0].element : null;
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
  let removedHtml = '';
  if (debug && removedBlocks) {
    removedBlocks.removedHtml = removedBlocks.removedHtml || '';
  }
  
  // Process elements in a hierarchical manner to avoid unnecessary traversal
  const processElement = (el) => {
    const $el = $(el);
    const tagName = $el.prop('tagName')?.toLowerCase();
    
    // Remove script, style, and other non-content elements
    if (['script', 'style', 'noscript', 'iframe'].includes(tagName)) {
      // Before removing, capture the HTML for debug
      if (debug && removedBlocks) {
        removedBlocks.removedHtml += $el.toString();
      }
      
      if (debug && trackSelectorDecision) {
        const selector = generateConsistentSelector($, $el);
        trackSelectorDecision(selector, 'remove', removedBlocks, `Non-content element: ${tagName}`);
      }
      $el.remove();
      return true; // Element was removed
    }
    
    // Skip processing links, images, and inline elements - we want to preserve these
    if (['a', 'img', 'span', 'strong', 'em', 'b', 'i', 'u', 'code', 'br', 'hr'].includes(tagName)) {
      return false; // Don't remove
    }
    
    // Handle common container elements that should be processed as a unit
    if (['svg', 'use', 'path', 'g', 'rect', 'circle'].includes(tagName)) {
      // For SVG elements, make decision at the top SVG level only
      if (tagName === 'svg') {
        // Check if this is an empty or decorative SVG
        if ($el.text().trim().length === 0) {
          // Before removing, capture the HTML for debug
          if (debug && removedBlocks) {
            removedBlocks.removedHtml += $el.toString();
          }
          
          if (debug && trackSelectorDecision) {
            const selector = generateConsistentSelector($, $el);
            trackSelectorDecision(selector, 'remove', removedBlocks, 'Empty element');
          }
          $el.remove();
          return true; // Element was removed
        }
      }
      // If not a top-level SVG, skip individual processing
      return false;
    }
    
    // Skip if this is an empty element (but keep images)
    if ($el.text().trim().length === 0 && !$el.find('img[src]').length) {
      // Before removing, capture the HTML for debug
      if (debug && removedBlocks) {
        removedBlocks.removedHtml += $el.toString();
      }
      
      if (debug && trackSelectorDecision) {
        const selector = generateConsistentSelector($, $el);
        trackSelectorDecision(selector, 'remove', removedBlocks, 'Empty element');
      }
      $el.remove();
      return true; // Element was removed
    }
    
    // Only remove navigation/boilerplate elements that aren't direct content containers
    if (isLikelyNavigationOrBoilerplate($, el)) {
      // Don't remove elements that contain significant text or links we want to preserve
      const textLength = $el.text().trim().length;
      
      // If it's a small element or clearly navigation, remove it
      if (textLength < 100 || 
          (tagName === 'nav' || tagName === 'header' || tagName === 'footer')) {
        
        // Before removing, capture the HTML for debug
        if (debug && removedBlocks) {
          removedBlocks.removedHtml += $el.toString();
        }
        
        if (debug && trackSelectorDecision) {
          const selector = generateConsistentSelector($, $el);
          trackSelectorDecision(selector, 'remove', removedBlocks, 'Navigation or boilerplate element');
        }
        $el.remove();
        return true; // Element was removed
      }
    }
    
    return false; // Element was not removed
  };
  
  // Process elements in a breadth-first manner to handle parent elements first
  const processElementsHierarchically = (rootEl) => {
    const queue = [rootEl];
    
    while (queue.length > 0) {
      const currentEl = queue.shift();
      const $currentEl = $(currentEl);
      
      // Process current element
      const wasRemoved = processElement(currentEl);
      
      // If element wasn't removed, add its children to the queue
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
 * Extract main content from HTML using a top-down hierarchical approach
 * @param {Object} $ - Cheerio instance
 * @param {Object} body - Body element
 * @param {Object} options - Options for extraction
 * @returns {Object} - Main content element
 */
export function extractMainContent($, body, options = {}) {
  const debug = options.debug || false;
  const removedBlocks = options.removedBlocks;
  const trackSelectorDecision = options.trackSelectorDecision || (() => {});
  
  logger.info('[CONTENT] Starting content extraction with top-down hierarchical approach');
  
  // Helper function to track decisions
  const trackDecision = (element, decision, reason) => {
    if (debug && trackSelectorDecision) {
      const selector = generateConsistentSelector($, element);
      trackSelectorDecision(selector, decision, removedBlocks, reason);
    }
  };
  
  // Helper function to check if an element is likely to be content
  const isLikelyContent = (element) => {
    const $el = $(element);
    const tagName = $el.prop('tagName')?.toLowerCase();
    const className = $el.attr('class') || '';
    const idName = $el.attr('id') || '';
    const fullName = (className + ' ' + idName).toLowerCase();
    
    // Definitive content markers
    if (tagName === 'main' || tagName === 'article' || $el.attr('role') === 'main') {
      return true;
    }
    
    // Common content container indicators
    const contentIndicators = ['content', 'article', 'post', 'entry', 'main', 'text', 'body'];
    for (const indicator of contentIndicators) {
      if (fullName.includes(indicator)) {
        return true;
      }
    }
    
    // Check for significant text content
    const textLength = $el.text().trim().length;
    const paragraphs = $el.find('p').length;
    const headings = $el.find('h1, h2, h3, h4, h5, h6').length;
    
    // Elements with substantial text and structure are likely content
    if (textLength > 500 && (paragraphs > 2 || headings > 0)) {
      return true;
    }
    
    return false;
  };
  
  // Helper function to check if an element is likely navigation or boilerplate
  const isLikelyNonContent = (element) => {
    const $el = $(element);
    const tagName = $el.prop('tagName')?.toLowerCase();
    const className = $el.attr('class') || '';
    const idName = $el.attr('id') || '';
    const fullName = (className + ' ' + idName).toLowerCase();
    
    // Definitive non-content markers
    if (['nav', 'header', 'footer', 'aside', 'sidebar', 'svg'].includes(tagName)) {
      return true;
    }
    
    // Check for SVG elements inside this element
    if ($el.find('svg').length > 0 && $el.text().trim().length < 100) {
      // If an element contains SVGs and little text, it's likely decorative/UI
      return true;
    }
    
    // Common non-content container indicators
    const nonContentIndicators = ['nav', 'menu', 'sidebar', 'footer', 'header', 'widget', 'banner', 'ad', 'promo'];
    for (const indicator of nonContentIndicators) {
      if (fullName.includes(indicator)) {
        return true;
      }
    }
    
    return false;
  };
  
  // 1. First pass: Look for definitive semantic elements
  // These are high-confidence markers that don't require further analysis
  const semanticMain = $('main');
  if (semanticMain.length > 0) {
    logger.info('[CONTENT] Found semantic <main> element');
    trackDecision(semanticMain, 'keep', 'Semantic main element');
    return semanticMain;
  }
  
  const article = $('article').first();
  if (article.length > 0) {
    logger.info('[CONTENT] Found semantic <article> element');
    trackDecision(article, 'keep', 'Semantic article element');
    return article;
  }
  
  const roleMain = $('[role="main"]').first();
  if (roleMain.length > 0) {
    logger.info('[CONTENT] Found element with role="main"');
    trackDecision(roleMain, 'keep', 'Element with role="main"');
    return roleMain;
  }
  
  // 2. Second pass: Top-down traversal of the DOM tree
  // Start from body and work down, making decisions at the highest possible level
  const findContentContainer = (element, depth = 0) => {
    // Avoid excessive recursion
    if (depth > 10) return null;
    
    const $el = $(element);
    const children = $el.children();
    
    // Skip elements with no children
    if (children.length === 0) return null;
    
    // Check if this element is definitively content or non-content
    if (isLikelyContent(element)) {
      logger.info('[CONTENT] Found likely content container at depth ' + depth);
      trackDecision(element, 'keep', 'Likely content container');
      return $el;
    }
    
    if (isLikelyNonContent(element)) {
      // Skip this branch entirely
      return null;
    }
    
    // If we have multiple children, check each one
    const contentCandidates = [];
    
    children.each((i, child) => {
      // Skip script, style, SVG, and other non-content elements
      const tagName = $(child).prop('tagName')?.toLowerCase();
      if (['script', 'style', 'noscript', 'iframe', 'svg'].includes(tagName)) {
        // For SVGs, log that we're skipping them as non-content
        if (tagName === 'svg' && debug) {
          logger.info('[CONTENT] Skipping SVG element as non-content');
          trackDecision($(child), 'skip', 'SVG element (assumed non-content)');
        }
        return;
      }
      
      // Check if this child is a content container
      const childResult = findContentContainer(child, depth + 1);
      if (childResult) {
        contentCandidates.push({
          element: childResult,
          textLength: childResult.text().trim().length
        });
      }
    });
    
    // If we found content candidates, return the one with the most text
    if (contentCandidates.length > 0) {
      contentCandidates.sort((a, b) => b.textLength - a.textLength);
      return contentCandidates[0].element;
    }
    
    // If no clear content containers in children, check if this element has enough content
    const textLength = $el.text().trim().length;
    if (textLength > 500) {
      return $el;
    }
    
    return null;
  };
  
  // Start the top-down traversal from the body
  const contentContainer = findContentContainer(body[0]);
  if (contentContainer) {
    logger.info('[CONTENT] Found content container through top-down traversal');
    return contentContainer;
  }
  
  // 3. Fallback: If no clear content container is found, try common content selectors
  const commonContentSelectors = [
    '.content', '#content', '.main', '#main', '.post', '.entry', '.article',
    '[class*="content"]', '[class*="main"]', '[id*="content"]', '[id*="main"]'
  ];
  
  for (const selector of commonContentSelectors) {
    const element = $(selector).first();
    if (element.length > 0 && element.text().trim().length > 100) {
      logger.info(`[CONTENT] Found content using selector: ${selector}`);
      trackDecision(element, 'keep', `Fallback to common selector: ${selector}`);
      return element;
    }
  }
  
  // 4. Last resort: If still no content found, use the body
  logger.info('[CONTENT] Falling back to body element');
  trackDecision(body, 'keep', 'Fallback to body');
  return body;
}
