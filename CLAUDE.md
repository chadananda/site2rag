# Claude Development Instructions

## Required Reading (In Order)
1. **Anthropic Claude Code Best Practices**: https://www.anthropic.com/engineering/claude-code-best-practices
2. `prd.md` - Complete Product Requirements Document

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

## File Organization Rules
- **Temporary files**: Must go in `tests/` subfolders, NEVER in root directory
- **Planning documents**: Use `planning/` folder for design docs, specifications
- **Test data**: Store in `tests/fixtures/` or `tests/data/`
- **Temporary scripts**: Only in `scripts/` folder, delete when done
- **Core project files**: Keep root directory clean - only essential project files

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

## Commands
- Tests: `npm run test`
- Lint: `npm run lint`
- Dev server: `npm run dev`
- Build: `npm run build`