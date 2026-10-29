/*
 * SkyView service worker: makes the installed app open offline and lets
 * notifications work where pages can't show them directly (Android Chrome).
 *
 *  - page loads:            network first, cached copy when offline
 *  - /assets/* (hashed):    cache first; they never change, old ones are pruned
 *  - other same-origin GETs (icons, manifest, wasm): stale-while-revalidate
 *  - other sites (weather APIs, map tiles): untouched — the app keeps its own
 *    last-known forecast in localStorage
 */
const CACHE = 'skyview-v1';
const ASSET_LIMIT = 120;
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function prune(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.includes('/assets/'));
  for (const r of keys.slice(0, Math.max(0, keys.length - ASSET_LIMIT))) await cache.delete(r);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./', res.clone());
        return res;
      } catch {
        return (await caches.match('./')) ?? Response.error();
      }
    })());
    return;
  }

  if (url.pathname.includes('/assets/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
        prune(cache);
      }
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit ?? fresh;
  })());
});

// Tapping a notification brings the app forward (or opens it).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => 'focus' in c);
    if (client) return client.focus();
    return self.clients.openWindow('./');
  })());
});
