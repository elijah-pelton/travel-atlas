/* Travel Atlas service worker. Plain JS, no imports.
 *
 * VERSION is stamped by tools/stamp-sw.py: a hash of every precached file plus this file's
 * own code. Run `python3 tools/stamp-sw.py` before each commit; any change to the app then
 * changes sw.js byte-for-byte, so installed copies always notice the new version.
 *
 * Update flow: the new worker installs alongside the old one and waits. The page shows
 * "Update available · Reload", posts {type:'SKIP_WAITING'}, and reloads on controllerchange.
 * Nothing refreshes on its own.
 *
 * Strategies (same-origin GET only; everything else goes straight to the network):
 *   ./api/*                  never handled here (no respondWith): network only, never cached
 *   navigations to the app   (./, ./index.html and ./map/<id>, which is the same app page)
 *                            cache-first from this version's precached ./index.html, so the
 *                            page and its CSS/JS always come from the same version; network
 *                            only if the cache is missing it. Never written from here.
 *   other navigations        network, falling back to the cached ./index.html when offline
 *   ./terrain/*.jpg          cache-first into the unversioned terrain cache (kept across
 *                            versions; terrain files are renamed if their content changes)
 *   everything else          cache-first from this version's shell cache (css, js, data,
 *                            icons, fonts), network fallback, successful responses stored
 */
const VERSION = '2f12c3046f';
const SHELL_CACHE = 'atlas-shell-' + VERSION;
const TERRAIN_CACHE = 'atlas-terrain';
const LEGACY_TERRAIN_PREFIX = 'atlas-terrain-';   // old per-version terrain caches

// Generated from the "precache" list in tools/asset-list.json by tools/stamp-sw.py.
const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './css/features.css',
  './css/fonts.css',
  './js/app.js',
  './js/cities.js',
  './js/ratings.js',
  './js/places-panel.js',
  './js/store.js',
  './js/accent.js',
  './js/vendor/qrcode.js',
  './data/na.json',
  './data/world.json',
  './data/cities.json',
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
const SCOPE_URL = abs('./');
const INDEX_URL = abs('./index.html');
const TERRAIN_PREFIX = abs('./terrain/');
const API_PREFIX = abs('./api/');
const MAP_PREFIX = abs('./map/');

// Only store complete, same-origin successes (never opaque, redirected-error or partial).
const cacheable = (res) => res && res.ok && res.status === 200 && res.type === 'basic';

self.addEventListener('install', (event) => {
  // All-or-nothing: if any file fails, the install fails and the old worker stays.
  // cache: 'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600), so a new
  // version never precaches stale copies of the old files.
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
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Carry terrain over from older per-version caches before deleting them.
    const legacy = keys.filter((k) => k.startsWith(LEGACY_TERRAIN_PREFIX));
    if (legacy.length) {
      try {
        const terrain = await caches.open(TERRAIN_CACHE);
        for (const name of legacy) {
          const old = await caches.open(name);
          for (const req of await old.keys()) {
            if (await terrain.match(req)) continue;
            const res = await old.match(req);
            if (res) await terrain.put(req, res);
          }
        }
      } catch (_) { /* best-effort; terrain is re-fetched on demand */ }
    }
    await Promise.all(
      keys
        .filter((k) => k.startsWith('atlas-') && k !== SHELL_CACHE && k !== TERRAIN_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.href.startsWith(API_PREFIX)) return;   // sync API: straight to the network, any method
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    const page = url.origin + url.pathname;
    if (page === SCOPE_URL || page === INDEX_URL || page.startsWith(MAP_PREFIX)) event.respondWith(appShell(req));
    else event.respondWith(otherPage(req));
  } else if (url.href.startsWith(TERRAIN_PREFIX) && url.pathname.endsWith('.jpg')) {
    event.respondWith(cacheFirst(req, TERRAIN_CACHE));
  } else {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});

// Look only in THIS version's shell cache: a newer worker's cache may already exist while
// this one is still in control, and its HTML must not be mixed with this version's JS/CSS.
async function cachedIndex() {
  const cache = await caches.open(SHELL_CACHE);
  return (
    (await cache.match(INDEX_URL, { ignoreSearch: true })) ||
    (await cache.match(SCOPE_URL, { ignoreSearch: true }))
  );
}

// A host may answer ./index.html with a redirect to ./ (Cloudflare does). The browser refuses a
// redirected response for a navigation, so hand out a plain copy of it instead.
async function plain(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function appShell(req) {
  const cached = await cachedIndex();
  return cached ? plain(cached) : fetch(req);
}

async function otherPage(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cached = await cachedIndex();
    if (cached) return plain(cached);
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
