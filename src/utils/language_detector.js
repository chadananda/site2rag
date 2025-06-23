/**
 * language_detector.js - Utility for detecting webpage language
 * Extracts language information from HTML metadata
 */

/**
 * Detect language from HTML content
 * @param {string} html - Raw HTML content
 * @returns {string|null} - Language code (e.g., 'en', 'es') or null if not found
 */
export function detectLanguage(html) {
  if (!html || typeof html !== 'string') {
    return null;
  }
  // 1. Check <html lang="..."> attribute
  const htmlLangMatch = html.match(/<html[^>]+lang=['"]([^'"]+)['"]/i);
  if (htmlLangMatch) {
    return normalizeLanguageCode(htmlLangMatch[1]);
  }
  // 2. Check <meta http-equiv="content-language"> 
  const metaLangMatch = html.match(/<meta[^>]+http-equiv=['"]content-language['"][^>]+content=['"]([^'"]+)['"]/i);
  if (metaLangMatch) {
    return normalizeLanguageCode(metaLangMatch[1]);
  }
  // 3. Check <meta name="language">
  const metaNameMatch = html.match(/<meta[^>]+name=['"]language['"][^>]+content=['"]([^'"]+)['"]/i);
  if (metaNameMatch) {
    return normalizeLanguageCode(metaNameMatch[1]);
  }
  // 4. Check alternative meta name variations
  const metaLangAltMatch = html.match(/<meta[^>]+name=['"]lang['"][^>]+content=['"]([^'"]+)['"]/i);
  if (metaLangAltMatch) {
    return normalizeLanguageCode(metaLangAltMatch[1]);
  }
  return null; // Language unknown
}
/**
 * Normalize language code to lowercase and extract primary language
 * @param {string} langCode - Raw language code (e.g., 'en-US', 'EN', 'en_US')
 * @returns {string} - Normalized language code (e.g., 'en')
 */
function normalizeLanguageCode(langCode) {
  if (!langCode || typeof langCode !== 'string') {
    return null;
  }
  // Convert to lowercase and extract primary language part
  return langCode.toLowerCase().split(/[-_]/)[0];
}
/**
 * Check if HTML content has the target language
 * @param {string} html - Raw HTML content
 * @param {string} targetLanguage - Target language code (e.g., 'en')
 * @returns {boolean} - True if content matches target language
 */
export function hasTargetLanguage(html, targetLanguage) {
  if (!targetLanguage) {
    return true; // No language requirement
  }
  const detectedLanguage = detectLanguage(html);
  if (!detectedLanguage) {
    return false; // Unknown language, exclude it
  }
  return detectedLanguage === targetLanguage.toLowerCase();
}