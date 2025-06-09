import fetch from 'node-fetch';

export async function aiServiceAvailable({ provider = 'ollama', host } = {}) {
  if (provider === 'ollama') {
    const ollamaHost = host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    try {
      const res = await fetch(`${ollamaHost}/api/tags`, { timeout: 2000 });
      return res.ok;
    } catch {
      return false;
    }
  }
  // Add future checks for other providers here
  return false;
}

export async function classifyBlocksWithAI(blocks, opts = {}) {
  const provider = opts.provider || 'ollama';
  if (provider === 'ollama') {
    const model = opts.model || process.env.OLLAMA_MODEL || 'llama3.2:latest';
    const host = opts.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    const numberedBlocks = blocks.map((html, i) => `[${i}]: ${html}`);
    const prompt = `Given an array of HTML content blocks, return an array of block numbers (indices) that are NOT main content and should be deleted. Only return the array of numbers.\nBlocks:\n` + numberedBlocks.join('\n');
    try {
      const ollamaRes = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false })
      });
      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        const out = data.response || '';
        // Try to parse array of numbers
        const match = out.match(/\[(.*?)\]/);
        if (match) {
          return match[1].split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x));
        }
      }
    } catch (e) { /* fallback: ignore errors */ }
    return [];
  }
  // Add future logic for Anthropic, GPT, etc. here.
  return [];
}

// Alias for compatibility with older code
export const classifyBlocksWithOllama = classifyBlocksWithAI;

// Alias for compatibility with site_processor.js
export const ollamaAvailable = aiServiceAvailable;
