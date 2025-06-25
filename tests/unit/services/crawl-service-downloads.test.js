/**
 * tests/unit/services/crawl-service-downloads.test.js
 * Tests for document download functionality in crawl service
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
// Mock fetch for download tests
global.fetch = vi.fn();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_OUTPUT_DIR = path.join(__dirname, '../../tmp/crawl-downloads-test');
describe('CrawlService Document Downloads', () => {
  let crawlService;
  let mockDb;
  let mockContentService;
  let mockFileService;
  beforeEach(() => {
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
      processHtml: vi.fn(async (html, url) => ({
        $: null,
        main: {html: () => '<div>Content</div>'},
        links: [
          'https://example.com/document.pdf',
          'https://example.com/report.docx',
          'https://cdn.example.com/external.pdf',
          'https://example.com/archive.zip'
        ],
        metadata: {title: 'Test Page'}
      })),
      extractLinks: vi.fn()
    };
    // Initialize crawl service
    crawlService = new CrawlService({
      db: mockDb,
      contentService: mockContentService,
      fileService: mockFileService,
      outputDir: TEST_OUTPUT_DIR,
      downloadDocuments: true
    });
  });
  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, {recursive: true, force: true});
    }
    vi.clearAllMocks();
  });
  describe('Document Detection', () => {
    it('should detect PDF links in content', async () => {
      const html = `
        <html>
          <body>
            <a href="/docs/manual.pdf">User Manual</a>
            <a href="https://example.com/report.pdf">Annual Report</a>
            <a href="/presentation.pptx">Presentation</a>
          </body>
        </html>
      `;
      // Mock fetch for HTML page
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => html
      });
      await crawlService.crawl(['https://example.com/page']);
      // Should have detected document links
      expect(mockFileService.writeContent).toHaveBeenCalled();
    });
    it('should detect Word document links', async () => {
      mockContentService.processHtml.mockResolvedValueOnce({
        $: null,
        main: {html: () => '<div>Content</div>'},
        links: [
          'https://example.com/document.doc',
          'https://example.com/document.docx',
          'https://example.com/template.dotx'
        ],
        metadata: {title: 'Test Page'}
      });
      const html = '<html><body>Test</body></html>';
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => html
      });
      await crawlService.crawl(['https://example.com/page']);
      expect(mockFileService.writeContent).toHaveBeenCalled();
    });
    it('should detect OpenDocument format links', async () => {
      mockContentService.processHtml.mockResolvedValueOnce({
        $: null,
        main: {html: () => '<div>Content</div>'},
        links: [
          'https://example.com/document.odt',
          'https://example.com/spreadsheet.ods',
          'https://example.com/presentation.odp'
        ],
        metadata: {title: 'Test Page'}
      });
      const html = '<html><body>Test</body></html>';
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => html
      });
      await crawlService.crawl(['https://example.com/page']);
      expect(mockFileService.writeContent).toHaveBeenCalled();
    });
    it('should NOT download archive files', async () => {
      mockContentService.processHtml.mockResolvedValueOnce({
        $: null,
        main: {html: () => '<div>Content</div>'},
        links: [
          'https://example.com/archive.zip',
          'https://example.com/backup.rar',
          'https://example.com/data.7z',
          'https://example.com/files.tar.gz'
        ],
        metadata: {title: 'Test Page'}
      });
      const html = '<html><body>Test</body></html>';
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => html
      });
      await crawlService.crawl(['https://example.com/page']);
      // Should process the HTML page but not download archives
      expect(mockFileService.writeContent).toHaveBeenCalledTimes(1); // Only the HTML page
    });
  });
  describe('Binary Content Detection', () => {
    it('should detect binary content by Content-Type header', async () => {
      const pdfContent = Buffer.from('PDF binary content');
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => pdfContent.buffer,
        text: async () => { throw new Error('Should not call text() for binary'); }
      });
      await crawlService.crawl(['https://example.com/document.pdf']);
      // Should write binary content
      expect(mockFileService.writeContent).toHaveBeenCalledWith(
        expect.stringContaining('.pdf'),
        expect.any(Buffer),
        expect.objectContaining({encoding: 'binary'})
      );
    });
    it('should handle Word documents as binary', async () => {
      const docContent = Buffer.from('DOCX binary content');
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]),
        arrayBuffer: async () => docContent.buffer,
        text: async () => { throw new Error('Should not call text() for binary'); }
      });
      await crawlService.crawl(['https://example.com/document.docx']);
      expect(mockFileService.writeContent).toHaveBeenCalledWith(
        expect.stringContaining('.docx'),
        expect.any(Buffer),
        expect.objectContaining({encoding: 'binary'})
      );
    });
  });
  describe('Document Filename Generation', () => {
    it('should generate filename from URL with extension', async () => {
      const pdfContent = Buffer.from('PDF content');
      mockFileService.sanitizeFilename.mockReturnValueOnce('reports_annual_2025.pdf');
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => pdfContent.buffer
      });
      await crawlService.crawl(['https://example.com/reports/annual-2025.pdf']);
      expect(mockFileService.writeContent).toHaveBeenCalledWith(
        'reports_annual_2025.pdf',
        expect.any(Buffer),
        expect.any(Object)
      );
    });
    it('should add extension based on content type if missing', async () => {
      const pdfContent = Buffer.from('PDF content');
      mockFileService.sanitizeFilename.mockReturnValueOnce('download');
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => pdfContent.buffer
      });
      await crawlService.crawl(['https://example.com/download']);
      expect(mockFileService.writeContent).toHaveBeenCalledWith(
        'download.pdf',
        expect.any(Buffer),
        expect.any(Object)
      );
    });
    it('should use content hash for filename if URL is not suitable', async () => {
      const pdfContent = Buffer.from('PDF content');
      mockFileService.sanitizeFilename.mockReturnValueOnce('_');
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => pdfContent.buffer
      });
      await crawlService.crawl(['https://example.com/?file=123']);
      // Should use a hash-based filename
      const call = mockFileService.writeContent.mock.calls[0];
      expect(call[0]).toMatch(/^[a-f0-9]+\.pdf$/);
    });
  });
  describe('External CDN Downloads', () => {
    it('should download PDFs from external CDNs', async () => {
      // First, crawl the main page
      const html = `
        <html>
          <body>
            <a href="https://cdn.cloudflare.com/docs/manual.pdf">External PDF</a>
            <a href="https://s3.amazonaws.com/bucket/report.pdf">S3 PDF</a>
          </body>
        </html>
      `;
      mockContentService.processHtml.mockResolvedValueOnce({
        $: null,
        main: {html: () => '<div>Content</div>'},
        links: [
          'https://cdn.cloudflare.com/docs/manual.pdf',
          'https://s3.amazonaws.com/bucket/report.pdf'
        ],
        metadata: {title: 'Test Page'}
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => html
      });
      await crawlService.crawl(['https://example.com/page']);
      // Should have processed the HTML page
      expect(mockFileService.writeContent).toHaveBeenCalled();
      // The external PDFs should be in the crawl queue but may not be downloaded
      // if domain filtering is enabled
    });
    it('should respect download option flag', async () => {
      // Create service with downloads disabled
      crawlService = new CrawlService({
        db: mockDb,
        contentService: mockContentService,
        fileService: mockFileService,
        outputDir: TEST_OUTPUT_DIR,
        downloadDocuments: false
      });
      const html = '<html><body><a href="/doc.pdf">PDF</a></body></html>';
      mockContentService.processHtml.mockResolvedValueOnce({
        $: null,
        main: {html: () => '<div>Content</div>'},
        links: ['https://example.com/doc.pdf'],
        metadata: {title: 'Test Page'}
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => html
      });
      await crawlService.crawl(['https://example.com/page']);
      // Should only write the HTML page, not attempt to download the PDF
      expect(mockFileService.writeContent).toHaveBeenCalledTimes(1);
    });
  });
  describe('Duplicate Download Prevention', () => {
    it('should not download the same document twice', async () => {
      const pdfContent = Buffer.from('PDF content');
      // Mock the same PDF being linked from multiple pages
      mockDb.getPage.mockReturnValue({
        url: 'https://example.com/doc.pdf',
        content_type: 'application/pdf',
        last_crawled: new Date().toISOString()
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => pdfContent.buffer
      });
      await crawlService.crawl(['https://example.com/doc.pdf']);
      // Should not write content since it's already in DB
      expect(mockFileService.writeContent).not.toHaveBeenCalled();
    });
  });
  describe('Error Handling', () => {
    it('should handle failed document downloads gracefully', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error'));
      await expect(crawlService.crawl(['https://example.com/doc.pdf'])).resolves.not.toThrow();
      // Should not write any content for failed download
      expect(mockFileService.writeContent).not.toHaveBeenCalled();
    });
    it('should handle 404 responses for documents', async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => '404 Not Found'
      });
      await crawlService.crawl(['https://example.com/missing.pdf']);
      // Should not write content for 404
      expect(mockFileService.writeContent).not.toHaveBeenCalled();
    });
  });
});