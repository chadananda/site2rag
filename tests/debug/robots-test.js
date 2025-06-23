#!/usr/bin/env node

// Debug script to test robots.txt parsing
import {FetchService} from '../../src/services/fetch_service.js';

async function testRobots() {
  console.log('=== Robots.txt Test ===');
  
  const fetchService = new FetchService({politeWaitMs: 100});
  const domain = 'https://bahai-education.org';
  const testUrl = 'https://bahai-education.org';
  
  console.log('Domain:', domain);
  console.log('Test URL:', testUrl);
  
  try {
    console.log('\n=== Fetching robots.txt ===');
    const success = await fetchService.fetchRobotsTxt(domain);
    console.log('Fetch robots.txt success:', success);
    
    console.log('\n=== Testing canCrawl ===');
    const canCrawl = fetchService.canCrawl(testUrl);
    console.log('Can crawl result:', canCrawl);
    
    console.log('\n=== Robots object ===');
    console.log('Robots object exists:', !!fetchService.robots);
    if (fetchService.robots) {
      console.log('User agent:', fetchService.userAgent);
      console.log('Robots.txt content preview:', fetchService.robots.toString().substring(0, 200));
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

testRobots();