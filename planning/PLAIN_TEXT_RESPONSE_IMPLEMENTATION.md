# Plain Text Response Implementation

## Overview

The context disambiguation system has been refactored from JSON-based responses to plain text responses, improving compatibility with mini models and reducing parsing complexity.

## Key Changes

### 1. Response Format
- **Before**: AI returned JSON with keyed blocks
- **After**: AI returns plain text with blocks separated by blank lines

### 2. Validation System
- **Strict validation**: Only `[[context]]` insertions allowed
- **Text preservation**: Original text must match exactly (whitespace normalized)
- **No Unicode normalization**: Avoids unintended text modifications

### 3. Window Configuration
- **Context window**: 1200 words (provides sufficient context)
- **Processing window**: 600 words (optimal for mini models)
- **Minimum block size**: 100 characters (reduced from 200)

### 4. Processing Improvements
- **Headers skipped**: Lines starting with `#` included in context but not processed
- **Code blocks skipped**: Detected and excluded from disambiguation
- **Plain text prompts**: Clear output format instructions

### 5. AI Client Updates
- **Schema detection**: Automatically detects if schema expects string (plain text)
- **No JSON parsing**: For string schemas, response used directly
- **Format parameter removed**: No longer requests JSON format from AI

## Benefits

1. **Better mini model performance**: GPT-4o-mini and Claude Haiku work better with plain text
2. **Reduced complexity**: No JSON parsing errors or format issues
3. **Faster processing**: Direct text response without parsing overhead
4. **More reliable**: Strict validation catches any unwanted modifications

## Implementation Details

### Context Processor (`context_processor_simple.js`)
- `PlainTextResponseSchema`: Uses `z.string()` for responses
- Response parsing: Splits by blank lines to separate blocks
- Block matching: Matches responses to original blocks using validation

### AI Client (`ai_client.js`)
- Detects string schemas and skips JSON parsing
- Removed JSON format request for plain text responses
- Maintains backward compatibility for JSON schemas

### Prompt Structure
```
========= OUTPUT FORMAT:

Return ONLY the enhanced text blocks with [[disambiguations]] added.
Separate each block with a blank line.
Do not add any explanations, numbers, or other text.
```

## Testing Recommendations

1. Test with various mini models (GPT-4o-mini, Claude Haiku)
2. Verify strict validation catches text modifications
3. Check block separation and matching logic
4. Ensure headers and code blocks are properly skipped

## Migration Notes

- No changes required to existing code using the context processor
- API remains the same, only internal implementation changed
- Improved results expected with mini models