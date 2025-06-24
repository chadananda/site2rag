/**
 * Utilities for handling DOM selectors and paths
 * Enhanced with context-aware analysis for better content extraction
 */

/**
 * Generates a full selector path for an element, showing its ancestry
 * @param {Object} $ - Cheerio instance
 * @param {Object} element - Element to generate path for
 * @param {Number} maxDepth - Maximum depth to traverse up the tree (default: 5)
 * @param {Boolean} includeAttributes - Whether to include key attributes in the selector
 * @returns {String} - Full selector path
 */
export function generateFullSelectorPath($, element, maxDepth = 5, includeAttributes = false) {
  const path = [];
  let current = element;
  let depth = 0;

  // Traverse up the DOM tree to build the full path
  while (current.length > 0 && depth < maxDepth) {
    const tagName = current.prop('tagName')?.toLowerCase() || '';
    if (!tagName) break;

    let selector = tagName;

    // Add ID if present (most specific)
    const id = current.attr('id');
    let className;
    if (id) {
      // Clean ID to handle potential special characters
      const cleanId = id.replace(/[:[\].,\s]/g, '-');
      selector += `#${cleanId}`;
    }
    // Otherwise add classes if present
    else {
      className = current.attr('class');
      if (className) {
        const classes = className.split(/\s+/).filter(Boolean);
        if (classes.length > 0) {
          // Limit to first 3 classes to avoid overly long selectors
          const classSelector = classes
            .slice(0, 3)
            .map(c => `.${c}`)
            .join('');
          selector += classSelector;
        }
      }
    }

    // Add role attribute if present and includeAttributes is true
    if (includeAttributes) {
      const role = current.attr('role');
      if (role) {
        selector += `[role="${role}"]`;
      }

      // Add data-testid if present (useful for React components)
      const testId = current.attr('data-testid');
      if (testId) {
        selector += `[data-testid="${testId}"]`;
      }

      // Add aria-label if present (useful for accessibility and identifying purpose)
      const ariaLabel = current.attr('aria-label');
      if (ariaLabel) {
        selector += `[aria-label]`;
      }
    }

    // Add position index for elements without ID or class to make path more specific
    if (!id && (!className || className.trim() === '')) {
      const siblings = current.parent().children(tagName);
      if (siblings.length > 1) {
        const index = siblings.index(current);
        selector += `:nth-child(${index + 1})`;
      }
    }

    path.unshift(selector);
    current = current.parent();
    depth++;
  }

  return path.join(' > ');
}

/**
 * Analyzes a selector path to determine if it's likely to be content or navigation
 * @param {String} selectorPath - Full selector path
 * @returns {Object} - Analysis result with type, confidence score, and detailed scoring
 */
export function analyzeSelectorPath(selectorPath) {
  // Lists of patterns to identify content vs navigation with weighted importance
  const contentPatterns = [
    {pattern: 'content', weight: 3},
    {pattern: 'main', weight: 3},
    {pattern: 'article', weight: 3},
    {pattern: 'post', weight: 2},
    {pattern: 'entry', weight: 2},
    {pattern: 'text', weight: 1},
    {pattern: 'body', weight: 1},
    {pattern: 'chapter', weight: 2},
    {pattern: 'section', weight: 2},
    {pattern: 'story', weight: 2},
    {pattern: 'page', weight: 1},
    {pattern: 'blog', weight: 2},
    {pattern: 'title', weight: 1},
    {pattern: 'heading', weight: 1},
    {pattern: 'document', weight: 3},
    {pattern: 'publication', weight: 3},
    {pattern: 'prose', weight: 3},
    {pattern: 'paragraph', weight: 2},
    {pattern: 'container', weight: 1} // Lower weight as it's more ambiguous
  ];

  const navigationPatterns = [
    {pattern: 'nav', weight: 3},
    {pattern: 'menu', weight: 3},
    {pattern: 'header', weight: 2},
    {pattern: 'footer', weight: 2},
    {pattern: 'sidebar', weight: 3},
    {pattern: 'widget', weight: 2},
    {pattern: 'toolbar', weight: 3},
    {pattern: 'banner', weight: 2},
    {pattern: 'ad', weight: 3},
    {pattern: 'popup', weight: 3},
    {pattern: 'modal', weight: 3},
    {pattern: 'cookie', weight: 3},
    {pattern: 'newsletter', weight: 3},
    {pattern: 'subscribe', weight: 3},
    {pattern: 'social', weight: 3},
    {pattern: 'share', weight: 2},
    {pattern: 'search', weight: 2},
    {pattern: 'login', weight: 3},
    {pattern: 'signup', weight: 3},
    {pattern: 'breadcrumb', weight: 3},
    {pattern: 'pagination', weight: 3},
    {pattern: 'tab', weight: 2},
    {pattern: 'button', weight: 1} // Lower weight as buttons can be part of content too
  ];

  // Calculate content and navigation scores
  let contentScore = 0;
  let navigationScore = 0;
  let matchedContentPatterns = [];
  let matchedNavigationPatterns = [];

  // Split the path into components for more precise analysis
  const pathComponents = selectorPath.split(' > ');

  // Check for semantic elements with stronger weight for the last component
  // Last component is the actual element we're analyzing
  const checkSemanticElement = (component, isLastComponent) => {
    const multiplier = isLastComponent ? 1.5 : 1.0;

    // Content semantic elements
    if (/^main([.#:]|$)/.test(component)) {
      contentScore += 10 * multiplier;
      matchedContentPatterns.push('semantic:main');
    }
    if (/^article([.#:]|$)/.test(component)) {
      contentScore += 8 * multiplier;
      matchedContentPatterns.push('semantic:article');
    }
    if (/^section([.#:]|$)/.test(component)) {
      contentScore += 3 * multiplier;
      matchedContentPatterns.push('semantic:section');
    }
    if (/^p([.#:]|$)/.test(component)) {
      contentScore += 2 * multiplier;
      matchedContentPatterns.push('semantic:paragraph');
    }
    if (/^h[1-6]([.#:]|$)/.test(component)) {
      contentScore += 2 * multiplier;
      matchedContentPatterns.push('semantic:heading');
    }
    if (/^blockquote([.#:]|$)/.test(component)) {
      contentScore += 3 * multiplier;
      matchedContentPatterns.push('semantic:blockquote');
    }

    // Navigation semantic elements
    if (/^nav([.#:]|$)/.test(component)) {
      navigationScore += 10 * multiplier;
      matchedNavigationPatterns.push('semantic:nav');
    }
    if (/^header([.#:]|$)/.test(component)) {
      navigationScore += 8 * multiplier;
      matchedNavigationPatterns.push('semantic:header');
    }
    if (/^footer([.#:]|$)/.test(component)) {
      navigationScore += 8 * multiplier;
      matchedNavigationPatterns.push('semantic:footer');
    }
    if (/^aside([.#:]|$)/.test(component)) {
      navigationScore += 6 * multiplier;
      matchedNavigationPatterns.push('semantic:aside');
    }
    if (/^button([.#:]|$)/.test(component)) {
      navigationScore += 2 * multiplier;
      matchedNavigationPatterns.push('semantic:button');
    }

    // Check for role attributes
    if (component.includes('[role="main"]')) {
      contentScore += 10 * multiplier;
      matchedContentPatterns.push('role:main');
    }
    if (component.includes('[role="article"]')) {
      contentScore += 8 * multiplier;
      matchedContentPatterns.push('role:article');
    }
    if (component.includes('[role="navigation"]')) {
      navigationScore += 10 * multiplier;
      matchedNavigationPatterns.push('role:navigation');
    }
    if (component.includes('[role="banner"]')) {
      navigationScore += 8 * multiplier;
      matchedNavigationPatterns.push('role:banner');
    }
    if (component.includes('[role="complementary"]')) {
      navigationScore += 6 * multiplier;
      matchedNavigationPatterns.push('role:complementary');
    }
  };

  // Check each component in the path
  pathComponents.forEach((component, index) => {
    const isLastComponent = index === pathComponents.length - 1;
    checkSemanticElement(component, isLastComponent);

    // Check for content/navigation patterns in class names and IDs
    for (const {pattern, weight} of contentPatterns) {
      // More precise regex to avoid partial matches (e.g. 'nav' in 'canvas')
      const regex = new RegExp(`[.#](${pattern}$|${pattern}[_-]|${pattern}[A-Z]|${pattern}[0-9]|^${pattern}$)`, 'i');
      if (regex.test(component)) {
        const score = weight * (isLastComponent ? 2 : 1);
        contentScore += score;
        matchedContentPatterns.push(`${pattern}:${score}`);
      }
    }

    for (const {pattern, weight} of navigationPatterns) {
      const regex = new RegExp(`[.#](${pattern}$|${pattern}[_-]|${pattern}[A-Z]|${pattern}[0-9]|^${pattern}$)`, 'i');
      if (regex.test(component)) {
        const score = weight * (isLastComponent ? 2 : 1);
        navigationScore += score;
        matchedNavigationPatterns.push(`${pattern}:${score}`);
      }
    }
  });

  // Additional contextual analysis

  // If there's a nav element in the path but the last component has strong content indicators
  if (selectorPath.includes(' nav ') && contentScore > 15 && contentScore > navigationScore * 1.5) {
    contentScore *= 0.8; // Reduce content score slightly but don't eliminate it
    matchedContentPatterns.push('contextual:nav-ancestor-penalty');
  }

  // If there's a main/article element in the path, boost content score
  if (selectorPath.includes(' main ') || selectorPath.includes(' article ')) {
    contentScore *= 1.2;
    matchedContentPatterns.push('contextual:main-ancestor-boost');
  }

  // Determine the likely type based on scores
  let type = 'unknown';
  let confidence = 0;

  if (contentScore > navigationScore) {
    type = 'content';
    confidence = Math.min(1.0, contentScore / (contentScore + navigationScore));
  } else if (navigationScore > contentScore) {
    type = 'navigation';
    confidence = Math.min(1.0, navigationScore / (contentScore + navigationScore));
  }

  return {
    type,
    confidence,
    contentScore,
    navigationScore,
    selectorPath,
    matchedContentPatterns,
    matchedNavigationPatterns
  };
}

/**
 * Determines if a selector path is likely to be a framework wrapper
 * @param {String} selectorPath - Full selector path
 * @returns {Object} - Analysis result with isFramework flag and detected patterns
 */
export function isLikelyFrameworkWrapper(selectorPath) {
  // Framework-specific patterns with weights
  const frameworkPatterns = [
    // Nuxt.js
    {pattern: '__nuxt', weight: 10},
    {pattern: '__layout', weight: 10},
    {pattern: 'nuxt', weight: 8},
    {pattern: 'nuxt-', weight: 8},

    // Next.js
    {pattern: '__next', weight: 10},
    {pattern: 'next', weight: 8},

    // React
    {pattern: 'react-root', weight: 10},
    {pattern: 'react-app', weight: 10},
    {pattern: 'root', weight: 5},

    // Angular
    {pattern: 'ng-app', weight: 10},
    {pattern: 'ng-view', weight: 10},
    {pattern: 'app-root', weight: 10},

    // Vue
    {pattern: 'vue-app', weight: 10},
    {pattern: 'v-app', weight: 8},
    {pattern: 'data-v-app', weight: 10},

    // Generic framework patterns
    {pattern: 'app', weight: 5},
    {pattern: 'wrapper', weight: 4},
    {pattern: 'container', weight: 3},
    {pattern: 'app-container', weight: 6},
    {pattern: 'page-wrapper', weight: 6},
    {pattern: 'site-wrapper', weight: 6},
    {pattern: 'main-wrapper', weight: 5},
    {pattern: 'content-wrapper', weight: 4}
  ];

  let score = 0;
  const detectedPatterns = [];

  // Check each component in the path
  const pathComponents = selectorPath.split(' > ');

  for (const component of pathComponents) {
    for (const {pattern, weight} of frameworkPatterns) {
      // More precise regex to match framework patterns
      // Matches exact IDs, classes, or data attributes
      const regex = new RegExp(`[#]${pattern}$|[.]${pattern}$|\\[data-${pattern}\\]`, 'i');
      if (regex.test(component)) {
        score += weight;
        detectedPatterns.push(pattern);
      }
    }
  }

  // Check for common framework data attributes
  const dataAttributePatterns = ['data-reactroot', 'data-reactid', 'data-v-', 'data-server-rendered'];
  for (const pattern of dataAttributePatterns) {
    if (selectorPath.includes(pattern)) {
      score += 8;
      detectedPatterns.push(pattern);
    }
  }

  // Check for common framework ID patterns with more precise matching
  if (/#__next\b/.test(selectorPath) || /#__nuxt\b/.test(selectorPath)) {
    score += 10;
    detectedPatterns.push('exact-framework-id');
  }

  // Consider depth of the path - very short paths with framework patterns
  // are more likely to be framework wrappers
  if (pathComponents.length <= 3 && score > 0) {
    score += 3;
    detectedPatterns.push('shallow-depth');
  }

  const isFramework = score >= 8; // Threshold for considering it a framework wrapper

  return {
    isFramework,
    score,
    detectedPatterns,
    selectorPath
  };
}
