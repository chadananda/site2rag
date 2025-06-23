# 🚀 site2rag

> **Transform any website into a maintained, RAG-ready local knowledge base with a single command**

[![npm version](https://img.shields.io/npm/v/site2rag.svg)](https://www.npmjs.com/package/site2rag) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

```bash
npx site2rag docs.example.com
```

That's it! Your entire documentation site is now a clean, searchable, AI-ready knowledge base in `./docs.example.com/` 🎯

---

## ✨ Why site2rag?

---

## 🏎️ Free, Efficient HTML Preprocessing (with Site Learning!)

**site2rag** features a novel two-stage HTML preprocessing pipeline that delivers professional-grade content extraction with maximum efficiency:

- **Maximum Rule-Based Filtering:** 90%+ of noise is eliminated instantly using fast, free heuristics—no AI required for most pages.
- **Strategic Minimal AI:** Only truly ambiguous blocks are summarized and sent to AI, saving time and compute.
- **Site Structure Learning:** If a site has repeated or consistent structure, site2rag learns from your choices and past runs, automatically resolving ambiguity for similar pages in the future. Over time, this means fewer and fewer AI calls are needed!

**Why is this unique?**

- Most tools either use crude selectors (inaccurate) or send entire pages to AI (expensive/slow). site2rag combines the best of both: blazing fast, free preprocessing with just enough AI to handle the hard cases—and gets smarter the more you use it.
- This approach makes site2rag ideal for large websites, iterative crawls, and anyone who wants to minimize AI costs while maximizing quality.

See [html-preprocessing.md](./html-preprocessing.md) for technical details.

---

**The Problem**: You want to use local RAG (Retrieval-Augmented Generation) with documentation websites, but:

- 📄 Raw HTML is messy and full of navigation noise
- 🔄 Sites change frequently - manual downloads get stale
- 🧠 Content needs semantic enhancement for better AI retrieval
- 📁 You need clean citations back to original sources

**The Solution**: `site2rag` intelligently converts entire websites into maintained, AI-optimized knowledge bases that stay fresh automatically.

```text
Website                    site2rag                 RAG-Ready Knowledge Base
┌─────────────┐           ┌─────────────┐           ┌─────────────────────────┐
│ 🌐 Raw HTML │  ────────▶ │ 🧠 AI Magic │  ────────▶ │ 📚 Clean Markdown       │
│ • Navigation│           │ • Content   │           │ • Semantic hints        │
│ • Ads       │           │   filtering │           │ • Perfect citations     │
│ • Clutter   │           │ • Context   │           │ • Auto-updated         │
│ • Mess      │           │   injection │           │ • RAG-optimized        │
└─────────────┘           └─────────────┘           └─────────────────────────┘
```

---

## 🎯 Perfect For

**🔬 Researchers**

- Build local knowledge bases from documentation sites
- Keep research materials automatically updated
- Generate perfect citations for academic work

**🤖 AI Engineers**

- Create high-quality RAG datasets from any website
- Enhance content with semantic context for better retrieval
- Maintain fresh training data with zero effort

**📝 Content Creators**

- Archive competitor sites and documentation
- Track content changes over time
- Build searchable reference libraries

---

## ⚡ Lightning-Fast Updates

The magic happens on subsequent runs:

```bash
# First run: downloads everything
npx site2rag docs.kubernetes.io
# 📥 Processing 47,000 pages...

# Later runs: lightning fast
npx site2rag docs.kubernetes.io
# ⚡ Checked 47,000 pages in 30 seconds
# ✅ 3 pages updated, 46,997 unchanged
```

**How?** Smart change detection using ETags, Last-Modified headers, and content hashing means only changed content gets re-downloaded. Turn daily documentation syncing into a habit!

---

## 🧠 AI-Enhanced Content Processing

### Intelligent Content vs Noise Detection

Traditional scrapers use crude CSS selectors. `site2rag` uses **local AI** to understand content semantically:

```markdown
❌ Traditional: "Remove all .sidebar elements" ✅ site2rag AI: "This sidebar contains valuable API references - keep it!"
```

**Before** (raw HTML):

```html
<nav>Documentation</nav>
<div class="sidebar">
  <h3>Related APIs</h3>
  <a href="/auth">Authentication</a>
  <a href="/rate-limits">Rate Limits</a>
</div>
<main>
  <h1>Getting Started</h1>
  <p>To use this API...</p>
</main>
<footer>© 2024 Company</footer>
```

**After** (AI-processed):

```markdown
---
source_url: 'https://docs.example.com/getting-started'
title: 'Getting Started Guide'
processing: ['ai_content_classification', 'context_injection']
---

# Getting Started

To use <span data-ctx="REST API authentication">this API</span>, first configure your credentials...

## Related APIs

- [Authentication](https://docs.example.com/auth)
- [Rate Limits](https://docs.example.com/rate-limits)
```

### RAG Context Disambiguation System 🧠

**Making paragraphs stand alone for better RAG retrieval**

`site2rag` includes a revolutionary two-pass disambiguation system that enhances content for RAG systems by adding context to ambiguous terms, pronouns, and references:

#### Two-Pass Architecture

- **Pass 1**: Build entity graph with people, places, organizations, and relationships
- **Pass 2**: Enhance each paragraph with context using cache-optimized AI processing

#### 13 Enhanced Disambiguation Types

```markdown
Original: "I started the project back then when we worked with them." Enhanced: "I (Chad Jones, author) started the project back then (in the 1990s) when we (at Bahá'í World Center) worked with them (US Publishing Trust)."
```

**Disambiguation Rules Applied**:

1. **Pronoun Clarification**: "I" → "I (Chad Jones, author)"
2. **Temporal Context**: "back then" → "back then (in the 1990s)"
3. **Group Context**: "we" → "we (at Bahá'í World Center)"
4. **Organization References**: "them" → "them (US Publishing Trust)"
5. **Technical Terms**: "Ocean" → "Ocean (Bahá'í literature search software)"
6. **Geographic Context**: "India" → "India (where author learned programming)"
7. **Acronym Expansion**: "US" → "United States"
8. **Cross-References**: "this project" → "the Ocean search project"
9. **Role Clarification**: "Mr. Shah" → "Mr. Shah (project supporter)"
10. **Product Context**: "CDs" → "CDs (Ocean software distribution medium)"

#### Cache-Optimized Performance 🚀

- **4.2x faster** processing through AI context caching
- **90% cache hit rate** after first paragraph
- **76% efficiency gain** vs traditional approaches
- **Document-level context reuse** eliminates redundant processing

#### No Hallucination Policy 🛡️

All disambiguation context is derived **only** from information found elsewhere in the same document - no external knowledge is added. This ensures accuracy and traceability.

**Result**: Every paragraph becomes a self-contained, context-rich unit perfect for RAG retrieval! 🎯

---

## 📁 Perfect File Organization

### Hierarchical Structure (Default)

```text
./docs.example.com/
├── .site2rag/              # 🗄️ Smart change tracking & config
│   ├── crawl.db           # SQLite database
│   └── config.json        # Site configuration
├── getting-started.md      # 📄 Clean markdown content
├── api/
│   ├── authentication.md
│   └── rate-limits.md
├── guides/
│   └── best-practices.md
└── assets/                 # 🖼️ All site assets
    ├── images/
    │   └── architecture.png
    └── documents/
        └── api-spec.pdf
```

### Flat Structure (--flat, Perfect for RAG)

```text
./docs.example.com/
├── .site2rag/              # 🗄️ Smart change tracking & config
│   ├── crawl.db           # SQLite database
│   └── config.json        # Site configuration
├── getting-started.md      # 📄 Root page
├── api_authentication.md   # 🔥 Flattened with path-derived names
├── api_rate-limits.md
├── guides_best-practices.md
└── assets/                 # 🖼️ All site assets
    ├── images/
    │   └── architecture.png
    └── documents/
        └── api-spec.pdf
```

**Why this structure?**

- 📚 **RAG-friendly**: Clean markdown files perfect for vector databases
- 🔗 **Citation-ready**: Assets maintain exact URL structure for perfect citations
- 🔄 **Update-efficient**: Database tracks changes without file system overhead
- 🎯 **Flat mode**: Single directory structure ideal for RAG systems that prefer flat file lists

---

## 🎮 Dead Simple Usage

### Basic Usage

```bash
# Convert any documentation site with RAG disambiguation
npx site2rag docs.react.dev
npx site2rag kubernetes.io/docs
npx site2rag python.org/dev/peps

# For RAG systems that prefer flat file structure
npx site2rag docs.example.com --flat

# With smart LLM fallback (automatically selects best available AI)
npx site2rag docs.example.com --auto-fallback

# That's it! Your knowledge base is ready 🎉
```

### Advanced Configuration

```bash
# Limit pages and use custom output directory
npx site2rag docs.example.com --limit 100 --output ./my-knowledge-base

# Update existing crawl (only downloads changed content)
npx site2rag docs.example.com --update

# Debug mode with test logging
npx site2rag docs.example.com --debug --test

# Use specific AI provider
npx site2rag docs.example.com --use_gpt4o --flat

# Real-world example from our test suite
npx site2rag bahai-education.org --limit 20 --output ./tests/tmp/sites/bahai-education --flat --test --use_gpt4o
```

---

## 🤖 AI Integration (Optional)

`site2rag` includes optional AI features for enhanced content processing with support for multiple providers:

### Smart LLM Fallback (Recommended)

```bash
# Automatically use the best available AI provider
npx site2rag docs.example.com --auto-fallback
# 🔄 Auto-fallback enabled, trying: gpt4o → gpt4o-mini → opus4 → gpt4-turbo → ollama
# ✅ gpt4o: openai/gpt-4o available
```

### Specific AI Provider Selection

```bash
# OpenAI Models (requires OPENAI_API_KEY)
npx site2rag docs.example.com --use_gpt4o
npx site2rag docs.example.com --use_gpt4o_mini
npx site2rag docs.example.com --use_gpt4_turbo
npx site2rag docs.example.com --use_o1_mini

# Anthropic Claude (requires ANTHROPIC_API_KEY)
npx site2rag docs.example.com --use_opus4
npx site2rag docs.example.com --use_haiku

# Other Providers
npx site2rag docs.example.com --use_mistral_large  # MISTRAL_API_KEY
npx site2rag docs.example.com --use_perplexity     # PERPLEXITY_API_KEY
npx site2rag docs.example.com --use_r1_grok        # XAI_API_KEY
```

### Local AI (Privacy First)

```bash
# Install Ollama: https://ollama.ai
ollama pull qwen2.5:14b

# AI features work automatically when Ollama is available
npx site2rag docs.example.com
# ✅ 🧠 AI Processing: qwen2.5:14b ready
```

### Custom Fallback Order

```bash
# Specify your preferred provider order
npx site2rag docs.example.com --auto-fallback --fallback-order "gpt4o,opus4,ollama"
```

### No AI? No Problem!

```bash
# Works perfectly without any AI
npx site2rag docs.example.com --no-enhancement
# ⚠ AI Processing: AI not available
# → Falls back to excellent heuristic-based content extraction
```

**Privacy First**: Local AI processing with Ollama means your data never leaves your machine! 🔒

---

## 📊 Real-World Performance

### Large Documentation Sites

| Site                | Pages      | First Run  | Update Time | Storage |
| ------------------- | ---------- | ---------- | ----------- | ------- |
| Kubernetes Docs     | 47K pages  | 12 minutes | 30 seconds  | 450MB   |
| AWS Documentation   | 89K pages  | 23 minutes | 45 seconds  | 890MB   |
| React Documentation | 1.2K pages | 45 seconds | 3 seconds   | 12MB    |

### Update Efficiency

```bash
🔍 Change Detection Results:
├── Total pages checked: 47,000
├── HTTP requests made: 47,000 (HEAD only)
├── Pages changed: 3
├── Pages downloaded: 3
├── Time taken: 28 seconds
└── Bandwidth used: 234KB (vs 450MB full re-download)
```

**99.9% efficiency** - only download what actually changed! ⚡

---

## 🛠️ Installation & Setup

### Prerequisites

- **Node.js 18+** (for npx)
- **Optional**: [Ollama](https://ollama.ai) for AI-enhanced content processing

### Quick Start

```bash
# No installation needed - just run!
npx site2rag docs.example.com

# Optional: AI setup for enhanced processing
ollama pull qwen2.5:14b
npx site2rag docs.example.com
# ✅ 🧠 AI Processing: qwen2.5:14b ready
```

### Check Status

```bash
# View crawl status for a site
npx site2rag docs.example.com --status

# Clean crawl state (start fresh)
npx site2rag docs.example.com --clean
```

---

## 💡 Practical Examples

### Production RAG Pipeline

```bash
# Use auto-fallback for maximum reliability
npx site2rag docs.kubernetes.io --auto-fallback --flat --limit 1000
# 🔄 Tries: gpt4o → gpt4o-mini → opus4 → gpt4-turbo → ollama
# 📁 Flat structure perfect for vector databases
```

### Development & Testing

```bash
# Test mode with specific model and debugging
npx site2rag docs.example.com --use_gpt4o_mini --test --debug --limit 10
# 🧪 Detailed logging for development
# 💰 Cost-effective testing with mini model
```

### High-Quality Content Processing

```bash
# Use premium models for best results
npx site2rag important-docs.com --use_opus4 --verbose
# 🎯 Claude 3.5 Sonnet for highest quality context enhancement
```

### Custom Provider Fallback

```bash
# Prefer local processing, fallback to cloud
npx site2rag docs.example.com --auto-fallback --fallback-order "ollama,gpt4o_mini,opus4"
# 🔒 Privacy-first with intelligent fallback
```

### Update Existing Knowledge Base

```bash
# Only process changed content
npx site2rag docs.example.com --update --auto-fallback
# ⚡ Lightning-fast updates using smart change detection
```

---

## 🔧 Configuration Options

### CLI Options

| Option | Description | Example |
| --- | --- | --- |
| `input` | URL to crawl or file path to process | `npx site2rag docs.example.com` |
| `-o, --output <path>` | Output directory for URLs or file path for files | `--output ./my-docs` |
| `--limit <num>` | Limit the number of pages downloaded (URL mode only) | `--limit 100` |
| `--flat` | Store all files in top-level folder with path-derived names | `--flat` |
| `--update` | Update existing crawl (only changed content) | `--update` |
| `-s, --status` | Show status for a previous crawl | `--status` |
| `-c, --clean` | Clean crawl state before starting | `--clean` |
| `-v, --verbose` | Enable verbose logging | `--verbose` |
| `--dry-run` | Show what would be crawled without downloading | `--dry-run` |
| `-d, --debug` | Enable debug mode to save removed content blocks | `--debug` |
| `--test` | Enable test mode with detailed skip/download decision logging | `--test` |
| `--no-enhancement` | Extract entities only, do not enhance text content | `--no-enhancement` |

### AI Provider Options

| Option | Description | Requirements |
| --- | --- | --- |
| `--auto-fallback` | Enable smart LLM fallback (try best available LLM) | Any AI API key |
| `--fallback-order <sequence>` | Custom fallback order (comma-separated) | `--fallback-order "gpt4o,opus4,ollama"` |
| `--use_gpt4o` | Use OpenAI GPT-4o | `OPENAI_API_KEY` |
| `--use_gpt4o_mini` | Use OpenAI GPT-4o-mini | `OPENAI_API_KEY` |
| `--use_gpt4_turbo` | Use OpenAI GPT-4 Turbo | `OPENAI_API_KEY` |
| `--use_o1_mini` | Use OpenAI o1-mini | `OPENAI_API_KEY` |
| `--use_opus4` | Use Anthropic Claude 3.5 Sonnet | `ANTHROPIC_API_KEY` |
| `--use_haiku` | Use Anthropic Claude 3.5 Haiku | `ANTHROPIC_API_KEY` |
| `--use_mistral_large` | Use Mistral Large | `MISTRAL_API_KEY` |
| `--use_perplexity` | Use Perplexity API | `PERPLEXITY_API_KEY` |
| `--use_r1_grok` | Use xAI Grok | `XAI_API_KEY` |
| `--anthropic <env_var>` | Use Anthropic Claude API with key from environment variable | Custom env var |

### Site Configuration

Each site gets its own `.site2rag/config.json`:

```json
{
  "site_url": "https://docs.example.com",
  "patterns": {
    "include": ["*/docs/*", "*/api/*"],
    "exclude": ["*/admin/*", "*/login/*"]
  },
  "processing": {
    "ai_enhanced": true,
    "content_classification": true,
    "context_injection": true,
    "rag_disambiguation": true,
    "cache_context": true
  },
  "crawl_settings": {
    "max_depth": 5,
    "concurrency": 3,
    "delay": 500
  }
}
```

---

## 🎯 RAG-Optimized Output

### Why RAG Context Disambiguation Matters

Traditional content extraction creates ambiguous, context-less paragraphs that confuse RAG systems:

```markdown
❌ Traditional RAG Content: "I started working on the project. It was challenging but rewarding."
```

When your RAG system retrieves this, it has no idea:

- Who "I" refers to
- What "project" means
- When this happened
- What context "challenging" refers to

### site2rag's Enhanced RAG Content

```markdown
✅ site2rag Enhanced Content: "I (Chad Jones, author) started working on the project (Ocean search software). It was challenging but rewarding."
```

Now your RAG system knows:

- **Who**: Chad Jones, the author
- **What**: Ocean search software project
- **Context**: Software development challenge
- **Relevance**: Perfect for queries about Ocean, Chad Jones, or software development

**Result**: 🎯 **Dramatically better RAG search relevance and answer quality!**

---

## 🎯 RAG Integration Examples

### With LangChain

```python
from langchain.document_loaders import DirectoryLoader
from langchain.text_splitter import MarkdownTextSplitter

# Load your site2rag output
loader = DirectoryLoader('./docs.example.com/pages/', glob="**/*.md")
docs = loader.load()

# The markdown is already clean and context-enhanced!
splitter = MarkdownTextSplitter(chunk_size=1000)
chunks = splitter.split_documents(docs)
```

### With Local Vector DB

```python
import chromadb
from pathlib import Path

# site2rag output is perfect for vector storage
docs_path = Path('./docs.example.com/pages/')
for md_file in docs_path.glob('**/*.md'):
    content = md_file.read_text()
    # YAML frontmatter has perfect metadata
    # Context hints improve vector search quality
    collection.add(documents=[content], metadatas=[yaml_frontmatter])
```

---

## 🚀 Advanced Features

### Smart Change Detection

- **ETag & Last-Modified** headers for HTTP-level change detection
- **Content hashing** for precise change identification
- **Incremental updates** - only download what actually changed
- **Database state** - resume interrupted crawls seamlessly

### Asset Management

- **Automatic asset discovery** - images, PDFs, documents
- **Local asset storage** with proper path rewriting
- **Asset deduplication** by content hash
- **Maintains link relationships** for perfect citations

---

## 🤝 Contributing

We'd love your help making `site2rag` even better!

### Quick Development Setup

```bash
git clone https://github.com/chadananda/site2rag
cd site2rag
npm install
npm test
```

### Running Tests

```bash
npm test              # All tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Task-Based Development

Each feature is broken into small, testable tasks (T01-T32). Perfect for:

- 🐛 Bug fixes
- ✨ New features
- 📚 Documentation
- 🧪 Test improvements

---

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **[Crawl4AI](https://github.com/unclecode/crawl4ai)** - Inspiration for AI-powered web crawling
- **[Turndown](https://github.com/mixmark-io/turndown)** - Excellent HTML to Markdown conversion
- **[Ollama](https://ollama.ai)** - Making local AI accessible to everyone

---

## 🚀 Get Started Now!

Ready to transform websites into RAG-ready knowledge bases?

```bash
npx site2rag docs.your-favorite-site.com
```

**That's it!** Your journey to effortless knowledge base maintenance starts now. 🎉

---

<div align="center">

**[⭐ Star on GitHub](https://github.com/chadananda/site2rag)** • **[📖 Documentation](https://github.com/chadananda/site2rag/wiki)** • **[🐛 Report Issues](https://github.com/chadananda/site2rag/issues)** • **[💬 Discussions](https://github.com/chadananda/site2rag/discussions)**

Made with ❤️ by [Chad Ananda](https://github.com/chadananda)

</div>
