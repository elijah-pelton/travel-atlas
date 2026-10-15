// Retires the old GitHub Pages copy of Travel Atlas. Installed copies check this file for updates;
// this version takes over at once, deletes the old offline cache, removes itself, and reloads open
// windows so they get the forwarding page (index.html) instead of the cached old app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('atlas-')) await caches.delete(key);   // only ours: github.io is shared
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    for (const client of windows) { try { await client.navigate(client.url); } catch (_) {} }
  })());
});
