import { URL } from 'url';
import logger from './logger_service.js';

/**
 * Service for URL-related operations including normalization,
 * safe filename generation, and pattern matching
 */
export class UrlService {
  /**
   * Normalizes a URL by removing hash, search params, and handling trailing slashes
   * @param {string} url - URL to normalize
   * @returns {string} - Normalized URL
   */
  normalizeUrl(url) {
    try {
      const u = new URL(url);
      // Remove duplicate slashes, normalize trailing slash
      let pathname = u.pathname.replace(/\/+/g, '/');
      if (pathname !== '/' && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      u.pathname = pathname;
      u.hash = '';
      u.search = '';
      return u.href;
    } catch {
      return url;
    }
  }

  /**
   * Converts a URL to a safe filename for storing as markdown
   * @param {string} url - URL to convert to filename
   * @returns {string} - Safe filename without extension, preserving path structure
   */
  safeFilename(url) {
    try {
      const urlObj = new URL(url);
      const { pathname } = urlObj;
      let file = pathname.replace(/\/+$/, '') || 'index';
      
      // If it's the root path, return 'index'
      if (file === '/') return 'index';
      
      // Remove leading slash
      file = file.replace(/^\//, '');
      
      // Split the path into segments
      const segments = file.split('/');
      
      // Process each segment to make it safe
      const safeSegments = segments.map(segment => {
        // For non-ASCII paths, use a more readable approach
        // First try to decode URI components if they're encoded
        try {
          segment = decodeURIComponent(segment);
        } catch (e) {
          // If decoding fails, use the original segment
        }
        
        // Replace special characters with underscores, but preserve alphanumeric in any language
        // This allows Arabic, Chinese, etc. characters to remain intact
        let safeSegment = segment.replace(/[\/?*:|"<>\\]+/g, '_');
        
        // Remove any existing extension from the last segment
        if (segment === segments[segments.length - 1]) {
          safeSegment = safeSegment.replace(/\.[^.]+$/, '');
        }
        
        return safeSegment;
      });
      
      // Join the segments back together with path separators
      return safeSegments.join('/');
    } catch (e) {
      logger.error(`Error creating safe filename for ${url}:`, e.message);
      return 'page';
    }
  }

  /**
   * Matches a URL path against a glob pattern
   * @param {string} pattern - Glob pattern (supports * and **)
   * @param {string} path - URL path to match
   * @returns {boolean} - Whether the path matches the pattern
   */
  matchGlob(pattern, path) {
    // Special case: '/**' matches everything including '/'
    if (pattern === '/**') return true;
    
    // Special case for patterns ending with /** to match all subpaths
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return path === prefix || path.startsWith(prefix + '/');
    }
    
    // Escape regex special chars except *
    let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    regex = regex.replace(/\*\*/g, '.*'); // ** => .*
    regex = regex.replace(/\*/g, '[^/]*'); // * => any except /
    return new RegExp('^' + regex + '$').test(path);
  }

  /**
   * Checks if a URL matches any of the provided patterns
   * @param {string} url - URL to check
   * @param {string[]} patterns - Array of glob patterns
   * @returns {boolean} - Whether the URL matches any pattern
   */
  matchesPatterns(url, patterns) {
    if (!patterns || !patterns.length) return true;
    
    try {
      const { pathname } = new URL(url);
      
      // Handle include/exclude patterns (patterns starting with ! are exclusions)
      const includes = patterns.filter(p => !p.startsWith('!'));
      const excludes = patterns
        .filter(p => p.startsWith('!'))
        .map(p => p.substring(1));
      
      // Check exclusions first - if any match, skip this URL
      if (excludes.some(pattern => this.matchGlob(pattern, pathname))) {
        return false;
      }
      
      // If no includes specified, allow all non-excluded
      if (!includes.length) return true;
      
      // Otherwise, must match at least one include pattern
      return includes.some(pattern => this.matchGlob(pattern, pathname));
    } catch (e) {
      logger.info(`[URL] Error matching patterns: ${e.message}`);
      return false;
    }
  }

  /**
   * Determines if a URL should be skipped based on depth, visited status, and previous crawl history
   * @param {string} url - URL to check
   * @param {number} depth - Current crawl depth
   * @param {number} maxDepth - Maximum crawl depth
   * @param {Set<string>} visited - Set of already visited URLs in current session
   * @param {boolean} previouslyCrawled - Whether this URL was crawled in a previous session
   * @returns {boolean} - Whether the URL should be skipped
   */
  shouldSkip(url, depth, maxDepth, visited, previouslyCrawled = false) {
    // Ensure URL is a string, not an object
    const urlString = typeof url === 'object' ? url.href : url;
    
    logger.info(`shouldSkip check for ${urlString}: depth=${depth}, maxDepth=${maxDepth}, visited=${visited.has(urlString)}, previouslyCrawled=${previouslyCrawled}`);
    
    // Skip if we've already visited this URL in the current session
    if (visited.has(urlString)) {
      return true;
    }
    
    // Skip if this URL was crawled in a previous session
    if (previouslyCrawled) {
      return true;
    }
    
    // Skip if we're beyond the max depth (but allow if maxDepth is -1, which means no limit)
    if (maxDepth >= 0 && depth > maxDepth) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Checks if a URL belongs to the same domain as the base domain
   * @param {string} url - URL to check
   * @param {string} baseDomain - Base domain to compare against
   * @returns {boolean} - Whether the URL belongs to the same domain
   */
  isSameDomain(url, baseDomain) {
    try {
      // Ensure URL is a string, not an object
      const urlString = typeof url === 'object' ? url.href : url;
      const urlObj = new URL(urlString);
      
      // Extract hostname from the URL
      const hostname = urlObj.hostname;
      
      // Exact match
      if (hostname === baseDomain) {
        return true;
      }
      
      // Check for subdomains (must end with .baseDomain)
      if (hostname.endsWith('.' + baseDomain)) {
        return true;
      }
      
      // Log domains that don't match for debugging
      logger.info(`[DOMAIN CHECK] ${hostname} is not part of ${baseDomain} - skipping`);
      
      return false;
    } catch (e) {
      logger.error(`Error checking domain for ${url}:`, e.message);
      return false;
    }
  }
}

// Export standalone functions for backward compatibility and testing
export const normalizeUrl = (url) => new UrlService().normalizeUrl(url);
export const safeFilename = (url) => new UrlService().safeFilename(url);
export const matchGlob = (pattern, path) => new UrlService().matchGlob(pattern, path);
