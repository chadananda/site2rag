# LLM Comparison and Insertion Tracking Guide

## Overview

Site2rag now supports multiple LLM providers for AI disambiguation with comprehensive insertion tracking and comparison features for test mode.

## New CLI Flags

### LLM Provider Selection

- `--use_opus4` - Anthropic Claude 3.5 Sonnet (requires ANTHROPIC_API_KEY)
- `--use_haiku` - Anthropic Claude 3.5 Haiku (requires ANTHROPIC_API_KEY)
- `--use_gpt4o` - OpenAI GPT-4o (requires OPENAI_API_KEY)
- `--use_gpt4_turbo` - OpenAI GPT-4 Turbo (requires OPENAI_API_KEY)
- `--use_o1_mini` - OpenAI o1-mini (requires OPENAI_API_KEY)
- `--use_mistral_large` - Mistral Large (requires MISTRAL_API_KEY)
- `--use_perplexity` - Perplexity API (requires PERPLEXITY_API_KEY)
- `--use_r1_grok` - xAI Grok (requires XAI_API_KEY)

### Test Mode Enhancement

- `--test` - Enables detailed insertion tracking and LLM comparison logging

## Usage Examples

### Basic LLM Comparison

```bash
# Test with Claude 3.5 Sonnet
site2rag bahai-education.org --limit 20 --test --use_opus4

# Test with GPT-4o
site2rag bahai-education.org --limit 20 --test --use_gpt4o

# Test with Mistral Large
site2rag bahai-education.org --limit 20 --test --use_mistral_large
```

### Using npm Scripts

```bash
npm run test:bahai-opus4     # Claude 3.5 Sonnet
npm run test:bahai-haiku     # Claude 3.5 Haiku
npm run test:bahai-gpt4o     # GPT-4o
npm run test:bahai-gpt4turbo # GPT-4 Turbo
npm run test:bahai-mistral   # Mistral Large
npm run test:bahai-perplexity # Perplexity
```

## Required Environment Variables

Set these in your `.env` file:

```env
ANTHROPIC_API_KEY="your_anthropic_key_here"
OPENAI_API_KEY="your_openai_key_here"
MISTRAL_API_KEY="your_mistral_key_here"
PERPLEXITY_API_KEY="your_perplexity_key_here"
XAI_API_KEY="your_xai_key_here"
```

## Test Mode Output

When using `--test` flag, you'll get detailed insertion tracking:

```
================================================================================
🤖 LLM ENHANCEMENT SUMMARY - anthropic/claude-3-5-sonnet-20241022
================================================================================
📊 Total files processed: 5
📊 Total insertions: 23
📊 Total enhanced blocks: 15
⏱️  Processing time: 45.2s

📄 PER-FILE BREAKDOWN:
  the-ocean-adventure.md: 8 insertions
  about-us.md: 6 insertions
  services.md: 4 insertions
  contact.md: 3 insertions
  blog-post.md: 2 insertions

🔍 ALL ENHANCED BLOCKS (for LLM comparison):

📄 the-ocean-adventure.md - Block block_2:
Original: "Overall, this was a fantastic project. So many people pitched in along the way..."
Enhanced: "Overall, this [[Ocean search software development]] was a fantastic project. So many people..."
Insertions: [[Ocean search software development]], [[Bahá'í community members]]
```

## Comparison Workflow

1. **Choose your test dataset**: Use consistent parameters (same site, same limit)
2. **Run multiple LLMs**: Test each provider with the same content
3. **Compare results**: Review insertion counts and quality
4. **Analyze performance**: Check processing times and success rates

## Best Practices

### For Speed Comparison

- Use shorter timeouts for faster models
- Test with same concurrency settings
- Monitor rate limiting

### For Quality Comparison

- Focus on disambiguation accuracy
- Check if "this", "that", "it" are properly clarified
- Verify context relevance
- Look for hallucinations vs document-only context

### For Cost Analysis

- Track API usage and costs per provider
- Compare cost per insertion/enhancement
- Factor in processing time vs quality

## Integration Notes

- All providers use the same disambiguation prompt
- Temperature set to 0.1 for consistency
- JSON schema validation ensures consistent output format
- Automatic fallback to original content on errors
- Session tracking isolates each test run

This system enables systematic LLM comparison for optimal disambiguation results.
