# Simplified Sliding Window Implementation

## Major Changes

### 1. Removed Complexity

- **No caching** - Each request is self-contained
- **No sessions** - Direct AI calls only
- **No complex state management** - Simple request/response
- **Removed unified_v2 processor** - Too slow with caching overhead

### 2. Simple Sliding Window Design

- **2000-word windows**: 1000 words to process + 1000 words context
- **No overlap in processing**: Each block processed exactly once
- **Context-only overlap**: Previous 1000 words provided as read-only context

### 3. Full Parallelization

- **Global request queue**: All requests from all documents prepared upfront
- **p-limit(10)**: Process 10 requests concurrently
- **No dependencies**: Each window completely independent
- **Perfect progress tracking**: Total requests known from start

### 4. Implementation Details

#### Window Structure

```
Window 1: context=(none), process=blocks 1-20 (~1000 words)
Window 2: context=last 1000 words from window 1, process=blocks 21-40
Window 3: context=last 1000 words from window 2, process=blocks 41-60
etc.
```

#### Request Format

```json
{
  "docId": "https://example.com/page",
  "windowIndex": 0,
  "prompt": "Full prompt with metadata, instructions, context, and blocks",
  "metadata": {"title": "...", "url": "..."},
  "window": {
    "context": "Previous 1000 words...",
    "blocks": {
      "BLOCK_001": "Text to enhance...",
      "BLOCK_002": "More text..."
    }
  }
}
```

### 5. Processing Flow

1. **Preparation Phase**
   - Load all documents
   - Create all sliding windows
   - Build global request queue
   - Calculate total requests

2. **Processing Phase**
   - Process entire queue with pLimit(10)
   - Show smooth progress bar (X/Total requests)
   - No resets or jumps between documents

3. **Results Phase**
   - Write enhanced content back to files
   - Update database status
   - Preserve frontmatter

### 6. Performance Benefits

- **Speed**: True parallel processing (10x faster than sequential)
- **Simplicity**: No complex caching logic to slow things down
- **Reliability**: Each request independent, failures isolated
- **Progress**: Smooth, accurate progress bar

### 7. Key Files

- `src/core/context_processor_simple.js` - New simplified processor
- `src/core/context_processor.js` - Updated to use batch processing
- Removed: `src/core/context_processor_unified_v2.js` - Too slow

## Expected Performance

With 10 concurrent requests and no caching overhead:

- ~1-2 seconds per request (vs 10+ seconds with caching)
- 10 requests/second throughput
- Linear scaling with document count
- Smooth progress updates

This simplified approach trades the theoretical benefits of caching for the practical benefits of parallelization and simplicity.
