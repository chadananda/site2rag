/**
 * sitemap_service.js - Sitemap discovery and parsing service
 * Finds and parses XML sitemaps to gather comprehensive URL lists for crawling
 */

import xml2js from 'xml2js';
import logger from './logger_service.js';

/**
 * Service for discovering and parsing XML sitemaps
 */
export class SitemapService {
  constructor(fetchService) {
    this.fetchService = fetchService;
    this.maxSitemapSize = 50 * 1024 * 1024; // 50MB limit for sitemap files
    this.maxUrls = 50000; // Reasonable limit for URL discovery
  }
  /**
   * Discover sitemap URLs for a given domain
   * @param {string} baseUrl - Base URL of the site
   * @returns {Promise<string[]>} Array of sitemap URLs
   */
  async discoverSitemapUrls(baseUrl) {
    const sitemapUrls = [];
    const urlObj = new URL(baseUrl);
    const baseOrigin = urlObj.origin;
    // Common sitemap locations to check
    const commonPaths = [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/sitemaps.xml',
      '/sitemap/sitemap.xml',
      '/wp-sitemap.xml',
      '/sitemap/index.xml'
    ];
    // Check robots.txt first for sitemap declarations
    try {
      const robotsUrl = `${baseOrigin}/robots.txt`;
      const robotsResponse = await this.fetchService.fetchUrl(robotsUrl);
      if (robotsResponse.ok) {
        const robotsText = await robotsResponse.text();
        const robotsSitemaps = this.extractSitemapsFromRobots(robotsText, baseOrigin);
        sitemapUrls.push(...robotsSitemaps);
        logger.info(`Found ${robotsSitemaps.length} sitemaps in robots.txt`);
      }
    } catch (error) {
      logger.info(`Could not fetch robots.txt: ${error.message}`);
    }
    // Check common sitemap locations
    for (const path of commonPaths) {
      const sitemapUrl = `${baseOrigin}${path}`;
      if (sitemapUrls.includes(sitemapUrl)) continue; // Skip if already found in robots.txt
      try {
        const response = await this.fetchService.fetchUrl(sitemapUrl, {method: 'HEAD'});
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('xml') || sitemapUrl.endsWith('.xml')) {
            sitemapUrls.push(sitemapUrl);
            logger.info(`Discovered sitemap: ${sitemapUrl}`);
          }
        }
      } catch (error) {
        logger.info(`Sitemap not found at ${sitemapUrl}: ${error.message}`);
      }
    }
    return sitemapUrls;
  }
  /**
   * Extract sitemap URLs from robots.txt content
   * @param {string} robotsText - Content of robots.txt
   * @param {string} baseOrigin - Base origin for relative URLs
   * @returns {string[]} Array of sitemap URLs
   */
  extractSitemapsFromRobots(robotsText, baseOrigin) {
    const sitemapUrls = [];
    const lines = robotsText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('sitemap:')) {
        const sitemapUrl = trimmed.substring(8).trim();
        try {
          const url = new URL(sitemapUrl, baseOrigin);
          sitemapUrls.push(url.toString());
        } catch {
          logger.info(`Invalid sitemap URL in robots.txt: ${sitemapUrl}`);
        }
      }
    }
    return sitemapUrls;
  }
  /**
   * Parse a sitemap XML and extract URLs
   * @param {string} sitemapUrl - URL of the sitemap to parse
   * @returns {Promise<string[]>} Array of URLs found in sitemap
   */
  async parseSitemap(sitemapUrl) {
    try {
      logger.info(`Parsing sitemap: ${sitemapUrl}`);
      const response = await this.fetchService.fetchUrl(sitemapUrl);
      if (!response.ok) {
        logger.warn(`Failed to fetch sitemap ${sitemapUrl}: ${response.status}`);
        return [];
      }
      // Check content size
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > this.maxSitemapSize) {
        logger.warn(`Sitemap ${sitemapUrl} too large (${contentLength} bytes), skipping`);
        return [];
      }
      const xmlContent = await response.text();
      if (xmlContent.length > this.maxSitemapSize) {
        logger.warn(`Sitemap ${sitemapUrl} content too large (${xmlContent.length} bytes), skipping`);
        return [];
      }
      // Parse XML content
      const result = await xml2js.parseStringPromise(xmlContent, {
        explicitArray: false,
        ignoreAttrs: true,
        trim: true
      });
      const urls = [];
      // Handle sitemap index (contains references to other sitemaps)
      if (result.sitemapindex && result.sitemapindex.sitemap) {
        const sitemaps = Array.isArray(result.sitemapindex.sitemap) 
          ? result.sitemapindex.sitemap 
          : [result.sitemapindex.sitemap];
        for (const sitemap of sitemaps) {
          if (sitemap.loc && urls.length < this.maxUrls) {
            const nestedUrls = await this.parseSitemap(sitemap.loc);
            urls.push(...nestedUrls.slice(0, this.maxUrls - urls.length));
          }
        }
      }
      // Handle regular sitemap (contains URLs)
      if (result.urlset && result.urlset.url) {
        const urlEntries = Array.isArray(result.urlset.url) 
          ? result.urlset.url 
          : [result.urlset.url];
        for (const urlEntry of urlEntries) {
          if (urlEntry.loc && urls.length < this.maxUrls) {
            urls.push(urlEntry.loc);
          }
        }
      }
      logger.info(`Extracted ${urls.length} URLs from sitemap ${sitemapUrl}`);
      return urls.slice(0, this.maxUrls);
    } catch (error) {
      logger.warn(`Error parsing sitemap ${sitemapUrl}: ${error.message}`);
      return [];
    }
  }
  /**
   * Get all URLs from discovered sitemaps
   * @param {string} baseUrl - Base URL of the site
   * @returns {Promise<string[]>} Array of all URLs found in sitemaps
   */
  async getAllSitemapUrls(baseUrl) {
    const sitemapUrls = await this.discoverSitemapUrls(baseUrl);
    if (sitemapUrls.length === 0) {
      logger.info('No sitemaps found for site');
      return [];
    }
    logger.info(`Processing ${sitemapUrls.length} discovered sitemaps`);
    const allUrls = [];
    for (const sitemapUrl of sitemapUrls) {
      if (allUrls.length >= this.maxUrls) break;
      const urls = await this.parseSitemap(sitemapUrl);
      allUrls.push(...urls.slice(0, this.maxUrls - allUrls.length));
    }
    // Remove duplicates and filter to same domain
    const uniqueUrls = [...new Set(allUrls)];
    const urlObj = new URL(baseUrl);
    const filteredUrls = uniqueUrls.filter(url => {
      try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname === urlObj.hostname;
      } catch {
        return false;
      }
    });
    logger.info(`Sitemap discovery complete: ${filteredUrls.length} unique URLs found`);
    return filteredUrls.slice(0, this.maxUrls);
  }
}