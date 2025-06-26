// security.js
// Security utilities for input sanitization and validation
import {z} from 'zod';
/**
 * Pre-compiled regex patterns for performance
 */
export const SECURITY_PATTERNS = {
  // Detect potential prompt injection attempts
  promptInjection: /\b(SYSTEM|ASSISTANT|USER|HUMAN|AI|ignore\s+previous|disregard|forget|debug\s+mode|unrestricted|reveal|bypass|override)\s*:/gi,
  // HTML/script tags that could cause XSS
  htmlTags: /<[^>]+>/g,
  // SQL injection patterns
  sqlInjection: /(\b(DROP|DELETE|INSERT|UPDATE|SELECT|FROM|WHERE|UNION|ALTER)\b|--|;)/gi,
  // Command injection patterns
  commandInjection: /([;&|`$]|\$\(|\beval\b|\bexec\b)/g,
  // Escape sequences that might break parsing
  escapeSequences: /\\[ux]/gi
};
/**
 * Sanitize metadata fields to prevent prompt injection
 * @param {Object} metadata - Raw metadata object
 * @returns {Object} Sanitized metadata
 */
export function sanitizeMetadata(metadata) {
  if (!metadata) return {};
  const sanitized = {};
  // Define safe field length limits
  const fieldLimits = {
    title: 200,
    url: 500,
    author: 100,
    authorOrganization: 100,
    description: 500,
    keywords: 500
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) {
      sanitized[key] = '';
      continue;
    }
    // Convert to string and trim
    let cleanValue = String(value).trim();
    // Apply length limit
    const limit = fieldLimits[key] || 1000;
    if (cleanValue.length > limit) {
      cleanValue = cleanValue.substring(0, limit) + '...';
    }
    // Remove potential prompt injection patterns
    cleanValue = cleanValue.replace(SECURITY_PATTERNS.promptInjection, '[FILTERED]');
    // Remove HTML tags to prevent XSS
    cleanValue = cleanValue.replace(SECURITY_PATTERNS.htmlTags, '');
    // Remove SQL injection attempts
    cleanValue = cleanValue.replace(SECURITY_PATTERNS.sqlInjection, '[FILTERED]');
    // Remove command injection attempts
    cleanValue = cleanValue.replace(SECURITY_PATTERNS.commandInjection, '[FILTERED]');
    // Escape special characters that could break prompts
    cleanValue = cleanValue
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\t/g, ' ');
    sanitized[key] = cleanValue;
  }
  return sanitized;
}
/**
 * Sanitize content blocks to prevent prompt injection
 * @param {string} content - Raw content
 * @returns {string} Sanitized content
 */
export function sanitizeContent(content) {
  if (!content) return '';
  let clean = String(content);
  // Detect and neutralize prompt injection attempts
  if (SECURITY_PATTERNS.promptInjection.test(clean)) {
    // Replace injection attempts with safe markers
    clean = clean.replace(SECURITY_PATTERNS.promptInjection, '[INSTRUCTION REMOVED]');
  }
  // Remove any escape sequences that might break parsing
  clean = clean.replace(SECURITY_PATTERNS.escapeSequences, '');
  return clean;
}
/**
 * Escape HTML entities in text to prevent XSS
 * @param {string} text - Text that may contain HTML
 * @returns {string} HTML-escaped text
 */
export function escapeHtml(text) {
  if (!text) return '';
  const htmlEntities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;'
  };
  return String(text).replace(/[&<>"'\/]/g, char => htmlEntities[char]);
}
/**
 * Validate AI response to ensure it's safe
 * @param {string} response - AI response text
 * @returns {Object} Validation result {isValid, reason}
 */
export function validateAIResponse(response) {
  if (!response) {
    return {isValid: false, reason: 'Empty response'};
  }
  // Check for prompt leakage (AI revealing system prompts)
  const promptLeakagePatterns = [
    /\bsystem\s+prompt\b/i,
    /\binstructions\s+I\s+was\s+given\b/i,
    /\bmy\s+training\s+data\b/i,
    /\bI\s+am\s+programmed\s+to\b/i
  ];
  for (const pattern of promptLeakagePatterns) {
    if (pattern.test(response)) {
      return {isValid: false, reason: 'Potential prompt leakage detected'};
    }
  }
  // Check for malicious code injection in response
  if (/<script|<iframe|javascript:|onerror=/i.test(response)) {
    return {isValid: false, reason: 'Potential code injection in response'};
  }
  // Check response length (prevent DOS via huge responses)
  if (response.length > 50000) {
    return {isValid: false, reason: 'Response too large'};
  }
  return {isValid: true, reason: null};
}
/**
 * Create a security report for monitoring
 * @param {Object} metadata - Original metadata
 * @param {Object} sanitizedMetadata - Sanitized metadata
 * @param {Array} blocks - Content blocks
 * @returns {Object} Security report
 */
export function createSecurityReport(metadata, sanitizedMetadata, blocks = []) {
  const report = {
    timestamp: new Date().toISOString(),
    metadataModified: false,
    suspiciousPatterns: [],
    blocksSanitized: 0
  };
  // Check if metadata was modified
  for (const key in metadata) {
    if (metadata[key] !== sanitizedMetadata[key]) {
      report.metadataModified = true;
      report.suspiciousPatterns.push({
        field: key,
        original: metadata[key],
        sanitized: sanitizedMetadata[key]
      });
    }
  }
  // Check blocks for suspicious content
  blocks.forEach((block, index) => {
    const content = typeof block === 'string' ? block : block.text || '';
    if (SECURITY_PATTERNS.promptInjection.test(content)) {
      report.blocksSanitized++;
      report.suspiciousPatterns.push({
        type: 'prompt_injection',
        blockIndex: index,
        sample: content.substring(0, 100) + '...'
      });
    }
  });
  return report;
}