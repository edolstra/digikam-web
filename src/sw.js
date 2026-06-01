// Service worker — required for the app to be installable as a PWA, and gives
// the app shell a network-first offline fallback. Dynamic data (/api/...) is
// left to the browser; only same-origin GETs for pages and static assets are
// intercepted, so the thumbnail-loading path is untouched.
var CACHE = 'digikam-browse-v1';
var SHELL = [
  '/photos', '/webpgf.js', '/webpgf.wasm', '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png', '/favicon.ico'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Pass cross-origin and dynamic API/media requests straight through.
  if (url.origin !== location.origin || url.pathname.indexOf('/api/') === 0) return;
  // Network-first: stay fresh online, fall back to the cache when offline.
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () { return caches.match(req); })
  );
});
