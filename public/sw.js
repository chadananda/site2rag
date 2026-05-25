// site2rag service worker — cache static assets only, never cache HTML
const CACHE = 'site2rag-__BUILD_TIME__';
// HTML is always fetched fresh; only cache versioned/hashed assets
const CACHEABLE = /\.(css|js|woff2?|png|jpg|jpeg|gif|svg|ico)$/;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/tailwind.css'])).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(Promise.all([
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Skip: API calls, version check, cross-origin
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.json') return;
  if (url.hostname !== self.location.hostname) return;
  // HTML always fetched fresh — never serve stale pages
  if (!CACHEABLE.test(url.pathname)) return;
  e.respondWith(
    caches.open(CACHE).then(c =>
      c.match(e.request).then(cached =>
        fetch(e.request).then(r => {
          if (r.ok) c.put(e.request, r.clone());
          return r;
        }).catch(() => cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
      )
    )
  );
});
