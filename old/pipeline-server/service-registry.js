// Unified service registry. Every OCR engine, preprocessor, LLM, and vision model is a service.
// Exports: registerService, registerOverflow, getService, getServices, listServices, isAvailable, getPoolStatus, callService
// All services share: id, type, endpoint|endpoints, cost.tier, call()
// Types: ocr | preprocess | synthesis | vision | layout | detect
// Endpoints: 'local' (subprocess) | 'http://host:port' (network node) | 'https://...' (cloud API)
// Pool: pass endpoints[] array (or comma-separated endpoint string) + optional poolStrategy to enable pool routing
// Routing: local endpoints first (free), overflow endpoints only when all local endpoints are saturated

const _registry = new Map();
// serviceId → { endpoints: [{url, tier, maxConcurrent, inflight, healthy, failures}], strategy, roundRobinIdx }
const _pools = new Map();

// --- Pool internals ---

function _parseEndpoint(raw) {
  if (typeof raw === 'object' && raw !== null) {
    // Already an object — fill in defaults
    const tier = raw.tier ?? 'local';
    const maxConcurrent = raw.maxConcurrent ?? (tier === 'overflow' ? 1 : Infinity);
    return { url: raw.url, tier, maxConcurrent, inflight: raw.inflight ?? 0, healthy: raw.healthy ?? true, failures: raw.failures ?? 0 };
  }
  // Legacy string
  const url = raw.trim();
  const tier = 'local';
  const maxConcurrent = Infinity;
  return { url, tier, maxConcurrent, inflight: 0, healthy: true, failures: 0 };
}

function _initPool(entry) {
  const rawList = entry.endpoints
    ? entry.endpoints
    : entry.endpoint?.includes(',') ? entry.endpoint.split(',') : null;
  if (!rawList) return;
  const endpoints = rawList.map(_parseEndpoint);
  _pools.set(entry.id, { endpoints, strategy: entry.poolStrategy ?? 'least-busy', roundRobinIdx: 0 });
}

function _pickEndpoint(serviceId) {
  const pool = _pools.get(serviceId);
  if (!pool) throw new Error(`_pickEndpoint: no pool for '${serviceId}'`);
  const healthy = pool.endpoints.filter(e => e.healthy);
  if (healthy.length === 0) throw new Error(`${serviceId}: all pool endpoints unhealthy`);
  const localEndpoints = healthy.filter(e => e.tier === 'local');
  const overflowEndpoints = healthy.filter(e => e.tier === 'overflow');
  // Local endpoints with remaining capacity
  const localWithCapacity = localEndpoints.filter(e => e.inflight < e.maxConcurrent);
  if (localWithCapacity.length > 0) {
    // Least-busy among local endpoints with capacity
    return localWithCapacity.reduce((best, e) => e.inflight < best.inflight ? e : best, localWithCapacity[0]);
  }
  // All local saturated (or none exist) — fall through to overflow
  if (overflowEndpoints.length > 0) {
    return overflowEndpoints.reduce((best, e) => e.inflight < best.inflight ? e : best, overflowEndpoints[0]);
  }
  throw new Error('all endpoints saturated — no capacity available');
}

async function _callPooled(serviceId, callFn) {
  const endpoint = _pickEndpoint(serviceId);
  endpoint.inflight++;
  try {
    const result = await callFn(endpoint.url, endpoint.tier);
    endpoint.failures = 0;
    return result;
  } catch (err) {
    endpoint.failures = (endpoint.failures ?? 0) + 1;
    if (endpoint.failures >= 3) {
      endpoint.healthy = false;
      setTimeout(() => { endpoint.healthy = true; endpoint.failures = 0; }, 30000);
    }
    throw err;
  } finally {
    endpoint.inflight--;
  }
}

async function _remoteOcrCall(endpointUrl, engineId, pngPath, lang) {
  const { readFileSync } = await import('fs');
  const imageB64 = readFileSync(pngPath).toString('base64');
  const res = await fetch(`${endpointUrl}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: engineId, image_b64: imageB64, lang }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${engineId} remote: HTTP ${res.status}`);
  return res.json();
}

// --- Public API ---

export function registerService(entry) {
  const hasPool = entry.endpoints || (entry.endpoint && entry.endpoint.includes(','));
  if (!entry.id || !entry.type || (!entry.endpoint && !entry.endpoints) || !entry.call)
    throw new Error(`registerService: missing required field (id, type, endpoint|endpoints, call) in ${JSON.stringify({ id: entry.id, type: entry.type })}`);
  if (_registry.has(entry.id)) console.warn(`service-registry: duplicate id '${entry.id}' — overwriting`);
  // Normalize: if endpoints array given, store a canonical endpoint value for legacy callers
  const firstEndpoint = entry.endpoint ?? (Array.isArray(entry.endpoints) ? (typeof entry.endpoints[0] === 'string' ? entry.endpoints[0] : entry.endpoints[0].url) : undefined);
  const stored = { ...entry, endpoint: firstEndpoint };
  _registry.set(entry.id, stored);
  if (hasPool) _initPool({ ...entry });
}

/** Add an overflow endpoint to an existing service pool at runtime. */
export function registerOverflow(serviceId, url, maxConcurrent = 1) {
  const pool = _pools.get(serviceId);
  if (!pool) throw new Error(`No pool for service: ${serviceId}`);
  pool.endpoints.push({ url, tier: 'overflow', maxConcurrent, inflight: 0, healthy: true, failures: 0 });
}

export function getService(id) { return _registry.get(id); }

export function getServices(filter = {}) {
  let results = [..._registry.values()];
  if (filter.type)               results = results.filter(s => s.type === filter.type);
  if (filter.tier !== undefined) results = results.filter(s => s.cost?.tier === filter.tier);
  if (filter.gpu !== undefined)  results = results.filter(s => (s.cost?.gpu ?? false) === filter.gpu);
  if (filter.lang)               results = results.filter(s => !s.languages || s.languages.includes('*') || s.languages.includes(filter.lang));
  if (filter.blockType)          results = results.filter(s => !s.blockTypes || s.blockTypes.includes(filter.blockType));
  return results.sort((a, b) => {
    const tierDiff = (a.cost?.tier ?? 99) - (b.cost?.tier ?? 99);
    if (tierDiff !== 0) return tierDiff;
    return (a.cost?.gpu ? 1 : 0) - (b.cost?.gpu ? 1 : 0); // CPU before GPU
  });
}

export function listServices() { return [..._registry.values()]; }

export async function isAvailable(service) {
  const pool = _pools.get(service.id);
  if (pool) return pool.endpoints.some(e => e.healthy);
  if (service.endpoint === 'local') return true;
  if (service.endpoint === 'cloud') return !!service.cost?.requiresKey ? true : false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${service.endpoint}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch { return false; }
}

/** Returns pool endpoint status array for monitoring. Non-pooled service returns null. */
export function getPoolStatus(serviceId) {
  const pool = _pools.get(serviceId);
  if (!pool) return null;
  return pool.endpoints.map(({ url, inflight, healthy, tier, maxConcurrent }) => ({
    url, inflight, healthy, tier, maxConcurrent,
    utilizationPct: maxConcurrent === Infinity ? 0 : inflight / maxConcurrent,
  }));
}

/**
 * Call a service by id. Automatically routes through pool if pooled.
 * For OCR services: args = [pngPath, lang]
 * For pooled remote endpoints, image is sent as base64; local endpoints call service._localCall or service.call.
 * Result includes _routedTo: 'local'|'overflow' when pool routing was used.
 */
export async function callService(serviceId, ...args) {
  const service = getService(serviceId);
  if (!service) throw new Error(`callService: unknown service '${serviceId}'`);
  const pool = _pools.get(serviceId);
  if (!pool) return service.call(...args);
  return _callPooled(serviceId, async (endpointUrl, tier) => {
    const result = endpointUrl === 'local'
      ? await (service._localCall ?? service.call)(...args)
      : await _remoteOcrCall(endpointUrl, service.id, args[0], args[1]);
    return { ...result, _routedTo: tier };
  });
}
