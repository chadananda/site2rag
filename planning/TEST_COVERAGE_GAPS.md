# Test Coverage Gaps Analysis

## Current Test Status

### Test Execution Summary
- **Total Tests**: 239 (65 failed, 173 passed, 1 skipped)
- **Major Issues**: 
  - 18 test files failing
  - Mock configuration issues with `cli-progress` and `path` modules
  - Import/export mismatches in several test files

### Service Test Status

1. **Content Service** ✅ (8 tests, 1 skipped)
   - Basic metadata extraction is tested
   - HTML processing is tested
   - Link extraction is tested

2. **Markdown Service** ✅ (10 tests passing)
   - Basic HTML to markdown conversion
   - Frontmatter handling
   - Table and code block conversion

3. **Crawl Service** ❌ (Failing due to mock issues)
   - Tests exist but failing due to module import errors
   
4. **Crawl Service Sitemap** ✅ (3 tests passing)
   - Basic sitemap handling tests

## Missing Test Coverage

### 1. JSON-LD Preservation and Extraction
**File**: `src/services/content_service.js`
**Functions**: `extractJsonLd()`, `preserveJsonLd()`

Missing tests:
- Extraction of JSON-LD structured data from script tags
- Handling of multiple JSON-LD scripts on a page
- Parsing different @type schemas (Article, NewsArticle, BlogPosting, PodcastEpisode, Person)
- Invalid JSON-LD handling
- JSON-LD data preservation in markdown output
- Person data extraction for author bios

### 2. Enhanced Metadata Extraction
**File**: `src/services/content_service.js`
**Function**: `extractMetadata()`

Missing tests:
- Fallback chain for title extraction (JSON-LD → basic meta → OG meta)
- Author extraction with multiple sources including byline search
- Dublin Core metadata extraction
- Article metadata (published_time, modified_time, tags)
- Keywords aggregation from multiple sources
- Author bio/description from Person JSON-LD objects
- Publisher extraction from JSON-LD and OG metadata
- License extraction from JSON-LD

### 3. Author Byline Detection
**File**: `src/services/content_service.js`
**Function**: `extractAuthor()`

Missing tests:
- Byline detection in content (patterns like "By John Doe")
- Author extraction from various selectors (.author, .byline, etc.)
- Author link extraction and text normalization
- Fallback chain testing (JSON-LD → meta tags → Dublin Core → byline)

### 4. Document Download Detection and Handling
**File**: `src/services/crawl_service.js`
**Functions**: `downloadPDFsFromPage()`, binary file handling

Missing tests:
- Detection of downloadable document links (PDF, DOC, DOCX, ODT, RTF)
- URL resolution for document links
- Binary content type detection
- Document filename generation from URL or content hash
- Duplicate download prevention
- Document storage in correct subdirectory structure
- Progress tracking for document downloads
- Binary files tracked as first-class pages in database
- Change detection for binary files (re-download when source changes)
- PDF metadata tracking (is_pdf, pdf_conversion_status, pdf_md_path)

### 5. Binary Content Handling
**File**: `src/services/crawl_service.js`
**Function**: Binary response handling in `crawl()`

Missing tests:
- Content-Type based binary detection
- Binary file saving with appropriate extensions
- Buffer handling for large files
- Error handling for failed downloads
- Filename generation for documents without extensions

### 6. Context Disambiguation Processing
**File**: `src/core/context_processor_simple.js`

Missing tests:
- Plain text response parsing (blocks separated by blank lines)
- Strict validation of `[[context]]` insertions only
- Window creation with 1200/600 word sizes
- Header and code block skipping
- Text cleaning for context (removing markdown/links/images)
- Parallel processing with rate limiting

## Critical Gaps Requiring Immediate Attention

1. **JSON-LD Support**: No tests exist for the JSON-LD extraction and preservation functionality
2. **Document Downloads**: No tests for PDF/Word document detection and download logic
3. **Enhanced Metadata**: Limited testing of the comprehensive metadata extraction chain
4. **Author Bio Extraction**: No tests for Person schema extraction and author bio handling

## Recommended Test Additions

### Priority 1: JSON-LD Tests
```javascript
describe('extractJsonLd', () => {
  it('should extract Article JSON-LD data')
  it('should handle multiple JSON-LD scripts')
  it('should extract Person data for author bios')
  it('should handle invalid JSON gracefully')
  it('should preserve JSON-LD in markdown output')
})
```

### Priority 2: Document Download Tests
```javascript
describe('Document Downloads', () => {
  it('should detect PDF links in content')
  it('should detect Word document links')
  it('should download and save documents with correct filenames')
  it('should skip already downloaded documents')
  it('should handle binary content types correctly')
})
```

### Priority 3: Enhanced Metadata Tests
```javascript
describe('Enhanced Metadata Extraction', () => {
  it('should follow title fallback chain')
  it('should extract author from multiple sources')
  it('should aggregate keywords from all sources')
  it('should extract article dates correctly')
  it('should include author bio from Person JSON-LD')
})
```

## Test Infrastructure Issues

1. **Mock Configuration**: Need to fix mock setups for:
   - `cli-progress` module
   - `path` module in database utils
   - File system mocks in several tests

2. **Import/Export Mismatches**: Several test files have incorrect import statements

3. **Test Organization**: Some tests are in wrong directories or have incorrect naming