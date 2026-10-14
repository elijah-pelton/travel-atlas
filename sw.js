/* Travel Atlas service worker. Plain JS, no imports.
 *
 * Bump VERSION whenever any precached file changes; the new worker installs alongside the
 * old one and waits. The page shows "Update available · Reload", posts {type:'SKIP_WAITING'},
 * and reloads on controllerchange.
 *
 * Strategies (same-origin GET only; everything else goes straight to the network):
 *   navigations          network-first, fall back to cached ./index.html (offline)
 *   ./terrain/*.jpg      cache-first into the terrain cache, stored on first fetch
 *   everything else      cache-first (precached shell: css, js, data, icons, fonts),
 *                        network fallback, successful responses stored
 */
const VERSION = 'v1';
const SHELL_CACHE = 'atlas-shell-' + VERSION;
const TERRAIN_CACHE = 'atlas-terrain-' + VERSION;
const CURRENT = [SHELL_CACHE, TERRAIN_CACHE];

// Must match the "precache" list in tools/asset-list.json.
const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './css/fonts.css',
  './js/app.js',
  './data/na.json',
  './data/world.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './fonts/bricolage-grotesque-latin.woff2',
  './fonts/ibm-plex-sans-400-latin.woff2',
  './fonts/ibm-plex-sans-500-latin.woff2',
  './fonts/ibm-plex-sans-600-latin.woff2',
  './fonts/ibm-plex-mono-400-latin.woff2',
  './fonts/ibm-plex-mono-500-latin.woff2'
];

const abs = (path) => new URL(path, self.location).href;
const INDEX_URL = abs('./index.html');
const TERRAIN_PREFIX = abs('./terrain/');

// Only store complete, same-origin successes (never opaque, redirected-error or partial).
const cacheable = (res) => res && res.ok && res.status === 200 && res.type === 'basic';

self.addEventListener('install', (event) => {
  // All-or-nothing: if any file fails, the install fails and the old worker stays.
  // cache: 'reload' bypasses the HTTP cache so a new VERSION gets fresh files.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(PRECACHE.map((p) => new Request(abs(p), { cache: 'reload' })))
    )
  );
  // No skipWaiting() here: the page offers an update toast instead.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('atlas-') && !CURRENT.includes(k))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
  } else if (url.href.startsWith(TERRAIN_PREFIX) && url.pathname.endsWith('.jpg')) {
    event.respondWith(cacheFirst(req, TERRAIN_CACHE));
  } else {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});

async function networkFirstPage(req) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) {
      const copy = res.clone();
      caches.open(SHELL_CACHE).then((c) => c.put(INDEX_URL, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached =
      (await caches.match(INDEX_URL, { ignoreSearch: true })) ||
      (await caches.match(abs('./'), { ignoreSearch: true }));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) cache.put(req, res.clone()).catch(() => {});
  return res;
}
