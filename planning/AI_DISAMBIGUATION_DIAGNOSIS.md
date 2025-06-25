# AI Context Disambiguation Diagnosis

## Summary

GPT-4o-mini performs poorly with JSON-constrained responses but works well with plain text. The model adds only 2-3 disambiguations with JSON but 8+ without it.

## Key Discovery

**JSON requirement severely limits GPT-4o-mini's disambiguation capability**

### With JSON Format Required

- Only 2-3 disambiguations per document
- Misses obvious pronouns and references
- Sometimes replaces words instead of adding context
- Not systematic in checking all references

### Without JSON Format (Plain Text)

- 8+ disambiguations in the same text
- Catches pronouns, vague nouns, temporal references
- Correctly adds context after words (not replacing)
- More comprehensive and natural processing

## Test Results

### Direct AI Test

When testing the AI directly with a sample paragraph:

- Input: "Overall, this was a fantastic project. So many people pitched in along the way and in the end, we managed to encourage interaction with the sacred texts."
- Output: Correctly added 2 disambiguations:
  - "this [[the Ocean CD distribution]]"
  - "we [[the project team]]"

### Full Document Processing

When processing the full document:

- Total disambiguations added: 2 (out of potentially 50+)
- Line 62: "Mr. Shah [[a respected figure in the Bahá'í community]]"
- Line 64: "search engines like Google were just beginning [[in the late 1990s and early 2000s]]"

### Missing Disambiguations

Many obvious pronouns and references were not disambiguated:

- "My journey" (line 30)
- "I had already purchased" (line 38)
- "This was not just a task" (line 38)
- "they had plans" (line 44)
- "we managed to encourage interaction" (line 90)
- "this was a fantastic project" (line 90)
- Many more instances of I, me, my, we, us, our, they, them, etc.

## Root Cause Analysis

### 1. Model Limitations

GPT-4o-mini appears to be:

- Only processing a small subset of the content
- Not systematically checking every pronoun as instructed
- Possibly hitting token limits or attention span issues

### 2. Prompt Effectiveness

The prompt is clear and includes:

- Explicit list of pronouns to disambiguate
- Clear examples showing the desired format
- JSON structure for input/output
- Critical instructions not to replace words

### 3. Processing Architecture

The sliding window approach is working correctly:

- Windows are created properly
- AI is called for each window
- Responses are validated

## Recommendations

1. **Test with More Capable Models**
   - Try GPT-4o instead of GPT-4o-mini
   - Test with Claude 3 Haiku or Sonnet
2. **Prompt Engineering**
   - Add explicit instruction to process EVERY pronoun
   - Include a checklist format in the prompt
   - Break into smaller chunks (single paragraphs)

3. **Validation Improvements**
   - Add metrics to count expected vs actual disambiguations
   - Log which pronouns were missed
   - Create a pronoun detection function to verify coverage

4. **Alternative Approaches**
   - Pre-process to identify all pronouns first
   - Send pronoun locations explicitly to the AI
   - Use a two-pass approach: identify then disambiguate

## Conclusion

GPT-4o-mini is not following the disambiguation instructions comprehensively. While it can disambiguate correctly when prompted with specific examples, it's not systematically processing all pronouns in the document. This appears to be a limitation of the mini model's instruction-following capabilities rather than a bug in our code.
