/**
 * Helper methods for the SiteProcessor class
 */

/**
 * Handle previous crawl data to determine if a page has changed
 * @param {Object} crawlState - The crawl state service
 * @param {string} url - The URL to check
 * @returns {Object} - Headers to use for conditional request
 */
export async function handlePreviousCrawl(crawlState, url) {
  const pageData = crawlState.getPage(url);
  const headers = {};
  
  if (!pageData) {
    return { headers };
  }
  
  if (pageData.etag) {
    headers['If-None-Match'] = pageData.etag;
  }
  
  if (pageData.lastModified) {
    headers['If-Modified-Since'] = pageData.lastModified;
  }
  
  return { headers };
}

/**
 * Handle a 304 Not Modified response
 * @param {string} url - The URL that was not modified
 * @param {Object} prevData - Previous crawl data
 * @param {Set} visited - Set of visited URLs
 * @param {Array} found - Array of found URLs
 */
export async function handleNotModified(url, prevData, visited, found) {
  // Mark as visited
  visited.add(url);
  
  // Re-add any previously found links to the queue
  if (prevData && prevData.links) {
    for (const link of prevData.links) {
      if (!visited.has(link)) {
        found.push(link);
      }
    }
  }
}

/**
 * Update the crawl state with new page data
 * @param {string} url - The URL that was crawled
 * @param {Object} response - The fetch response
 * @param {Array} links - Links found on the page
 * @param {Object} crawlState - The crawl state service
 */
export async function updateCrawlState(url, response, links, crawlState) {
  const headers = response.headers;
  const etag = headers.get('etag');
  const lastModified = headers.get('last-modified');
  
  await crawlState.upsertPage(url, {
    etag,
    lastModified,
    links,
    lastCrawled: new Date().toISOString()
  });
}
