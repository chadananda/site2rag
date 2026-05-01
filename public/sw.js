// site2rag service worker — cache static assets, skip API, auto-reload on update
const CACHE = 'site2rag-__BUILD_TIME__';
const STATIC = ['/index.html', '/tailwind.css'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
});

self.addEventListener('activate', e => {
  e.waitUntil(Promise.all([
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache: API calls, version check, localhost dev
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.json') return;
  if (url.hostname === '127.0.0.1') return;
  e.respondWith(
    caches.open(CACHE).then(c =>
      c.match(e.request).then(cached => cached ?? fetch(e.request).then(r => {
        if (r.ok) c.put(e.request, r.clone());
        return r;
      }))
    )
  );
});
