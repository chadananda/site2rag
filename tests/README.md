# Test Organization

## Structure

```
tests/
├── unit/                   # Unit tests for individual components
│   ├── services/          # Service-specific unit tests
│   ├── *.test.js         # Component unit tests
├── integration/           # Integration tests (full workflow)
├── fixtures/              # Test data and mock files
├── tmp/                   # Temporary test outputs (gitignored)
│   ├── sites/            # Real website test downloads
│   ├── output*/          # Test output directories
│   └── *.db              # Test databases
├── testUtils.js           # Shared test utilities
└── README.md             # This file
```

## Test Types

### Unit Tests (`tests/unit/`)
- Test individual functions and classes in isolation
- Mock external dependencies
- Fast execution
- High coverage of edge cases

### Integration Tests (`tests/integration/`)
- Test complete workflows end-to-end
- Use real components and services
- May use real network requests (limited)
- Test full system integration

### Test Data (`tests/fixtures/`)
- Static test data
- Mock HTML files
- Sample configurations
- Reference outputs

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only  
npm run test:integration

# With coverage
npm run test:coverage
```

## Guidelines

1. **Unit tests** should be fast and isolated
2. **Integration tests** can be slower but test real scenarios
3. **Temporary files** must go in `tests/tmp/` (gitignored)
4. **Test data** should use `tests/fixtures/` for reusable files
5. **Real downloads** for testing go in `tests/tmp/sites/`