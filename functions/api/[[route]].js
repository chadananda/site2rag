// CF Pages Function: proxy /api/* to backend with CORS headers.
// BACKEND_URL env var (set in CF Pages settings) overrides the default.
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  const backend = (env.BACKEND_URL || 'https://api.lnker.com').replace(/\/$/, '');
  const target = backend + url.pathname + url.search;

  // Build clean headers — don't forward host/content-length/connection (CF Workers rejects them)
  const headers = new Headers();
  const skip = new Set(['host','content-length','connection','transfer-encoding','keep-alive']);
  for (const [k, v] of request.headers.entries()) {
    if (!skip.has(k.toLowerCase())) headers.set(k, v);
  }

  // Only forward body for methods that have one
  const hasBody = !['GET', 'HEAD'].includes(request.method) &&
    request.headers.get('content-type');

  let response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: 'follow',
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Backend unreachable', detail: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const outHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) outHeaders.set(k, v);
  return new Response(response.body, { status: response.status, headers: outHeaders });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
