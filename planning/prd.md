# site2rag - Product Requirements Document

## Overview

A CLI tool designed for `npx` execution that converts entire websites into maintained, RAG-ready local knowledge bases with intelligent change detection and asset management. Optimized for local RAG workflows and research applications.

## Core Value Proposition

**Transform any website into a structured, searchable knowledge base that can be easily updated and integrated with local AI tools.**

## Target Users

- **Researchers** building knowledge bases from documentation sites
- **AI Engineers** creating RAG datasets from web content
- **Content Creators** archiving and analyzing competitor sites
- **Developers** documenting API references and technical resources

## User Stories

### Primary Use Cases

**As a researcher, I want to:**
- Download an entire documentation site for offline analysis
- Quickly update only changed content on subsequent crawls
- Have clean markdown with proper citations for each page
- Access all site assets (images, documents) locally

**As an AI engineer, I want to:**
- Create RAG-ready datasets from websites
- Have consistent YAML frontmatter for metadata extraction
- Exclude navigation/UI chrome from content
- Track crawl history and content changes

**As a content creator, I want to:**
- Archive competitor sites for analysis
- Compare content changes over time
- Export clean markdown for publication workflows
- Maintain asset relationships and references

## Core Features

### 1. Intelligent Site Crawling
- **Recursive discovery** starting from URL
- **Respect robots.txt** and rate limiting
- **Smart boundary detection** (stay within domain/path)
- **Duplicate URL handling** (normalize URLs, handle redirects)
- **Concurrent processing** with configurable limits

### 2. Change Detection & State Management
- **`.crawl` state file** tracking URLs, timestamps, content hashes
- **Incremental updates** - only re-download changed content
- **ETag/Last-Modified** header support
- **Content hash comparison** for change detection
- **Crawl session metadata** (date, duration, pages processed)

### 3. AI-Enhanced Markdown Generation
- **AI-powered content extraction** using local models (Ollama default, supports OpenAI/Anthropic)
- **Smart chrome removal** via semantic analysis, not just CSS selectors
- **Structured YAML frontmatter** with comprehensive metadata
- **Reference-style links** for better LLM context
- **Content classification** to identify valuable vs. boilerplate content
- **Flexible output formats** - hierarchical folders or flat structure for RAG systems

### 4. Asset Management
- **Download linked assets** (images, PDFs, DOCX, etc.)
- **Maintain relative paths** in markdown
- **Asset deduplication** by content hash
- **Organize by content type** in structured folders

### 5. AI Integration & RAG Context Disambiguation
- **Local AI processing** using Ollama (default), OpenAI, or Anthropic
- **Smart content classification** to distinguish main content from boilerplate
- **RAG Context Disambiguation** - two-pass entity extraction with context caching for enhanced search relevance
- **Content enhancement** adding context and improving structure
- **Model fallbacks** for robust operation
- **Provider flexibility** - not locked to any specific AI service

#### RAG Context Disambiguation System
**Purpose**: Enhance individual paragraphs with disambiguating context so they can stand alone when retrieved by RAG systems, dramatically improving search relevance and context understanding.

**Two-Pass Architecture**:
- **Pass 1: Entity Extraction** - Build comprehensive entity graph with sliding windows for large documents
- **Pass 2: Context Enhancement** - Enhance each content block with entity-aware disambiguation using cached context

**Enhanced Disambiguation Types** (13 rules):
1. **Document-Only Context** - Only add context found elsewhere in the document
2. **Pronoun Clarification** - "he" → "he (Chad Jones)", "they" → "they (US Publishing Trust)"
3. **Technical Terms** - "Ocean" → "Ocean (Bahá'í literature search software)"
4. **Products/Projects** - "Sifter" → "Sifter - Star of the West"
5. **Temporal Context** - "back then" → "in the 1990s"
6. **Geographic Specificity** - "India" → "India (where author learned programming)"
7. **Roles/Relationships** - "Mr. Shah" → "Mr. Shah (project supporter)"
8. **Acronym Expansion** - "US" → "United States", "PC" → "personal computer"
9. **Cross-References** - "this mailing" → "the global CD distribution"
10. **Parenthetical Style** - Brief clarifications that preserve flow
11. **No Repetition** - Don't repeat information already clear
12. **Preserve Meaning** - Maintain original meaning and flow exactly
13. **JSON Format** - Always return valid structured responses

**Cache-Optimized Performance**:
- **4.2x speed improvement** through AI session context caching
- **90% cache hit rate** after first block
- **76% efficiency gain** in processing time
- **Document-level context reuse** eliminates redundant prompt processing

**Example Enhancement**:
```markdown
Before: "I started working on the project in India."
After:  "I (Chad Jones, author) started working on the project in India (where author learned programming)."
```

**No Hallucination Policy**: All disambiguation context must be derived from information found elsewhere in the same document - no external knowledge is added.

### 6. Progress Tracking & Logging
- **Real-time progress display** with URL queue status
- **Detailed logging** with configurable verbosity
- **Error handling** with retry mechanisms
- **Summary reports** of crawl results

## Technical Architecture

### Minimal Tech Stack
- **Dependencies**: `cheerio` (2MB), `turndown` (100KB), `better-sqlite3` (5MB)
- **Native APIs**: `fetch`, `fs/promises`, `URL`, `crypto`
- **Concurrency**: `p-limit` for elegant promise management
- **Robots.txt**: Native parser with rate limiting compliance

### Code Style Requirements

**Modern ES6+ Architecture**:
- **Terse, non-verbose**: Minimal code lines to accomplish functionality
- **Promise-based**: Leverage async/await, promise chaining, and modern patterns
- **Class-based design**: Clean OOP structure with focused responsibilities
- **Functional composition**: Method chaining and functional programming patterns
- **Minimal whitespace**: No extra blank lines - whitespace must be meaningful
- **Dependency-first**: Prefer existing npm modules over custom implementations

**Code Quality Philosophy**:
- **Easy maintenance** through minimal application code
- **Leverage ecosystem**: Slightly larger package size acceptable for much smaller codebase
- **Modern best practices**: ES6 modules, destructuring, arrow functions, template literals
- **Readable terseness**: Compact but clear - avoid verbose variable names and unnecessary comments
- **No reimplementation**: Use proven npm packages for common functionality

**Example Style**:
```javascript
class SiteProcessor {
  constructor(config) { this.config = config; this.limit = pLimit(config.concurrency) }
  async process(urls) { return Promise.all(urls.map(url => this.limit(() => this.crawlPage(url)))) }
  async crawlPage(url) {
    const content = await fetch(url).then(r => r.text())
    return this.hasChanged(url, content) ? this.saveContent(url, content) : 'cached'
  }
}
```

### Command Structure
```bash
# Basic usage
npx site2rag docs.example.com

# Advanced options
npx site2rag docs.example.com \
  --output ./knowledge-base \
  --include "*/docs/*,*/api/*" \
  --exclude "*/admin/*" \
  --max-depth 5 \
  --concurrency 3 \
  --flat \
  --update
```

### File Structure

**Hierarchical Mode (default):**
```
./output-directory/
├── .site2rag/               # State and config
│   ├── crawl.db            # SQLite database
│   └── config.json         # Crawl configuration
├── index.md                 # Root page
├── docs/
│   ├── getting-started.md
│   └── api-reference.md
├── blog/
│   └── 2024-update.md
└── assets/                  # Downloaded assets
    ├── images/
    └── documents/
```

**Flat Mode (--flat, optimized for RAG):**
```
./output-directory/
├── .site2rag/               # State and config
│   ├── crawl.db            # SQLite database
│   └── config.json         # Crawl configuration
├── index.md                 # Root page
├── docs_getting-started.md  # Flattened with path-derived names
├── docs_api-reference.md
├── blog_2024-update.md
└── assets/                  # Downloaded assets
    ├── images/
    └── documents/
```

### YAML Frontmatter Schema
```yaml
---
url: "https://docs.example.com/getting-started"
title: "Getting Started Guide"
canonical: "https://docs.example.com/getting-started"
crawled_at: "2025-06-06T10:30:00Z"
last_modified: "2025-06-01T14:22:00Z"
content_hash: "sha256:abc123..."
content_type: "article"
word_count: 1247
reading_time: 5
tags: ["documentation", "tutorial"]
breadcrumbs: ["Home", "Docs", "Getting Started"]
internal_links: 12
external_links: 3
assets: ["./assets/images/screenshot1.png", "./assets/documents/guide.pdf"]
---
```

### SQLite State Management
```sql
-- Lightweight, ACID-compliant, resume-friendly database
CREATE TABLE pages (
  url TEXT PRIMARY KEY,
  content_hash TEXT,
  last_modified TEXT,
  crawled_at TEXT,
  depth INTEGER,
  status TEXT,
  filepath TEXT,
  word_count INTEGER
);

CREATE TABLE assets (
  url TEXT PRIMARY KEY,
  content_hash TEXT,
  local_path TEXT,
  downloaded_at TEXT,
  size INTEGER
);

CREATE TABLE crawl_sessions (
  id INTEGER PRIMARY KEY,
  site_url TEXT,
  started_at TEXT,
  completed_at TEXT,
  pages_crawled INTEGER,
  config TEXT -- JSON blob
);

-- Indexes for fast lookups
CREATE INDEX idx_pages_status ON pages(status);
CREATE INDEX idx_pages_crawled ON pages(crawled_at);
```
```

## CLI Interface Design

### Commands
```bash
# Primary command
npx site2rag <url> [options]

# Update existing crawl
npx site2rag --update [--output ./existing-dir]

# Status check
npx site2rag --status [--output ./dir]

# Clean/reset crawl
npx site2rag --clean [--output ./dir]
```

### CLI Options

- `--output, -o <dir>` - Output directory (default: ./domain)
- `--init` - Initialize site folder with default config
- `--setup` - Interactive configuration setup with prompts
- `--include <patterns>` - Include URL patterns (comma-separated globs)
- `--exclude <patterns>` - Exclude URL patterns (comma-separated globs)
- `--max-depth <num>` - Maximum crawl depth (default: 3)
- `--concurrency <num>` - Concurrent requests (default: 2)
- `--delay <ms>` - Delay between requests (default: 500ms)
- `--user-agent <string>` - Custom user agent
- `--update` - Update existing crawl (only changed content)
- `--force` - Force re-download all content
- `--dry-run` - Show what would be crawled without downloading
- `--flat` - Store all files in top-level folder with path-derived names (for RAG systems)
- `--verbose, -v` - Verbose logging
- `--quiet, -q` - Minimal output

### Progress Display
```
🕷️  Crawling https://docs.example.com

📊 Progress
├── Pages: 23/47 discovered ████████████░░░░░░░░ 49%
├── Queue: 8 pending, 3 processing
├── Assets: 15 downloaded
└── Errors: 2 failed, 1 retry

🔄 Current: /docs/api-reference
⏱️  Elapsed: 2m 15s | Est. remaining: 3m 42s

📝 Recent:
✅ /docs/getting-started (updated, 3.2kb)
✅ /docs/installation (cached)
❌ /docs/troubleshooting (404 error)
⏳ /docs/api-reference (downloading...)
```

## Content Processing Pipeline

### 1. Polite Crawling (wget-like)
- **robots.txt compliance** with native parser
- **Adaptive rate limiting** based on server response times
- **p-limit concurrency** for elegant promise management
- **Exponential backoff** for 429/5xx responses

### 2. Smart Content Extraction
- **Content scoring** using text density, semantic HTML, link ratios
- **Boilerplate removal** with heuristic filtering
- **Asset discovery** and local path rewriting
- **Incremental updates** via content hashing

### 3. Resumable Operations
- **SQLite state** for ACID-compliant resume capability
- **Atomic writes** prevent corruption on interruption
- **Progress checkpointing** every N pages processed
- **Graceful shutdown** handling

## Configuration System

### Config File (<site-project>/.site2rag/crawl.json)
```json
{
  "default": {
    "concurrency": 2,
    "delay": 500,
    "max_depth": 3,
    "user_agent": "site2rag/1.0 (+https://github.com/company/site2rag)"
  },
  "filters": {
    "content_selectors": ["main", "article", ".content", "#content"],
    "exclude_selectors": ["nav", "header", "footer", ".sidebar", ".ads"],
    "min_content_length": 100,
    "max_link_density": 0.3
  },
  "assets": {
    "download_images": true,
    "download_documents": true,
    "max_file_size": "10MB",
    "allowed_extensions": [".jpg", ".png", ".gif", ".pdf", ".docx", ".svg"]
  }
}
```

## Error Handling & Resilience

### Retry Logic
- **Network errors**: Exponential backoff (3 retries max)
- **Rate limiting**: Respect 429 responses, increase delays
- **Parsing errors**: Log and continue with other pages
- **Asset download failures**: Continue crawl, log missing assets

### Graceful Degradation
- **JavaScript-heavy sites**: Extract what's available in static HTML
- **Auth-required pages**: Skip with clear logging
- **Large files**: Skip assets over size limit
- **Malformed HTML**: Best-effort parsing with fallbacks

## Performance Considerations

### Memory Management
- **Streaming downloads** for large assets
- **Garbage collection** of processed HTML
- **Limited queue size** to prevent memory bloat
- **Asset size limits** to avoid large downloads

### Disk I/O Optimization
- **Batch file writes** to reduce I/O operations
- **Atomic updates** to prevent corruption
- **Efficient state updates** (only changed entries)
- **Asset deduplication** by content hash

### Network Efficiency
- **HTTP/2 support** where available
- **Connection pooling** for same-origin requests
- **Conditional requests** using ETags/Last-Modified
- **Intelligent retries** with circuit breaker pattern

## Testing Strategy

### Comprehensive Test Coverage
- **Unit Tests**: Fast, isolated component testing with >90% coverage
- **Integration Tests**: End-to-end workflow validation
- **Real Website Testing**: Manual validation with actual sites
- **Consistent Naming**: kebab-case convention for all test files

**Detailed testing documentation**: See [tests/README.md](../tests/README.md)

### Test Organization
```
tests/
├── unit/                   # Fast, isolated component tests
├── integration/           # End-to-end workflow tests  
├── fixtures/              # Static test data (committed)
└── tmp/                   # Temporary outputs (gitignored)
```

## Success Metrics

### Primary KPIs
- **Content Accuracy**: 95%+ of pages successfully converted to clean markdown
- **Change Detection**: 99%+ accurate identification of updated content
- **Performance**: Complete documentation sites (100-500 pages) in <5 minutes
- **Reliability**: 99%+ uptime with graceful error handling

### User Experience Metrics
- **Setup Time**: <30 seconds from npx command to first results
- **Update Speed**: 10x faster than full re-crawl for incremental updates
- **Storage Efficiency**: 50%+ reduction vs storing raw HTML

## Future Enhancements (v2.0)

### Document Conversion Pipeline
- **PDF → Markdown**: Using Pandoc or cloud services
- **DOCX → Markdown**: Native conversion with structure preservation
- **Unified citation format**: Consistent frontmatter across all content types

### Advanced Features
- **Multiple output formats**: JSON, XML, custom schemas
- **Plugin system**: Custom content processors and filters
- **Site-specific adapters**: Optimized crawling for popular CMS platforms
- **Cloud sync**: Integration with S3, GitHub, etc.

### Analytics & Insights
- **Content change tracking**: Diff visualization between crawls
- **Site structure analysis**: Broken links, content gaps
- **SEO metrics**: Extract meta descriptions, keywords, structure

This design gives users the flexibility to optimize for their specific use case - file system for RAG workflows, database for programmatic access - while maintaining the same simple CLI interface and efficient re-crawling behavior.

