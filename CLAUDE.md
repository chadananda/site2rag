# Claude Development Instructions

## Getting Up to Speed (Claude Self-Onboarding)

### Required Reading (In Order)

1. **Anthropic Claude Code Best Practices**: https://www.anthropic.com/engineering/claude-code-best-practices
2. `planning/prd.md` - Complete Product Requirements Document
3. `src/REFACTORING_MAP.md` - Function catalog and safety levels
4. `tests/README.md` - Test strategy and organization
5. `planning/` directory - All design docs and specifications

### Context Files (Always check these first)

- **`src/REFACTORING_MAP.md`** - Check for existing functions before creating new ones
- **`tests/README.md`** - Understand test structure and patterns
- **`planning/project-constraints.md`** - Core architectural constraints
- **Current git status** - Understand work in progress

### Project Status Check

- Run `git status` to see current work
- Check `tests/unit/` for recent test additions
- Review `src/` structure for new utilities
- Check `planning/` for recent design decisions

## Mandatory Code Style

- No blank lines in code - use comments to separate sections
- Single-line if statements when possible
- Functional/compact style with chaining
- All functions exported inline: `export const functionName = () => {}`
- JSDoc headers for all functions
- No inline imports!

## Implementation Rules

- **Minimal implementation only** - no extra features
- **One feature per git branch** - create branch before starting
- **Break into small increments** - commit each working change
- **Test before merge** - run Vitest tests after any function change
- **Ask before architectural decisions**
- **Use readable string keys** - no foreign key relationships
- **Surgical changes only** - preserve existing working code
- **Temporary scripts in scripts/ folder** - delete when no longer needed
- **REUSE EXISTING FUNCTIONS** - check before creating new ones

## Autonomous Development Workflow

### Core Development Pipeline (Claude handles automatically)

1. **Pre-Development Check**:
   - Check `src/REFACTORING_MAP.md` for existing functions
   - Search codebase for similar functionality
   - Verify no redundant work

2. **Function Development**:
   - Write pure functions with JSDoc headers
   - Export all functions for testing
   - Follow compact/functional style (no blank lines)

3. **Quality Pipeline (Automatic)**:
   - Run `npm run lint:fix` to auto-fix issues
   - Run `npm run lint` to check remaining issues
   - Fix any remaining linting issues immediately
   - No code proceeds without passing lint

4. **Testing Pipeline (Automatic)**:
   - Create unit tests for all pure functions
   - Place tests in appropriate `tests/unit/{category}/`
   - Run `npm run test:unit` to verify unit tests pass
   - Use pattern-based assertions for AI testing

5. **Documentation Pipeline (Automatic)**:
   - Update `src/REFACTORING_MAP.md` with new functions
   - Update `tests/README.md` with new test descriptions
   - Add JSDoc headers to all functions

6. **Git Workflow (Automatic)**:
   - Commit after each successful function + test creation
   - Use conventional commit messages
   - Small, frequent commits for safety
   - Auto-commit when tests pass

### Commit Pattern (Claude executes automatically)

```bash
# After creating pure function with tests
npm run quality:check
git add . && git commit -m "feat: add {functionName} utility with comprehensive tests

- Exported pure function in src/utils/{category}.js
- Added unit tests in tests/unit/utils/{category}.test.js
- Updated REFACTORING_MAP.md and tests/README.md
- All tests passing, lint clean

🤖 Generated with Claude Code"
```

### Sub-Agent Usage (Automatic)

- **Code Review Agent**: Review all code for style compliance
- **Test Creation Agent**: Create comprehensive tests for pure functions
- **Documentation Agent**: Update all relevant documentation files

## File Organization Rules

- **Temporary files**: Must go in `tests/` subfolders, NEVER in root directory
- **Planning documents**: Use `planning/` folder for design docs, specifications
- **Test data**: Store in `tests/fixtures/` or `tests/data/`
- **Temporary scripts**: Only in `scripts/` folder, delete when done
- **Core project files**: Keep root directory clean - only essential project files
- **Always store planning documents in the `planning/` folder**

## Session Workflow

1. Trunk development methods -- create short-lived git branch -- merge and repeat whenever stable
2. Break task into small, testable increments
3. For each increment:
   - Make minimal, surgical change
   - Run tests (Vitest)
   - Commit with descriptive message
   - Refactor for simplicity if needed
   - Test and commit refactoring
4. Complete feature documentation
5. Final review for simplicity and style
6. Merge only when thoroughly tested then check out a new short-lived branch

## File Creation Rules

- **New utility files only when 5+ functions expected**
- **camelCase naming** for all utility files
- **File headers required**: filename + purpose explanation
- **Corresponding .test.js** file for every utility
- **Temporary scripts**: only in scripts/ folder, delete when done

## If Implementation Gets Complex

1. **STOP** - re-read `planning/project-constraints.md`
2. **Ask**: "What's the simplest possible solution?"
3. **Remove** any unnecessary abstractions
4. **Focus** only on current task requirements

## Emergency Brake Phrases

Watch for these and stop immediately:

- "Let's also add..." ❌
- "We should probably..." ❌
- "It would be better if..." ❌
- "For future flexibility..." ❌

## Success Criteria

- Feature works as specified
- Follows all code style requirements
- Has basic test coverage
- No unnecessary complexity
- Matches database architecture patterns
- No hard-coded values just to pass tests
- Clean root directory with no temporary files

## Quality Gates (All Automatic)

### Mandatory Checks Before Any Commit:

1. **Lint Check**: `npm run lint` must pass (no warnings/errors)
2. **Test Suite**: `npm run test` must pass (all tests green)
3. **Function Reuse**: Check REFACTORING_MAP.md for existing functions
4. **Documentation**: All new functions documented in appropriate files

### Test Output Isolation:

- **ALL test outputs** → `tests/tmp/{test-name}/` only
- **Never delete core files** - only clean `tests/tmp/` contents
- **Database files** → `tests/tmp/{test-name}/db/`
- **Generated content** → `tests/tmp/{test-name}/output/`

### AI Testing Standards:

- Use pattern-based assertions (not exact matches)
- Mock non-deterministic AI responses
- Test structure preservation and enhancement patterns
- Validate error handling and edge cases

### Commit Standards:

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`
- Include test status and lint status in commit message
- Reference updated documentation files
- Always include Claude Code attribution

## Emergency Procedures

### If Tests Fail:

1. **STOP development immediately**
2. **Fix failing tests before any new work**
3. **Do not commit broken code**
4. **Check git status and rollback if needed**

### If Lint Fails:

1. **Fix all linting issues immediately**
2. **Do not proceed with development**
3. **Use autofix where possible**: `npm run lint -- --fix`
4. **Manual fix for complex issues**

### If Function Already Exists:

1. **Use existing function instead of creating new one**
2. **Update existing function if enhancement needed**
3. **Add tests for existing function if missing**
4. **Document in REFACTORING_MAP.md if not already there**

## Testing Guidelines

- **Always use npm scripts** - common tests should be added to package.json as npm scripts to avoid requiring extra permissions
- **Run tests via npm** - always prefer `npm run test` over direct test runner commands when possible
- **Add test shortcuts** - frequently used test patterns should become npm scripts for easier access
- **Remember to always add scripts as npm scripts in order to run without asking permission**
- **Always delete temporary script files when done with them so as to not clog up our project**
- **Store temporary scripts in tests/tmp/scripts**
- **Always use npm scripts for testing. If necessary, modify test:quicktest to do what you want to do and then run it with `npm run test:quicktest`. That way you don't have to keep asking permission to run quick tests of functionality.**

## Commands

- Tests: `npm run test`
- Format: `npm run format` (Prettier - run after editing code)
- Lint: `npm run lint` (ESLint - run after editing code to catch issues)
- Dev server: `npm run dev`
- Build: `npm run build`

## Code Quality

- **Always run format and lint after editing code** - helps catch mistakes quickly
- **Format first, then lint** - Prettier fixes formatting, ESLint catches logic issues
- **Address all linting errors before committing** - maintain code quality standards

## Documentation Research

- **Use Context7 MCP server for latest docs** - research current library/framework documentation during planning
- **Check latest API changes** - use Context7 to verify current syntax and best practices
- **Research before implementing** - avoid outdated patterns by checking latest documentation first

## Version Management Guidelines

- When committing fixes to git, update the version with a minor update
- When merging a feature branch, increment a major update (in the package.json)
- Publish to NPM on major changes (npm publish)

## AI Context Processing Configuration

- **Window Size**: 1200 word context + 600 word processing windows (optimized for mini models)
- **Concurrency**: 10 parallel AI calls with rate limiting
- **Minimum Block Size**: 100 characters (filters out trivial content)
- **Response Format**: Plain text with blank line separators (no JSON)
- **Primary Provider**: Claude 3.5 Haiku (default, best for disambiguation)
- **Fallback Order**: haiku → gpt4o → opus4 → gpt4-turbo → ollama
- **Validation**: Strict - only `[[context]]` insertions allowed, original text preserved
- **Processing**: Headers and code blocks skipped, only content blocks enhanced

## Memories

- Set crawling output to a subfolder of --output tests/tmp/sites/ like --output tests/tmp/sites/quicktest
- Always use npm scripts and avoid bash so that you can run tests and diagnosis without permission or pause
- **Never add files directly to the tests/tmp folder. All files go in the appropriate subfolder such as tests/tmp/scripts/**
- Always use npm scripts for testing, for temporary tests, modify test:quicktest