/**
 * tests/unit/services/content-service-jsonld.test.js
 * Comprehensive tests for JSON-LD extraction functionality
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {ContentService} from '../../../src/services/content_service.js';
import {load} from 'cheerio';
// Mock the logger to avoid import issues in tests
vi.mock('../../../src/services/logger_service.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn()
  }
}));
// Test fixture: Article JSON-LD
const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Test Article with JSON-LD",
  "description": "This is a test article with structured data",
  "datePublished": "2025-06-25T10:00:00Z",
  "dateModified": "2025-06-25T12:00:00Z",
  "author": {
    "@type": "Person",
    "name": "John Doe"
  },
  "publisher": {
    "@type": "Organization",
    "name": "Test Publisher",
    "logo": {
      "@type": "ImageObject",
      "url": "https://example.com/logo.png"
    }
  },
  "image": "https://example.com/article-image.jpg",
  "keywords": "test, article, json-ld"
};
// Test fixture: Person JSON-LD with bio
const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "John Doe",
  "description": "John Doe is an experienced software engineer and technical writer with over 10 years of experience in web development.",
  "jobTitle": "Senior Software Engineer",
  "image": "https://example.com/john-doe.jpg",
  "url": "https://example.com/authors/john-doe",
  "worksFor": {
    "@type": "Organization",
    "name": "Tech Corp"
  }
};
// Test fixture: PodcastEpisode JSON-LD
const podcastJsonLd = {
  "@context": "https://schema.org",
  "@type": "PodcastEpisode",
  "name": "Episode 42: Web Development Best Practices",
  "description": "In this episode, we discuss modern web development practices",
  "datePublished": "2025-06-20T00:00:00Z",
  "timeRequired": "PT45M",
  "license": "https://creativecommons.org/licenses/by/4.0/",
  "author": {
    "@type": "Person",
    "name": "Jane Smith"
  }
};
describe('ContentService JSON-LD Extraction', () => {
  let contentService;
  beforeEach(() => {
    contentService = new ContentService();
  });
  describe('extractJsonLd', () => {
    it('should extract Article JSON-LD data', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <script type="application/ld+json">${JSON.stringify(articleJsonLd)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      expect(metadata.title).toBe('Test Article with JSON-LD');
      expect(metadata.description).toBe('This is a test article with structured data');
      expect(metadata.author).toBe('John Doe');
      expect(metadata.datePublished).toBe('2025-06-25T10:00:00Z');
      expect(metadata.dateModified).toBe('2025-06-25T12:00:00Z');
      expect(metadata.publisher).toBe('Test Publisher');
      expect(metadata.publisherLogo).toBe('https://example.com/logo.png');
      expect(metadata.image).toBe('https://example.com/article-image.jpg');
      expect(metadata.keywords).toEqual(['test', 'article', 'json-ld']);
    });
    it('should handle multiple JSON-LD scripts', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <script type="application/ld+json">${JSON.stringify(articleJsonLd)}</script>
          <script type="application/ld+json">${JSON.stringify(personJsonLd)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      // Should have article data
      expect(metadata.title).toBe('Test Article with JSON-LD');
      expect(metadata.author).toBe('John Doe');
      // Should have Person data
      expect(metadata.authorDescription).toBe('John Doe is an experienced software engineer and technical writer with over 10 years of experience in web development.');
      expect(metadata.authorJobTitle).toBe('Senior Software Engineer');
      expect(metadata.authorImage).toBe('https://example.com/john-doe.jpg');
      expect(metadata.authorUrl).toBe('https://example.com/authors/john-doe');
      expect(metadata.authorOrganization).toBe('Tech Corp');
    });
    it('should extract Person data for author bios', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <meta name="author" content="John Doe">
          <script type="application/ld+json">${JSON.stringify(personJsonLd)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      expect(metadata.author).toBe('John Doe');
      expect(metadata.authorDescription).toBe('John Doe is an experienced software engineer and technical writer with over 10 years of experience in web development.');
      expect(metadata.authorJobTitle).toBe('Senior Software Engineer');
    });
    it('should handle invalid JSON gracefully', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <script type="application/ld+json">{ invalid json }</script>
          <meta name="description" content="Fallback description">
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      // Should fall back to meta tags
      expect(metadata.title).toBe('Test Page');
      expect(metadata.description).toBe('Fallback description');
    });
    it('should extract PodcastEpisode metadata', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Podcast Page</title>
          <script type="application/ld+json">${JSON.stringify(podcastJsonLd)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      expect(metadata.title).toBe('Episode 42: Web Development Best Practices');
      expect(metadata.description).toBe('In this episode, we discuss modern web development practices');
      expect(metadata.author).toBe('Jane Smith');
      expect(metadata.datePublished).toBe('2025-06-20T00:00:00Z');
      expect(metadata.audioDuration).toBe('PT45M');
      expect(metadata.license).toBe('https://creativecommons.org/licenses/by/4.0/');
    });
    it('should handle JSON-LD arrays', () => {
      const jsonLdArray = [articleJsonLd, personJsonLd];
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <script type="application/ld+json">${JSON.stringify(jsonLdArray)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      // Should extract both Article and Person data
      expect(metadata.title).toBe('Test Article with JSON-LD');
      expect(metadata.authorDescription).toBe('John Doe is an experienced software engineer and technical writer with over 10 years of experience in web development.');
    });
    it('should prioritize JSON-LD over meta tags', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Meta Title</title>
          <meta name="description" content="Meta description">
          <meta name="author" content="Meta Author">
          <script type="application/ld+json">${JSON.stringify(articleJsonLd)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      // JSON-LD should take precedence
      expect(metadata.title).toBe('Test Article with JSON-LD');
      expect(metadata.description).toBe('This is a test article with structured data');
      expect(metadata.author).toBe('John Doe');
    });
    it('should extract author as string when provided directly', () => {
      const simpleArticle = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "Simple Article",
        "author": "Jane Doe"  // Author as string, not Person object
      };
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <script type="application/ld+json">${JSON.stringify(simpleArticle)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      expect(metadata.author).toBe('Jane Doe');
    });
    it('should handle missing Person match for author', () => {
      const articleWithDifferentAuthor = {
        ...articleJsonLd,
        author: { "@type": "Person", "name": "Alice Smith" }
      };
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <script type="application/ld+json">${JSON.stringify(articleWithDifferentAuthor)}</script>
          <script type="application/ld+json">${JSON.stringify(personJsonLd)}</script>
        </head>
        <body><p>Content</p></body>
        </html>
      `;
      const $ = load(html);
      const metadata = contentService.extractMetadata($);
      // Author should be from article
      expect(metadata.author).toBe('Alice Smith');
      // Should not have author bio since names don't match
      expect(metadata.authorDescription).toBeUndefined();
    });
  });
  describe('JSON-LD removal from content', () => {
    it('should remove JSON-LD scripts from cleaned content', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <script type="application/ld+json">${JSON.stringify(articleJsonLd)}</script>
        </head>
        <body>
          <article>
            <h1>Test Article</h1>
            <p>This is the article content.</p>
            <script type="application/ld+json">${JSON.stringify(personJsonLd)}</script>
          </article>
        </body>
        </html>
      `;
      const result = await contentService.processHtml(html, 'https://example.com/test');
      // Metadata should be extracted
      expect(result.metadata.title).toBe('Test Article with JSON-LD');
      expect(result.metadata.authorDescription).toBe('John Doe is an experienced software engineer and technical writer with over 10 years of experience in web development.');
      // But JSON-LD scripts should be removed from content
      const contentHtml = result.main.html();
      expect(contentHtml).not.toContain('application/ld+json');
      expect(contentHtml).not.toContain('@context');
      expect(contentHtml).not.toContain('@type');
      // Article content should be preserved
      expect(contentHtml).toContain('Test Article');
      expect(contentHtml).toContain('This is the article content.');
    });
  });
});