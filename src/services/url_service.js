import { URL } from 'url';

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
      const { pathname } = new URL(url);
      let file = pathname.replace(/\/+$/, '') || 'index';
      
      // If it's the root path, return 'index'
      if (file === '/') return 'index';
      
      // Remove leading slash
      file = file.replace(/^\//, '');
      
      // Split the path into segments
      const segments = file.split('/');
      
      // Process each segment to make it safe
      const safeSegments = segments.map(segment => {
        // Replace special characters in each segment
        let safeSegment = segment.replace(/[^a-zA-Z0-9-_\.]+/g, '_');
        // Remove any existing extension from the last segment
        if (segment === segments[segments.length - 1]) {
          safeSegment = safeSegment.replace(/\.[^.]+$/, '');
        }
        return safeSegment;
      });
      
      // Join the segments back together with path separators
      return safeSegments.join('/');
    } catch {
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
      console.log(`[URL] Error matching patterns: ${e.message}`);
      return false;
    }
  }

  /**
   * Determines if a URL should be skipped based on depth and visited status
   * @param {string} url - URL to check
   * @param {number} depth - Current crawl depth
   * @param {number} maxDepth - Maximum crawl depth
   * @param {Set<string>} visited - Set of already visited URLs
   * @returns {boolean} - Whether the URL should be skipped
   */
  shouldSkip(url, depth, maxDepth, visited) {
    console.log(`shouldSkip check for ${url}: depth=${depth}, maxDepth=${maxDepth}, visited=${visited.has(url)}`);
    
    // Skip if we've already visited this URL
    if (visited.has(url)) {
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
      const urlObj = new URL(url);
      return urlObj.hostname === baseDomain || urlObj.hostname.endsWith('.' + baseDomain);
    } catch (e) {
      console.error(`Error checking domain for ${url}:`, e.message);
      return false;
    }
  }
}

// Export standalone functions for backward compatibility and testing
export const normalizeUrl = (url) => new UrlService().normalizeUrl(url);
export const safeFilename = (url) => new UrlService().safeFilename(url);
export const matchGlob = (pattern, path) => new UrlService().matchGlob(pattern, path);
