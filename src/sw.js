// Service worker — present only so the app is installable as a PWA.
//
// It deliberately does NOT intercept requests. A response served from a service
// worker bypasses the browser's HTTP cache, which would defeat the Cache-Control
// headers we rely on (immutable static assets, and the /photos pages' one-hour
// max-age) — exactly the "it keeps refetching" problem. Leaving every request to
// the browser keeps that caching working. A fetch handler must exist for the app
// to be installable, so we register an empty (pass-through) one.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  // Take control and drop any caches left by older, intercepting versions.
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

// Required for installability; intentionally a no-op so the HTTP cache governs.
self.addEventListener('fetch', function () {});
