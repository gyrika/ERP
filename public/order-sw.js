const CACHE_PREFIX = 'cheesybeez-order-';
const CACHE = `${CACHE_PREFIX}v1`;
const STATIC_PATHS = ['/assets/', '/icons/'];
const APP_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '') || '/';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch(APP_PATH);
    if (response.ok) await cache.put(APP_PATH, response);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_ASSETS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = event.data.urls.filter((value) => typeof value === 'string').map((value) => new URL(value, self.location.origin))
      .filter((url) => url.origin === self.location.origin && STATIC_PATHS.some((path) => url.pathname.startsWith(path)));
    await Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      if (response.ok) await cache.put(url, response);
    }));
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' && (url.pathname === APP_PATH || (APP_PATH !== '/' && url.pathname === `${APP_PATH}/`))) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(APP_PATH, copy));
      }
      return response;
    }).catch(async () => (await caches.match(APP_PATH)) ?? Response.error()));
    return;
  }

  if (STATIC_PATHS.some((path) => url.pathname.startsWith(path))) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })));
  }
});
