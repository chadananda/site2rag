# site2rag Configuration Guide

## Environment Variables

### Context Processing

- `SITE2RAG_MIN_BLOCK_CHARS` - Minimum character count for text blocks to be processed (default: 100)
  - Set to 0 to process all blocks regardless of size
  - Higher values skip trivial content but may miss important short paragraphs
  - Example: `SITE2RAG_MIN_BLOCK_CHARS=150 site2rag example.com`

### Window Sizes for AI Processing

The context processor uses optimized window sizes based on extensive testing:

#### Default Models (GPT-4, Claude Opus, etc.)

- Context window: 1000 words
- Processing window: 1000 words

#### Simplified Models (GPT-4o-mini, Claude Haiku, etc.)

- Context window: 1200 words (optimal)
- Processing window: 600 words (optimal)

These values were determined through testing:

- 700/300: 3-4 disambiguations
- 800/400: 4 disambiguations
- 1000/500: 4 disambiguations
- 1200/600: 5 disambiguations (optimal balance)
- 1300/700: 4 disambiguations
- 1500/800: 1 disambiguation (quality degrades)

### Regex Patterns for Content Cleaning

The content cleaning function removes:

1. Code blocks (triple backticks or 4-space/tab indented)
2. Images in markdown format `![alt](url)`
3. Links - preserves text, removes URLs `[text](url)` → `text`
4. HTML tags `<tag>content</tag>` → `content`
5. Excessive whitespace (multiple spaces, newlines)

### Metadata Simplification

To reduce token usage, only essential metadata fields are retained:

- `title` - Document title
- `url` - Document URL
- `description` - Brief description

Redundant fields are removed:

- `og_title`, `og_description` (duplicates of title/description)
- `twitter_title`, `twitter_description` (social media duplicates)
- `og_image`, `twitter_image` (images not needed for context)
- `viewport`, `robots` (technical SEO fields)

This typically reduces metadata tokens by ~50% while preserving contextual value.
