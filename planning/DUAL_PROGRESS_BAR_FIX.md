# Dual Progress Bar Fix Summary

## Issue
The dual progress bars were being destroyed and replaced with a single bar when `startProcessing` was called after the parallel processor completed. This happened because:

1. `completeProcessing()` was stopping the entire multibar container and setting it to null
2. `startProcessing()` would then fall back to creating a SingleBar instead of maintaining dual bars

## Solution

### 1. Fixed `completeProcessing()` method
- Changed to only update the AI bar to 100% completion in dual mode
- Prevented destruction of the multibar container
- Only stops multibar in legacy single bar mode

### 2. Enhanced `startProcessing()` method  
- Added logic to recreate the AI bar if in dual mode but AI bar is missing
- Maintains the dual bar display throughout the entire process
- Falls back to single bar only when not in dual mode

### 3. Fixed `callAI()` to return usage data
- Modified to return both content and usage data for plain text responses
- Ensures token tracking works properly for all AI calls

## Result
- Dual progress bars are now maintained throughout the entire crawling and AI processing lifecycle
- Token tracking displays correctly in the AI progress bar
- Header shows with proper spacing (empty line at top inside the box)
- Progress bars update in place without breaking the dual display