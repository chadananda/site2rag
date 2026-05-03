# Claude-First Maintainability Refactor

## Problem

Large codebases become expensive to maintain in AI sessions because every edit requires reading context before acting. When files exceed ~200 lines, understanding a module costs 2–4 reads before any work begins. When logic is duplicated across files, a bug fix requires hunting down every copy. When function names collide across modules (`processOne` in two unrelated files), AI sessions misidentify which function to edit.

The result: discovery overhead consumes most of a session's context budget before any real work happens.

## Goal

Reorganize so that **any bug or feature can be understood and fixed by reading one file and at most one import.** Every file should have a single stated concern, a one-line header, and no duplicated logic.

## Methodology

### 1. Start with an integration test harness

Before splitting files, ensure a passing full-suite of integration tests that exercise the actual behavior end-to-end. Unit tests that mock internals will pass even when a refactor breaks a real code path. Integration tests that exercise the pipeline with a real database and real file I/O will catch regressions.

The test harness should cover:
- Each pipeline stage in isolation (classify, export, mirror, etc.)
- Multi-stage sequences (classify → export → verify output)
- Edge cases that exist because of real production bugs (document these in test names)
- Cross-cutting invariants (DB schema migrations, config path isolation)

Without this harness, any refactor is a guess. With it, each split is safe to commit immediately after tests pass.

### 2. Extract shared constants first

Find duplicated constants (sets, maps, arrays) that appear in 3+ files. Move them to a single `constants.js` or `language.js`. Update imports everywhere. This step has zero behavior change and eliminates an entire class of drift bugs where one copy gets updated and others don't.

### 3. Split files at natural seams

Each file gets a single concern. Identify the seams by asking: "if I need to fix X, which functions do I need?" Functions that are always read/edited together belong together.

**Target file size: under 200 lines.** At 200 lines, a full file fits in context. At 500+, you're always reading partial context.

Split strategy:
- Extract pure utility functions (no I/O, no DB) to a `*-utils.js` sibling
- Extract worker pools, queues, or daemon loops to their own files
- Extract SQL query functions away from HTTP route handlers
- Keep orchestration logic (the main `run*()` function) in the parent file

### 4. Rename ambiguous functions

No two functions in different files should share a name. When a name like `processOne` appears in both `mirror.js` and `pdf-upgrade/index.js`, AI sessions will conflate them. Rename to describe what the function does in its specific context (`fetchAndExportPage`, `upgradeDocument`).

### 5. Add navigation headers to every file

First line of every source file:
```
// <purpose>. Exports: <fn1>, <fn2>. Deps: <dep1>, <dep2>
```

This lets an AI session understand what a file does without reading its body. The header is the file's contract.

### 6. Add CLAUDE.md per subdirectory

Each subdirectory gets a `CLAUDE.md` that acts as a router: one line per file, stating its purpose and key exports. A fresh session reads the CLAUDE.md to find the right file before opening anything.

Format:
```markdown
# src/ — Core pipeline modules
- constants.js   — DOC_MIMES, DOC_EXTS (shared across mirror, classify, assets)
- mirror.js      — runMirror() crawl loop
```

### 7. Magic constants at file tops

Named constants replace inline magic numbers wherever a value appears 2+ times or its meaning isn't obvious from context. Place at the top of the file that uses them, not in a global config.

## What NOT to do

- **Don't add abstraction layers.** Extracting a function to avoid 3 similar lines is premature. Wait until a fourth copy appears.
- **Don't create "utils" dumping grounds.** Every extracted file must have a single stated concern. A file called `utils.js` with 20 unrelated functions is worse than the original.
- **Don't break working tests to fit the refactor.** If a test exercises real behavior, it stays. If it's testing an implementation detail that the refactor changes, update the test.
- **Don't split for splitting's sake.** The goal is "reads one file to understand one thing," not the smallest possible files.

## Verification

After each file split:
1. Run the full test suite — all tests must pass
2. Spot-check exports: `node -e "import('./src/file.js').then(m => console.log(Object.keys(m)))"`
3. Search for orphaned references: `grep -r "oldFunctionName" src/ bin/`

After all splits:
- No function name should appear in two files with different meanings
- No constant should be defined in more than one file
- Every file should have a header comment
- Every subdirectory with 3+ files should have CLAUDE.md

## Outcome Metrics

A successful refactor shows:
- Average lines per file drops from ~300 to ~120
- "Time to first edit" in a new session drops (fewer files to read before acting)
- Bug fixes become single-file changes rather than multi-file hunts
- New contributors (or AI sessions) can orient in one read of CLAUDE.md
