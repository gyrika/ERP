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

// Offers (CRM): the shop PC sends a short message encrypted to this phone; keep it in the phone's
// offers inbox (src/order/offersInbox.ts: same database, store and limits), show it, and open the
// inbox on a tap. Nothing personal is in it.
const OFFERS_DB = 'cheesybeez-offers';
const OFFERS_STORE = 'offers';
const KEEP_MAX = 50;

const openOffers = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(OFFERS_DB, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(OFFERS_STORE, { keyPath: 'id' }); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Saves the offer, then forgets the oldest past KEEP_MAX. A failure never stops the notification. */
const keepOffer = async (offer) => {
  const db = await openOffers();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(OFFERS_STORE, 'readwrite');
    const store = tx.objectStore(OFFERS_STORE);
    store.put(offer);
    const all = store.getAll();
    all.onsuccess = () => {
      const old = all.result.sort((a, b) => b.at - a.at).slice(KEEP_MAX);
      for (const o of old) store.delete(o.id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

self.addEventListener('push', (event) => {
  let message = { title: 'CheesyBeez', body: '' };
  try { message = { ...message, ...event.data.json() }; } catch { /* an empty push: the default */ }
  const offer = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(message.title).slice(0, 60),
    body: String(message.body).slice(0, 180),
    at: Date.now(),
  };
  event.waitUntil((async () => {
    try {
      await keepOffer(offer);
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of open) c.postMessage({ type: 'cheesybeez-offer' });
    } catch { /* no IndexedDB here: the notification still shows */ }
    await self.registration.showNotification(offer.title, {
      body: offer.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'cheesybeez-offer',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((c) => new URL(c.url).pathname.startsWith(APP_PATH));
    const inbox = `${APP_PATH.replace(/\/$/, '')}/#inbox`;
    // Already open: the page opens its inbox itself (no reload, the basket stays).
    if (here) { here.postMessage({ type: 'cheesybeez-open-inbox' }); return here.focus(); }
    return self.clients.openWindow(inbox);
  })());
});
