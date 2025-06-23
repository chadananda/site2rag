#!/usr/bin/env node

// Debug script to test URL filtering for bahai-education.org
import {UrlFilterService} from '../../src/services/url_filter_service.js';

const testUrl = 'https://bahai-education.org';
const filterConfig = {
  excludePaths: ['/contact', '/terms', '/privacy', '/login'],
  excludePatterns: [],
  includeLanguage: null,
  includePatterns: []
};

console.log('=== URL Filter Test ===');
console.log('URL:', testUrl);
console.log('Filter config:', JSON.stringify(filterConfig, null, 2));

const urlFilter = new UrlFilterService(filterConfig);

console.log('\n=== Test shouldCrawlUrl ===');
const shouldCrawl = urlFilter.shouldCrawlUrl(testUrl);
console.log('Result:', shouldCrawl);

// Test each filter method individually
console.log('\n=== Individual Filter Tests ===');
try {
  console.log('isPathExcluded:', urlFilter.isPathExcluded(testUrl));
} catch (err) {
  console.log('isPathExcluded error:', err.message);
}

try {
  console.log('isPatternExcluded:', urlFilter.isPatternExcluded(testUrl));
} catch (err) {
  console.log('isPatternExcluded error:', err.message);
}

try {
  console.log('isPatternIncluded:', urlFilter.isPatternIncluded(testUrl));
} catch (err) {
  console.log('isPatternIncluded error:', err.message);
}