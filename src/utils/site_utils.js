/**
 * Utility functions for site processing
 */
import {URL} from 'url';
export {CrawlLimitReached} from './errors.js';

/**
 * Matches a path against a glob pattern
 * @param {string} pattern - The glob pattern to match against
 * @param {string} path - The path to check
 * @returns {boolean} - Whether the path matches the pattern
 */
export function matchGlob(pattern, path) {
  // Special case for /** which matches everything
  if (pattern === '/**') {
    return true;
  }

  // Special case for /blog/** type patterns
  if (pattern.endsWith('/**')) {
    const basePath = pattern.slice(0, -3);
    return path === basePath || path.startsWith(basePath + '/');
  }

  // Convert glob to regex
  const regex = new RegExp(
    `^${pattern
      .replace(/\./g, '\\.')
      .replace(/\+/g, '\\+')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')}$`
  );
  return regex.test(path);
}

/**
 * Converts a URL to a safe filename
 * @param {string} url - The URL to convert
 * @returns {string} - A safe filename
 */
export function safeFilename(url) {
  try {
    const urlObj = new URL(url);
    // Remove protocol and domain
    let path = urlObj.pathname;

    // Handle root path
    if (path === '/') {
      return 'index.md';
    }

    // Remove leading and trailing slashes
    path = path.replace(/^\/|\/$/g, '');

    // Replace invalid filename characters
    path = path.replace(/[\\/:*?"<>|]/g, '_');

    // Add .md extension if not present
    if (!path.endsWith('.md')) {
      path = path + '.md';
    }

    return path;
  } catch (e) {
    // If URL parsing fails, return a default page name
    return 'page.md';
  }
}

/**
 * Normalizes a URL by handling relative paths and ensuring consistent format
 * @param {string} url - The URL to normalize
 * @param {string} baseUrl - The base URL to resolve against
 * @returns {string} - The normalized URL
 */
export function normalizeUrl(url, baseUrl) {
  try {
    // Handle relative URLs
    const fullUrl = new URL(url, baseUrl);

    // Remove hash and search params
    fullUrl.hash = '';
    fullUrl.search = '';

    // Normalize path by removing duplicate slashes
    let path = fullUrl.pathname.replace(/\/+/g, '/');

    // Remove trailing slash except for domain root
    if (path.endsWith('/') && path !== '/') {
      path = path.slice(0, -1);
    }

    return fullUrl.origin + path;
  } catch (e) {
    // Return original URL if parsing fails
    return url;
  }
}
