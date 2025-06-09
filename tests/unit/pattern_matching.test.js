import { describe, it, expect } from 'vitest';
import { matchGlob } from '../../src/site_processor_utils.js';

const urls = [
  'https://oceanoflights.org/',
  'https://oceanoflights.org/biography',
  'https://oceanoflights.org/writings',
  'https://oceanoflights.org/tablets',
  'https://oceanoflights.org/talks',
  'https://oceanoflights.org/photos',
  'https://oceanoflights.org/audio',
  'https://oceanoflights.org/category/teachings',
  'https://oceanoflights.org/category/history',
  'https://oceanoflights.org/about',
];

function filterUrls({ crawlPatterns = ["/*"], exclude = [] }) {
  return urls.filter(url => {
    const path = new URL(url).pathname;
    const matchesPattern = crawlPatterns.some(pat => matchGlob(pat, path));
    const matchesExclude = exclude.some(pat => matchGlob(pat, path));
    return matchesPattern && !matchesExclude;
  });
}

describe('Crawl pattern matching', () => {
  it('includes only category pages', () => {
    const result = filterUrls({ crawlPatterns: ['/category/*'] });
    expect(result).toEqual([
      'https://oceanoflights.org/category/teachings',
      'https://oceanoflights.org/category/history',
    ]);
  });

  it('excludes about, photos, audio', () => {
    const result = filterUrls({ crawlPatterns: ['/**'], exclude: ['/about', '/photos', '/audio'] });
    expect(result).toEqual([
      'https://oceanoflights.org/',
      'https://oceanoflights.org/biography',
      'https://oceanoflights.org/writings',
      'https://oceanoflights.org/tablets',
      'https://oceanoflights.org/talks',
      'https://oceanoflights.org/category/teachings',
      'https://oceanoflights.org/category/history',
    ]);
  });

  it('matches only specific top-level pages', () => {
    const result = filterUrls({ crawlPatterns: ['/writings', '/tablets', '/talks'] });
    expect(result).toEqual([
      'https://oceanoflights.org/writings',
      'https://oceanoflights.org/tablets',
      'https://oceanoflights.org/talks',
    ]);
  });
});
