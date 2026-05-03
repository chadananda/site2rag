// site2rag service worker — cache static assets, skip API, auto-reload on update
const CACHE = 'site2rag-__BUILD_TIME__';
const STATIC = ['/index.html', '/tailwind.css', '/viewer.html'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Precache core shell; pdfjs files are large and cached on first use instead
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}));
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
  // Skip: API calls, version check, cross-origin (CDN/API server), localhost dev
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.json') return;
  if (url.hostname !== self.location.hostname) return;
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
