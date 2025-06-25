# Site2RAG Refactoring Map 🗺️

> **Purpose**: Help Claude Code safely refactor the codebase by understanding dependencies, safety levels, and consolidation opportunities.

## 📊 Project Stats

- **Total Files**: 79 JS files
- **Source Files**: 29 files in `/src`
- **Current Services**: 8 core services
- **Entry Points**: 2 main entry points

---

## 🚦 REFACTORING SAFETY LEVELS

### 🚫 **CRITICAL - DO NOT MOVE** (Entry Points)

```
bin/site2rag.js
├── detectInputType(input) → 'file'|'url'           [CLI detection logic]
├── handleFileProcessing(filePath, options)         [File mode handler]
├── displayHeader()                                 [CLI display]
└── main CLI action                                 [Commander.js setup]

src/site_processor.js
└── SiteProcessor.process()                         [Main library entry]
```

### ✅ **HIGH SAFETY** (Pure Functions - Safe to Move/Rename)

```
utils/dom_utils.js
├── generateFullSelectorPath($, element) → string   [Pure DOM utility]
├── analyzeSelectorPath(selector) → analysis        [Pure analysis]
└── isLikelyFrameworkWrapper(selector) → boolean    [Pure classification]

services/url_service.js
├── normalizeUrl(url) → string                      [Pure URL utility]
├── safeFilename(url) → string                      [Pure filename util]
└── matchGlob(pattern, path) → boolean              [Pure pattern match]

utils/errors.js
└── CrawlLimitReached                               [Simple error class]
```

### ⚠️ **MEDIUM SAFETY** (Stateful but Moveable with Care)

```
services/markdown_service.js
└── MarkdownService.convert(html) → markdown        [Stateful TurndownService]

services/logger_service.js
└── logger.info/error/debug/etc                     [Global logging state]

services/debug_logger.js
├── debugLogger.debug(category, message)            [Test/debug mode logging]
├── debugLogger.batching/keyed/ai/etc(message)      [Category shortcuts]
└── debugLogger.info/warn/error/success()           [Level-based logging]

utils/ai_utils.js
├── aiServiceAvailable() → boolean                  [Network check]
└── classifyBlocksWithAI(blocks, config) → result  [AI service calls]
```

### 🔴 **HIGH RISK** (Database, Network, Complex State)

```
core/crawl_state.js
├── DefaultCrawlState.getPage(url) → pageData       [DATABASE READ]
├── DefaultCrawlState.upsertPage(data)              [DATABASE WRITE]
└── DefaultCrawlState.finalizeSession()             [DATABASE TRANSACTION]

services/fetch_service.js
├── FetchService.fetchRobotsTxt(domain)             [NETWORK I/O + STATE]
├── FetchService.canCrawl(url) → boolean            [Robots.txt state]
└── FetchService.fetchUrl(url, options)             [NETWORK I/O]

services/content_service.js
├── ContentService.processHtml(html, url)           [AI calls + complex logic]
├── ContentService.extractMetadata($) → metadata    [JSON-LD + meta extraction]
├── ContentService.extractJsonLd($) → jsonLdData    [Structured data parsing]
├── ContentService.extractAuthor($, ...) → string   [Author fallback chain]
├── ContentService.extractKeywords(...) → array     [Keyword aggregation]
├── scoreContentElement($, element) → number        [Complex heuristics]
├── isLikelyNavigationOrBoilerplate($, el) → bool  [Complex heuristics]
├── handleFrameworkWrappers($, body, opts) → obj    [Complex DOM analysis]
├── extractMainContent($, body, opts) → element     [Complex extraction]
└── cleanupContent($, content, opts) → element      [Remove scripts/styles]

services/crawl_service.js
├── FastChangeDetector.checkForChanges()            [DATABASE + NETWORK]
├── FastChangeDetector.generateConditionalHeaders() [HTTP optimization]
├── CrawlService.crawlSite(startUrl) → urls[]       [ORCHESTRATES EVERYTHING]
├── CrawlService.downloadPDFsFromPage(links, url)   [Document download logic]
└── CrawlService.isBinaryContentType(type) → bool   [Binary detection]
```

---

## 🔗 DEPENDENCY ANALYSIS

### **Most Imported Files** (Refactoring Hot Spots)

```
1. services/logger_service.js       → 8+ files import this
2. utils/dom_utils.js              → 4+ files import this
3. utils/ai_utils.js               → 3+ files import this
4. core/crawl_state.js             → 3+ files import this
5. utils/errors.js                 → 2+ files import this
```

### **Import Web** (Who Imports What)

```
src/site_processor.js (ORCHESTRATOR)
├── services/url_service.js
├── services/fetch_service.js
├── services/content_service.js
├── services/markdown_service.js
├── services/file_service.js
├── services/crawl_service.js
├── core/crawl_state.js
├── db.js
└── utils/errors.js

services/content_service.js (COMPLEX)
├── utils/ai_utils.js
├── utils/dom_utils.js
└── services/logger_service.js

services/crawl_service.js (ORCHESTRATOR)
├── utils/progress.js
├── utils/errors.js
└── services/logger_service.js
```

### **Zero Dependencies** (Easiest to Move)

```
✅ utils/errors.js                 [Just Error classes]
✅ services/logger_service.js      [Just console wrapper]
✅ utils/dom_utils.js             [Just DOM utilities]
```

---

## 🎯 CONSOLIDATION OPPORTUNITIES

### **Immediate Wins** (High Confidence)

```
1. URL Utilities Consolidation
   - Move all URL functions to utils/url_helpers.js
   - Files: services/url_service.js functions
   - Impact: 5+ import statements to update
   - Risk: LOW (pure functions)

2. File I/O Consolidation
   - Group all file operations in utils/file_helpers.js
   - Files: services/file_service.js + scattered file ops
   - Impact: 3+ import statements
   - Risk: LOW (mostly pure I/O)

3. DOM Utilities Already Consolidated
   - utils/dom_utils.js is well organized
   - Used by: content_service.js primarily
   - Action: Leave as-is ✅
```

### **Medium-Term Targets** (Test Thoroughly)

```
1. Content Analysis Consolidation
   - Combine scoring functions in services/content_service.js
   - Create ContentAnalyzer class for:
     * scoreContentElement()
     * isLikelyNavigationOrBoilerplate()
     * Framework detection logic
   - Risk: MEDIUM (complex heuristics)

2. Service Base Classes
   - Extract common service patterns
   - Add consistent error handling
   - Standardize initialization
   - Risk: MEDIUM (touches all services)

3. Configuration Unification
   - Consolidate config handling in core/
   - Unify AI configuration patterns
   - Risk: MEDIUM (config is critical)
```

### **Future Possibilities** (High Risk)

```
❌ Database Layer Abstraction (core/crawl_state.js)
❌ AI Client Restructuring (core/ai_client.js)
❌ CLI Interface Changes (bin/site2rag.js)
❌ Main Processing Pipeline (site_processor.js)
```

---

## 📋 REFACTORING CHECKLIST

### **Before Moving Any Function:**

1. ✅ Check import statements (use `rg "functionName" src/`)
2. ✅ Verify test coverage exists
3. ✅ Understand side effects (DB, network, state)
4. ✅ Map all callers and dependencies
5. ✅ Run tests after each move

### **Safe Refactoring Order:**

1. **First**: Pure utility functions (DOM, URL, file helpers)
2. **Second**: Service consolidation within same responsibility
3. **Third**: Cross-service pattern extraction
4. **Last**: Core processing logic changes

### **Red Flags - Stop and Reassess:**

- Function touches database (`upsertPage`, `getPage`)
- Function makes network calls (`fetchUrl`, `fetchRobotsTxt`)
- Function coordinates multiple services (`process`, `crawlSite`)
- Function is imported by 5+ files
- Function has complex conditional logic with side effects

---

## 🧪 TEST COVERAGE MAP

### **Well Tested** (Safer to Refactor)

```
✅ utils/dom_utils.js          [Unit tests exist]
✅ services/url_service.js     [Unit tests exist]
✅ core/crawl_state.js         [Database tests exist]
✅ services/fetch_service.js   [Service tests exist]
```

### **Integration Tested** (Refactor with System Tests)

```
⚠️ services/content_service.js [Complex integration tests]
⚠️ services/crawl_service.js   [End-to-end tests]
⚠️ site_processor.js           [Full pipeline tests]
```

### **Light Testing** (High Risk)

```
🔴 core/context_processor.js   [AI processing - complex]
🔴 core/ai_client.js           [External service dependent]
```

---

## 📝 REFACTORING NOTES FOR CLAUDE CODE

### **When Moving Functions:**

1. **Update import statements** in all dependent files
2. **Preserve JSDoc comments** and function signatures
3. **Move tests** to match new file structure
4. **Check for indirect dependencies** (config objects, shared state)
5. **Run full test suite** after each consolidation

### **When Creating New Modules:**

1. **Follow existing patterns** (class exports, named exports)
2. **Add appropriate logging** using existing logger_service.js
3. **Include error handling** using utils/errors.js patterns
4. **Document public APIs** with JSDoc

### **Emergency Rollback Plan:**

1. **Git commit** before each refactoring step
2. **Keep original imports** commented out temporarily
3. **Test each step** before proceeding to next
4. **Have working state** to revert to at all times

This map provides Claude Code with the context needed to safely refactor the 78-file crawler into a more maintainable structure while preserving all functionality.
