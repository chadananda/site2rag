// urlSecurity.js
// Enhanced URL security validation utilities
import {URL} from 'url';
import path from 'path';
/**
 * Validates a URL for security concerns
 * @param {string} url - URL to validate
 * @param {Object} options - Validation options
 * @returns {Object} - {isValid: boolean, reason: string}
 */
export function validateUrl(url, options = {}) {
  const {
    allowLocalhost = false,
    allowFileProtocol = false,
    allowedProtocols = ['http:', 'https:'],
    blockedHosts = ['169.254.169.254', '::1', '127.0.0.1'],
    maxRedirects = 5 // eslint-disable-line no-unused-vars
  } = options;

  if (!url || typeof url !== 'string') {
    return {isValid: false, reason: 'Invalid URL format'};
  }

  try {
    const urlObj = new URL(url);

    // Check protocol
    if (!allowedProtocols.includes(urlObj.protocol)) {
      if (urlObj.protocol === 'file:' && !allowFileProtocol) {
        return {isValid: false, reason: 'File protocol not allowed'};
      }
      return {isValid: false, reason: `Protocol ${urlObj.protocol} not allowed`};
    }

    // Check for localhost/loopback unless explicitly allowed
    if (!allowLocalhost) {
      const hostname = urlObj.hostname.toLowerCase();
      if (hostname === 'localhost' || blockedHosts.includes(hostname)) {
        return {isValid: false, reason: 'Localhost/loopback addresses not allowed'};
      }

      // Check for local network IPs
      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) {
        return {isValid: false, reason: 'Private network addresses not allowed'};
      }
    }

    // Check for suspicious patterns
    if (url.includes('..') || url.includes('%2e%2e')) {
      return {isValid: false, reason: 'Path traversal pattern detected'};
    }

    // Check for data URLs
    if (urlObj.protocol === 'data:') {
      return {isValid: false, reason: 'Data URLs not allowed'};
    }

    // Check for javascript protocol
    if (urlObj.protocol === 'javascript:') {
      return {isValid: false, reason: 'JavaScript URLs not allowed'};
    }

    return {isValid: true, reason: null};
  } catch (error) {
    return {isValid: false, reason: `Invalid URL: ${error.message}`};
  }
}
/**
 * Sanitizes a filename to prevent path traversal
 * @param {string} filename - Filename to sanitize
 * @returns {string} - Sanitized filename
 */
export function sanitizeFilename(filename) {
  if (!filename) return 'unnamed';

  // Remove any path separators and parent directory references
  let sanitized = filename.replace(/[/\\]/g, '_').replace(/\.\./g, '').replace(/^\.+/, ''); // Remove leading dots

  // Remove control characters and other dangerous characters
  sanitized = sanitized.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_'); // eslint-disable-line no-control-regex

  // Limit length
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    const base = path.basename(sanitized, ext);
    sanitized = base.substring(0, 250 - ext.length) + ext;
  }

  // Ensure it's not empty after sanitization
  if (!sanitized || sanitized === '_') {
    sanitized = 'unnamed';
  }

  return sanitized;
}
/**
 * Validates a path to ensure it doesn't escape the base directory
 * @param {string} basePath - Base directory path
 * @param {string} targetPath - Target path to validate
 * @returns {boolean} - True if path is safe
 */
export function isPathSafe(basePath, targetPath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(basePath, targetPath);

  // Ensure the resolved target is within the base directory
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}
/**
 * Creates a safe URL resolver that validates URLs before resolving
 * @param {string} baseUrl - Base URL for resolution
 * @param {Object} options - Validation options
 * @returns {Function} - URL resolver function
 */
export function createSafeUrlResolver(baseUrl, options = {}) {
  return relativeUrl => {
    // First validate the base URL
    const baseValidation = validateUrl(baseUrl, options);
    if (!baseValidation.isValid) {
      throw new Error(`Invalid base URL: ${baseValidation.reason}`);
    }

    try {
      const resolved = new URL(relativeUrl, baseUrl).href;

      // Validate the resolved URL
      const validation = validateUrl(resolved, options);
      if (!validation.isValid) {
        throw new Error(`Invalid resolved URL: ${validation.reason}`);
      }

      return resolved;
    } catch (error) {
      throw new Error(`URL resolution failed: ${error.message}`);
    }
  };
}
/**
 * Rate limiter for URL requests
 */
export class UrlRateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 100;
    this.windowMs = options.windowMs || 60000; // 1 minute
    this.requests = new Map();
  }

  /**
   * Check if a request is allowed
   * @param {string} identifier - Request identifier (e.g., domain)
   * @returns {boolean} - True if request is allowed
   */
  isAllowed(identifier) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Clean old entries
    for (const [key, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter(t => t > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, filtered);
      }
    }

    // Check current request
    const timestamps = this.requests.get(identifier) || [];
    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    // Add current request
    timestamps.push(now);
    this.requests.set(identifier, timestamps);
    return true;
  }

  /**
   * Get remaining requests for an identifier
   * @param {string} identifier - Request identifier
   * @returns {number} - Number of remaining requests
   */
  getRemaining(identifier) {
    const timestamps = this.requests.get(identifier) || [];
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const validTimestamps = timestamps.filter(t => t > windowStart);
    return Math.max(0, this.maxRequests - validTimestamps.length);
  }
}
