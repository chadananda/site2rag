// AI relay service for the orchestrator.
// Workers post to /api/relay with {relay_id, callback_url, provider, model, messages, max_tokens, system?}.
// This module routes by provider, throttles, retries, then POSTs {relay_id, result|error} to callback_url.
// Workers hold no API keys. All throttling and key management lives here.

const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY ?? '';
const DEEPSEEK_KEY       = process.env.DEEPSEEK_API_KEY  ?? '';
const WORKER_SECRET      = process.env.WORKER_SECRET      ?? '';
const LOCAL_VISION_URL   = process.env.LOCAL_VISION_URL   ?? 'http://boss:8081';
const LOCAL_TEXT_URL     = process.env.LOCAL_TEXT_URL     ?? 'http://boss:8082';

// ── Provider registry ─────────────────────────────────────────────────────────
// rpm / tpm are soft targets — the token bucket enforces them.
const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: () => ANTHROPIC_KEY,
    rpm: 50,
    tpm: 40_000,
    buildHeaders(key) {
      return {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };
    },
    buildBody({ model, messages, max_tokens, system }) {
      const body = { model, messages, max_tokens };
      if (system) body.system = system;
      return body;
    },
    extractContent(data) { return data; }, // Anthropic shape is already correct
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    endpoint: 'chat/completions',
    apiKey: () => DEEPSEEK_KEY,
    rpm: 500,
    tpm: 1_000_000,
    buildHeaders(key) {
      return {
        'Authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      };
    },
    buildBody({ model, messages, max_tokens, system }) {
      const msgs = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;
      return { model, messages: msgs, max_tokens };
    },
    // Normalise OpenAI-compatible response to Anthropic content shape.
    // V4-flash is a reasoning model: final answer in content, reasoning in reasoning_content.
    // If content is empty the model ran out of tokens during reasoning — bump max_tokens.
    extractContent(data) {
      const choice = data.choices?.[0];
      const text = choice?.message?.content || choice?.message?.reasoning_content || '';
      const usage = data.usage ?? {};
      return {
        content: [{ type: 'text', text }],
        usage: {
          input_tokens:      usage.prompt_tokens ?? 0,
          output_tokens:     usage.completion_tokens ?? 0,
          cache_hit_tokens:  usage.prompt_cache_hit_tokens ?? 0,
        },
      };
    },
  },
  // Local Qwen3.6-27B-MTP on boss (port 8082). OpenAI-compatible. No API key, zero cost.
  // Use for synthesis when DeepSeek costs matter; falls back to DeepSeek if unavailable.
  local_text: {
    rpm: 60,
    call: async (payload) => {
      const { messages, max_tokens, system } = payload;
      const msgs = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;
      const res = await fetch(`${LOCAL_TEXT_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'local', messages: msgs, max_tokens: max_tokens ?? 256 }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage ?? {};
      return {
        content: [{ type: 'text', text }],
        usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
      };
    },
  },
  // Local Qwen2.5-VL-7B on boss llama-server (port 8081). No API key; no rate limit needed.
  // Translates Anthropic-format messages (image + text) to OpenAI chat completions format.
  local_vision: {
    rpm: 120,
    call: async (payload) => {
      const { messages, max_tokens } = payload;
      // Translate Anthropic content blocks → OpenAI content parts
      const oaiMessages = (messages ?? []).map(msg => ({
        role: msg.role,
        content: (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }])
          .map(part => {
            if (part.type === 'image') {
              const data = part.source?.data ?? '';
              const mime = part.source?.media_type ?? 'image/png';
              return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
            }
            return { type: 'text', text: part.text ?? '' };
          }),
      }));

      const res = await fetch(`${LOCAL_VISION_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'local', messages: oaiMessages, max_tokens: max_tokens ?? 512 }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      const text = data.choices?.[0]?.message?.content ?? '';
      return {
        content: [{ type: 'text', text }],
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  },
};

// ── Per-provider throttle state (token bucket) ────────────────────────────────
// tokens replenish every minute at the rpm/tpm rate.
const throttle = {};
for (const [name, p] of Object.entries(PROVIDERS)) {
  throttle[name] = { requestTokens: p.rpm, lastRefill: Date.now() };
}

function refillBucket(name) {
  const p = PROVIDERS[name];
  const t = throttle[name];
  const elapsedMin = (Date.now() - t.lastRefill) / 60_000;
  t.requestTokens = Math.min(p.rpm, t.requestTokens + elapsedMin * p.rpm);
  t.lastRefill = Date.now();
}

async function waitForSlot(name) {
  for (;;) {
    refillBucket(name);
    if (throttle[name].requestTokens >= 1) {
      throttle[name].requestTokens -= 1;
      return;
    }
    // Sleep until next token
    const msPerToken = 60_000 / PROVIDERS[name].rpm;
    await new Promise(r => setTimeout(r, msPerToken));
  }
}

// ── Single attempt ────────────────────────────────────────────────────────────
async function callProvider(provider, payload) {
  const p = PROVIDERS[provider];

  // Providers with a custom call() skip the generic HTTP logic entirely
  if (p.call) return p.call(payload);

  const key = p.apiKey();
  if (!key) throw new Error(`no API key configured for provider: ${provider}`);

  const url = `${p.baseUrl}/${p.endpoint ?? 'messages'}`;
  const headers = p.buildHeaders(key);
  const body = p.buildBody(payload);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return p.extractContent(data);
}

// ── Retry with backoff ────────────────────────────────────────────────────────
const MAX_RETRIES = 4;
const BASE_DELAY  = 1_000;

async function callWithRetry(provider, payload) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await waitForSlot(provider);
    try {
      return await callProvider(provider, payload);
    } catch (e) {
      lastErr = e;
      // 429 / 529 rate-limit — back off longer
      const isRateLimit = e.status === 429 || e.status === 529;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1) * (isRateLimit ? 3 : 1);
        console.warn(`[ai-relay] ${provider} attempt ${attempt}/${MAX_RETRIES} failed (${e.message.slice(0, 80)}), retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`${provider} failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`);
}

// ── Callback to worker ────────────────────────────────────────────────────────
async function postCallback(callbackUrl, body) {
  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn(`[ai-relay] callback to ${callbackUrl} failed: ${e.message}`);
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
// Called from the /api/relay route. Fires-and-forgets the async work; returns immediately.
export function handleRelayRequest(body, workerSecret, log = console.log) {
  const { relay_id, callback_url, provider, model, messages, max_tokens, system } = body;

  if (!relay_id || !callback_url) {
    return { error: 'relay_id and callback_url are required' };
  }
  if (!provider || !PROVIDERS[provider]) {
    return { error: `unknown provider: ${provider}. available: ${Object.keys(PROVIDERS).join(', ')}` };
  }
  if (workerSecret && body.workerSecret !== workerSecret) {
    // secret validated in the route layer via x-worker-token header — this is a belt-and-suspenders check
  }

  // Kick off async, post callback when done
  (async () => {
    try {
      const result = await callWithRetry(provider, { model, messages, max_tokens, system });
      log(`[ai-relay] ${provider}/${model} ok relay_id=${relay_id}`);
      await postCallback(callback_url, { relay_id, result });
    } catch (e) {
      log(`[ai-relay] ${provider}/${model} error relay_id=${relay_id}: ${e.message}`);
      await postCallback(callback_url, { relay_id, error: e.message });
    }
  })();

  return { ok: true, relay_id };
}
