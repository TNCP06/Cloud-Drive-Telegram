// web/public/sw.js — kill-switch Service Worker.
//
// The previous SW intercepted /api/stream/ and re-implemented video buffering on
// top of IndexedDB (2 MB chunks, 4 MB max per response, sequential fetches, and a
// full-store getAll() on every write). That caused the periodic "play a few
// seconds → stall → resume" stutter and heavy client RAM/IO. Native <video>
// buffering + the server's own disk/compressed cache do the job better, so this
// SW's only purpose is to replace the old one in clients that still have it:
// it takes over immediately, drops the old cache DB, and unregisters itself.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      try {
        indexedDB.deleteDatabase('video-cache-db');
      } catch (_) {}
      // claim() makes this no-fetch-handler SW the controller, so video requests
      // already go straight to the network; unregister removes it entirely on the
      // next navigation.
      await self.registration.unregister();
    })()
  );
});
