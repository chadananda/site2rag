/**
 * Framework Handler - Utilities for handling framework-specific DOM structures
 * Helps extract content from deeply nested framework-generated HTML
 */

import { generateFullSelectorPath, analyzeSelectorPath, isLikelyFrameworkWrapper } from './selector_utils.js';
import logger from './logger_service.js';

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
    '#__nuxt', '#__layout', '#nuxt', '.nuxt', '[data-v-app]',
    // Next.js
    '#__next', '#next',
    // React
    '#root', '#app-root', '#react-root',
    // Vue
    '#app', '.app', '[data-v-app]',
    // Angular
    'app-root', '[ng-app]', '[ng-controller]',
    // Generic
    '.wrapper', '.container', '.app-container', '.page-wrapper'
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
    
    $(element).children().each((i, child) => {
      const $child = $(child);
      const tagName = $child.prop('tagName')?.toLowerCase();
      const id = $child.attr('id') || '';
      const className = $child.attr('class') || '';
      const currentPath = [...path, tagName + (id ? `#${id}` : '') + (className ? `.${className.replace(/\s+/g, '.')}` : '')];
      
      // Check for semantic elements
      if (tagName === 'header' && !semanticSections.header) {
        semanticSections.header = $child;
        trackDecision(currentPath.join(' > '), 'identify', 'Semantic header element');
      } else if ((tagName === 'nav' || className.includes('nav') || className.includes('menu')) && !semanticSections.nav) {
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
      } else if (!semanticSections.content && 
                (className.includes('content') || id.includes('content') || 
                 className.includes('main') || id.includes('main'))) {
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
  const isNavigationElement = ($el) => {
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
        trackDecision(selectorPath, 'framework', `Framework wrapper detected: ${frameworkAnalysis.detectedPatterns.join(', ')}`);
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
      logger.info(`[FRAMEWORK] Candidate ${i+1}: Score ${candidate.score.toFixed(1)}, Text length: ${candidate.textLength}, Path: ${candidate.selectorPath}`);
    });
  }
  
  // Use the highest scoring candidate
  if (contentCandidates.length > 0) {
    const bestCandidate = contentCandidates[0];
    logger.info(`[FRAMEWORK] Selected best candidate: ${bestCandidate.selectorPath}`);
    
    // Track this decision
    trackDecision(bestCandidate.selectorPath, 'keep', `Best content candidate (score: ${bestCandidate.score.toFixed(1)})`);
    
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
