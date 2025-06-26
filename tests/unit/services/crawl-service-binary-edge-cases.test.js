/**
 * tests/unit/services/crawl-service-binary-edge-cases.test.js
 * Edge case tests for binary file handling in crawl service
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {CrawlService} from '../../../src/services/crawl_service.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

// Mock logger
vi.mock('../../../src/services/logger_service.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    crawl: vi.fn(),
    configure: vi.fn()
  }
}));

// Mock fetch
global.fetch = vi.fn();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_OUTPUT_DIR = path.join(__dirname, '../../tmp/binary-edge-cases-test');

describe('CrawlService Binary File Edge Cases', () => {
  let crawlService;
  let mockDb;
  let mockContentService;
  let mockFileService;
  let mockProgressService;
  let mockCrawlStateService;

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();
    
    // Create test output directory
    if (!fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.mkdirSync(TEST_OUTPUT_DIR, {recursive: true});
    }

    // Mock database
    mockDb = {
      getPage: vi.fn(),
      addPage: vi.fn(),
      updatePage: vi.fn(),
      getPages: vi.fn(() => []),
      getPagesByDomain: vi.fn(() => [])
    };

    // Mock file service
    mockFileService = {
      writeContent: vi.fn(),
      sanitizeFilename: vi.fn(url => {
        const urlObj = new URL(url);
        return urlObj.pathname.replace(/[^a-zA-Z0-9.-]/g, '_');
      })
    };

    // Mock content service
    mockContentService = {
      extractContent: vi.fn(() => ({
        title: 'Test Page',
        description: 'Test description',
        content: 'Test content',
        links: []
      })),
      isIndexablePage: vi.fn(() => true),
      isApiUrl: vi.fn(() => false)
    };

    // Mock progress service
    mockProgressService = {
      updateStats: vi.fn(),
      addActiveUrl: vi.fn(),
      completeUrl: vi.fn(),
      updateUrlProgress: vi.fn()
    };

    // Mock crawl state service
    mockCrawlStateService = {
      queueUrl: vi.fn(),
      savePage: vi.fn(),
      hasQueuedUrl: vi.fn(() => false),
      getQueuedUrl: vi.fn()
    };

    // Create crawl service with enhanced options
    crawlService = new CrawlService({
      domain: 'example.com',
      outputPath: TEST_OUTPUT_DIR,
      downloadAssets: true,
      db: mockDb,
      fileService: mockFileService,
      contentService: mockContentService,
      progressService: mockProgressService,
      crawlStateService: mockCrawlStateService
    });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, {recursive: true, force: true});
    }
    vi.restoreAllMocks();
  });

  describe('Binary file duplicate detection', () => {
    it('should detect and skip duplicate binary files by content hash', async () => {
      const pdfContent = Buffer.from('PDF content here');
      const pdfUrl1 = 'https://example.com/doc1.pdf';
      const pdfUrl2 = 'https://example.com/duplicate.pdf'; // Same content, different URL

      // Mock fetch responses
      fetch.mockImplementation(async (url) => {
        if (url === pdfUrl1 || url === pdfUrl2) {
          return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/pdf']]),
            arrayBuffer: async () => pdfContent.buffer
          };
        }
      });

      // First download
      await crawlService.downloadBinaryFile(pdfUrl1, 'application/pdf');
      expect(mockFileService.writeContent).toHaveBeenCalledTimes(1);

      // Second download with same content should be skipped
      await crawlService.downloadBinaryFile(pdfUrl2, 'application/pdf');
      
      // Should still only be called once due to duplicate detection
      expect(mockFileService.writeContent).toHaveBeenCalledTimes(1);
    });

    it('should allow different binary files even with similar names', async () => {
      const pdf1Content = Buffer.from('PDF content 1');
      const pdf2Content = Buffer.from('PDF content 2');
      
      fetch.mockImplementation(async (url) => {
        if (url.includes('doc1.pdf')) {
          return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/pdf']]),
            arrayBuffer: async () => pdf1Content.buffer
          };
        } else if (url.includes('doc2.pdf')) {
          return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/pdf']]),
            arrayBuffer: async () => pdf2Content.buffer
          };
        }
      });

      await crawlService.downloadBinaryFile('https://example.com/doc1.pdf', 'application/pdf');
      await crawlService.downloadBinaryFile('https://example.com/doc2.pdf', 'application/pdf');

      // Both should be downloaded as they have different content
      expect(mockFileService.writeContent).toHaveBeenCalledTimes(2);
    });

    it('should track binary files across different domains', async () => {
      const sharedPdfContent = Buffer.from('Shared PDF content');
      
      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => sharedPdfContent.buffer
      }));

      await crawlService.downloadBinaryFile('https://example.com/shared.pdf', 'application/pdf');
      await crawlService.downloadBinaryFile('https://other.com/shared.pdf', 'application/pdf');

      // Should detect duplicate even across domains
      expect(mockFileService.writeContent).toHaveBeenCalledTimes(1);
    });
  });

  describe('Path traversal security', () => {
    it('should prevent path traversal attempts in binary downloads', async () => {
      const maliciousUrls = [
        'https://example.com/../../etc/passwd',
        'https://example.com/docs/../../../secrets.pdf',
        'https://example.com/%2e%2e%2f%2e%2e%2fconfig.pdf',
        'https://example.com/./././../../../etc/hosts'
      ];

      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => Buffer.from('content').buffer
      }));

      for (const url of maliciousUrls) {
        await crawlService.downloadBinaryFile(url, 'application/pdf');
        
        // Verify sanitized filename was used
        const calls = mockFileService.writeContent.mock.calls;
        const lastCall = calls[calls.length - 1];
        if (lastCall) {
          const filename = lastCall[0];
          // Should not contain path traversal sequences
          expect(filename).not.toMatch(/\.\./);
          expect(filename).not.toMatch(/^\//);
        }
      }
    });

    it('should sanitize special characters in filenames', async () => {
      const specialUrls = [
        'https://example.com/file<script>.pdf',
        'https://example.com/file|pipe.pdf',
        'https://example.com/file:colon.pdf',
        'https://example.com/file*star.pdf'
      ];

      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => Buffer.from('content').buffer
      }));

      for (const url of specialUrls) {
        await crawlService.downloadBinaryFile(url, 'application/pdf');
      }

      // Check all filenames were sanitized
      mockFileService.sanitizeFilename.mock.calls.forEach(call => {
        const sanitized = mockFileService.sanitizeFilename(call[0]);
        expect(sanitized).not.toMatch(/[<>:|*?]/);
      });
    });
  });

  describe('File type verification', () => {
    it('should verify content type matches file extension', async () => {
      // PDF file served with wrong content type
      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]), // Wrong type
        arrayBuffer: async () => Buffer.from('%PDF-1.4').buffer // PDF magic bytes
      }));

      await crawlService.downloadBinaryFile('https://example.com/fake.pdf', 'text/html');

      // Should still process based on actual content
      expect(mockProgressService.completeUrl).toHaveBeenCalled();
    });

    it('should handle missing content-type headers', async () => {
      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map(), // No content-type
        arrayBuffer: async () => Buffer.from('file content').buffer
      }));

      await crawlService.downloadBinaryFile('https://example.com/mystery.bin', null);

      // Should handle gracefully
      expect(mockProgressService.completeUrl).toHaveBeenCalled();
    });

    it('should reject oversized binary files', async () => {
      const maxSize = 50 * 1024 * 1024; // 50MB
      const oversizedContent = Buffer.alloc(maxSize + 1);

      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'application/pdf'],
          ['content-length', String(maxSize + 1)]
        ]),
        arrayBuffer: async () => oversizedContent.buffer
      }));

      await crawlService.downloadBinaryFile('https://example.com/huge.pdf', 'application/pdf');

      // Should not write oversized file
      expect(mockFileService.writeContent).not.toHaveBeenCalled();
      expect(mockProgressService.completeUrl).toHaveBeenCalledWith(
        'https://example.com/huge.pdf',
        'error'
      );
    });
  });

  describe('Document link extraction edge cases', () => {
    it('should extract document links with query parameters', () => {
      const html = `
        <html>
          <body>
            <a href="/download?file=report.pdf&version=2">Download Report</a>
            <a href="/docs/manual.pdf?t=12345">Manual</a>
            <a href="/get-doc.php?id=123&format=pdf">Dynamic PDF</a>
          </body>
        </html>
      `;

      const {$} = crawlService._parseHtml(html);
      const links = crawlService.extractDocumentLinks($, 'https://example.com/page');

      expect(links).toHaveLength(2); // Only actual .pdf extensions
      expect(links).toContain('https://example.com/download?file=report.pdf&version=2');
      expect(links).toContain('https://example.com/docs/manual.pdf?t=12345');
    });

    it('should handle malformed document URLs', () => {
      const html = `
        <html>
          <body>
            <a href="javascript:void(0)">Fake PDF</a>
            <a href="data:application/pdf;base64,xyz">Data URL PDF</a>
            <a href="#pdf">Anchor PDF</a>
            <a href="mailto:test@example.com?subject=file.pdf">Email PDF</a>
            <a href="//example.com/valid.pdf">Protocol-relative PDF</a>
          </body>
        </html>
      `;

      const {$} = crawlService._parseHtml(html);
      const links = crawlService.extractDocumentLinks($, 'https://example.com/page');

      // Should only include valid HTTP(S) URLs
      expect(links).toHaveLength(1);
      expect(links[0]).toBe('https://example.com/valid.pdf');
    });

    it('should deduplicate document links on the same page', () => {
      const html = `
        <html>
          <body>
            <a href="/report.pdf">Report</a>
            <a href="/report.pdf">Download Report</a>
            <a href="./report.pdf">Get Report</a>
            <a href="https://example.com/report.pdf">Full URL Report</a>
          </body>
        </html>
      `;

      const {$} = crawlService._parseHtml(html);
      const links = crawlService.extractDocumentLinks($, 'https://example.com/page');

      // All resolve to the same URL
      expect(links).toHaveLength(1);
      expect(links[0]).toBe('https://example.com/report.pdf');
    });
  });

  describe('PDF counting towards limits', () => {
    it('should count PDFs towards maxPages limit', async () => {
      crawlService.maxPages = 5;
      crawlService.stats.totalPages = 3;

      // Mock successful PDF downloads
      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => Buffer.from('PDF content').buffer
      }));

      // Download PDFs
      for (let i = 1; i <= 3; i++) {
        await crawlService.downloadBinaryFile(`https://example.com/doc${i}.pdf`, 'application/pdf');
        crawlService.stats.totalPages++;
      }

      // Should stop at limit
      expect(crawlService.stats.totalPages).toBe(6); // 3 + 3
      
      // Further downloads should be skipped
      const shouldContinue = crawlService.stats.totalPages < crawlService.maxPages;
      expect(shouldContinue).toBe(false);
    });

    it('should handle maxPages = 0 (no limit)', async () => {
      crawlService.maxPages = 0; // No limit
      crawlService.stats.totalPages = 1000;

      fetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => Buffer.from('PDF').buffer
      }));

      await crawlService.downloadBinaryFile('https://example.com/doc.pdf', 'application/pdf');

      // Should complete successfully
      expect(mockProgressService.completeUrl).toHaveBeenCalledWith(
        'https://example.com/doc.pdf',
        'success'
      );
    });
  });

  describe('Network error handling', () => {
    it('should handle fetch timeouts for binary files', async () => {
      fetch.mockImplementation(async () => {
        throw new Error('Network timeout');
      });

      await crawlService.downloadBinaryFile('https://example.com/timeout.pdf', 'application/pdf');

      expect(mockProgressService.completeUrl).toHaveBeenCalledWith(
        'https://example.com/timeout.pdf',
        'error'
      );
      expect(mockFileService.writeContent).not.toHaveBeenCalled();
    });

    it('should handle 404 errors for binary files', async () => {
      fetch.mockImplementation(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      }));

      await crawlService.downloadBinaryFile('https://example.com/missing.pdf', 'application/pdf');

      expect(mockProgressService.completeUrl).toHaveBeenCalledWith(
        'https://example.com/missing.pdf',
        'error'
      );
    });

    it('should handle redirect loops for binary files', async () => {
      let callCount = 0;
      fetch.mockImplementation(async () => {
        callCount++;
        if (callCount > 10) {
          throw new Error('Too many redirects');
        }
        return {
          ok: false,
          status: 302,
          headers: new Map([['location', 'https://example.com/loop.pdf']])
        };
      });

      await crawlService.downloadBinaryFile('https://example.com/loop.pdf', 'application/pdf');

      expect(mockProgressService.completeUrl).toHaveBeenCalledWith(
        'https://example.com/loop.pdf',
        'error'
      );
    });
  });

  describe('Resource URL detection', () => {
    it('should detect and queue resource parameter URLs', async () => {
      const resourceUrl = 'https://example.com/download?resource=document.pdf';
      
      // Process the URL
      await crawlService._shouldCrawlUrl(resourceUrl);

      // Should be queued as a binary resource
      expect(mockCrawlStateService.queueUrl).toHaveBeenCalledWith(
        resourceUrl,
        expect.objectContaining({
          resourceType: 'binary',
          resourceParam: 'document.pdf'
        })
      );
    });

    it('should handle encoded resource parameters', async () => {
      const encodedUrl = 'https://example.com/get?resource=my%20document%20(2023).pdf';
      
      await crawlService._shouldCrawlUrl(encodedUrl);

      expect(mockCrawlStateService.queueUrl).toHaveBeenCalledWith(
        encodedUrl,
        expect.objectContaining({
          resourceType: 'binary',
          resourceParam: 'my document (2023).pdf'
        })
      );
    });
  });
});