# Test Strategy & Organization

## Testing Philosophy

`site2rag` follows a **comprehensive testing strategy** with clear separation of concerns:

- **Unit Tests**: Fast, isolated tests for individual components
- **Integration Tests**: End-to-end workflows with real components  
- **Manual Testing**: Real website downloads for validation
- **Consistent Naming**: All test files use kebab-case convention

## Folder Structure

```
tests/
├── unit/                   # Unit tests (fast, isolated)
│   ├── services/          # Service-specific unit tests
│   │   ├── file-service.test.js
│   │   ├── crawl-service.test.js
│   │   └── *.test.js
│   ├── site-processor.test.js
│   ├── content-extraction.test.js
│   └── *.test.js         # Component unit tests
├── integration/           # Integration tests (full workflows)
│   ├── crawl-markdown.test.js
│   ├── change-detection.test.js
│   └── *.test.js
├── fixtures/              # Static test data (committed)
│   ├── sample.html        # Mock HTML files
│   ├── expected-output.md # Reference outputs
│   └── configs/          # Sample configurations
├── tmp/                   # Temporary outputs (gitignored)
│   ├── sites/            # Real website downloads
│   │   └── example.com/  # Downloaded for testing
│   ├── output-*/         # Test output directories
│   └── *.db             # Test databases
├── testUtils.js           # Shared test utilities
└── README.md             # This documentation
```

## Naming Conventions

### Test Files
- **Format**: `{component-name}.test.js` (kebab-case)
- **Examples**: 
  - `site-processor.test.js`
  - `file-service.test.js`
  - `crawl-state-service.test.js`

### Test Descriptions
- **Unit tests**: `describe('ComponentName', () => {})`
- **Methods**: `describe('methodName', () => {})`
- **Scenarios**: `it('should do something when condition', () => {})`

### Temporary Files
- **Real sites**: `tests/tmp/sites/{domain}/`
- **Test outputs**: `tests/tmp/output-{test-name}/`
- **Test databases**: `tests/tmp/{test-name}.db`

## Test Categories

### Unit Tests (`tests/unit/`)

**Purpose**: Test individual components in isolation
```javascript
// Example: tests/unit/services/file-service.test.js
describe('FileService', () => {
  describe('saveMarkdown', () => {
    it('should save markdown file with frontmatter', () => {
      // Test implementation
    });
  });
});
```

**Characteristics**:
- ⚡ **Fast execution** (< 100ms per test)
- 🔒 **Isolated** - mock external dependencies
- 🎯 **Focused** - test one function/method
- 📊 **High coverage** - edge cases and error handling

### Integration Tests (`tests/integration/`)

**Purpose**: Test complete workflows end-to-end
```javascript
// Example: tests/integration/crawl-markdown.test.js
describe('Full Crawl Workflow', () => {
  it('should crawl site and generate markdown', async () => {
    // Test real crawl process
  });
});
```

**Characteristics**:
- 🌐 **Real components** - no mocking of internal services
- ⏱️ **Slower execution** (1-10 seconds per test)
- 🔄 **End-to-end** - full user scenarios
- 📝 **Real data** - may use limited real network requests

### Test Data (`tests/fixtures/`)

**Static test data** committed to repository:
- **Mock HTML**: Realistic website content samples
- **Expected outputs**: Reference markdown files
- **Configurations**: Sample crawl configs
- **Error cases**: Malformed HTML, network errors

## Running Tests

```bash
# All tests (unit + integration)
npm test

# Unit tests only (fast)
npm run test:unit

# Integration tests only
npm run test:integration  

# Specific test file
npm test -- file-service.test.js

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage
```

## Testing Real Websites

### Manual Testing Process
For testing with real websites, use `tests/tmp/sites/`:

```bash
# Download real site for testing
cd tests/tmp/sites
node ../../../bin/site2rag.js example.com --limit 10
```

**Guidelines**:
- ✅ **Use small limits** (--limit 10) to avoid overwhelming servers
- ✅ **Choose stable sites** that won't change frequently  
- ✅ **Document test sites** in test comments
- ✅ **Clean up** old downloads periodically

### Test Site Recommendations
- **Documentation sites**: Usually stable, good structure
- **Personal blogs**: Small, predictable content
- **Educational sites**: Often well-structured HTML

## Development Guidelines

### Writing New Tests

1. **Start with unit tests** for new components
2. **Use descriptive test names** that explain the scenario
3. **Test edge cases** and error conditions
4. **Mock external dependencies** in unit tests
5. **Use real components** in integration tests

### Test Data Management

```javascript
// ✅ Good: Use fixtures for reusable data
const sampleHTML = fs.readFileSync('tests/fixtures/sample.html', 'utf8');

// ❌ Bad: Inline test data in every test
const sampleHTML = '<html><body>...</body></html>';
```

### Temporary File Handling

```javascript
// ✅ Good: Use tests/tmp/ for temporary outputs
const outputDir = 'tests/tmp/output-my-test';

// ❌ Bad: Create temp files in root or src/
const outputDir = './temp-test-output';
```

### Error Testing

```javascript
// ✅ Good: Test both success and failure cases
it('should handle network errors gracefully', async () => {
  // Mock network failure
  // Verify graceful degradation
});
```

## Continuous Integration

Tests run automatically on:
- **Pull Requests**: All tests must pass
- **Main branch commits**: Full test suite + coverage
- **Nightly builds**: Including integration tests with real sites

## Debugging Tests

```bash
# Run single test with verbose output
npm test -- --verbose file-service.test.js

# Debug with inspector
node --inspect-brk node_modules/.bin/vitest run specific.test.js

# View test coverage locally
npm run test:coverage
open coverage/index.html
```

## Best Practices

### ✅ Do
- Use **descriptive test names** that read like specifications
- **Mock external dependencies** in unit tests
- **Clean up** temporary files in test teardown
- **Test edge cases** and error conditions
- **Use fixtures** for reusable test data

### ❌ Don't
- Mix **temporary files** with committed test data
- Use **snake_case** or **camelCase** for test files (use kebab-case)
- Create **large test downloads** that slow CI
- **Hard-code** paths or URLs in tests
- **Skip error cases** - they're often the most important

---

*This testing strategy ensures reliable, maintainable tests that provide confidence in site2rag's functionality across diverse websites and use cases.*