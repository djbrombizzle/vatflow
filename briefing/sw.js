/* Cache the page itself so it opens with no network. The whole app is one
 * document, so precaching that document is the whole job. */
var CACHE = 'vfb-briefing-v1';
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(['./', './briefing.html']);
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Only ever serve this tool; never interfere with the rest of the origin.
  if (e.request.method !== 'GET') return;
  if (!/briefing\.html$/.test(url.pathname) && url.pathname !== self.registration.scope.replace(location.origin, '')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      });
    })
  );
});
