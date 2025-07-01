import fetch from 'node-fetch';

/**
 * Performs a fetch request with timeout support using AbortController
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} options.timeout - Timeout in milliseconds (default: 30000)
 * @param {Object} options.signal - Optional existing AbortSignal
 * @param {...any} options.fetchOptions - Other fetch options
 * @returns {Promise<Response>} - The fetch response
 * @throws {Error} - If the request times out or fails
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeout = 30000, signal, ...fetchOptions } = options;
  
  // Create an AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  // If an existing signal is provided, combine it with our timeout signal
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }
  
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    // Provide better error messages
    if (error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeout}ms`);
    }
    
    throw error;
  }
}

/**
 * Check if a service is available with a short timeout
 * @param {string} url - The URL to check
 * @param {number} timeout - Timeout in milliseconds (default: 2000)
 * @returns {Promise<boolean>} - True if service is available
 */
export async function checkServiceAvailable(url, timeout = 2000) {
  try {
    const response = await fetchWithTimeout(url, { timeout });
    return response.ok;
  } catch {
    return false;
  }
}