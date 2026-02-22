/* Workbox-based service worker for smarter caching strategies.
   This file uses the Workbox CDN. For production precaching integrate workbox-build
   into the build to inject a precache manifest. The code below provides runtime
   caching strategies for common asset types and a network-first approach for API.
*/

importScripts('https://storage.googleapis.com/workbox-cdn/releases/6.5.4/workbox-sw.js');

if (workbox) {
  const { routing, strategies, precaching, expiration } = workbox;

  // Precache manifest (will be empty if not injected by build tools)
  precaching.precacheAndRoute(self.__WB_MANIFEST || []);

  // Cache CSS/JS/assets with StaleWhileRevalidate for fast responses
  routing.registerRoute(
    ({ request }) => request.destination === 'script' || request.destination === 'style' || request.destination === 'font',
    new strategies.StaleWhileRevalidate({
      cacheName: 'static-resources',
      plugins: [ new expiration.ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }) ]
    })
  );

  // Images: CacheFirst with expiration
  routing.registerRoute(
    ({ request }) => request.destination === 'image',
    new strategies.CacheFirst({
      cacheName: 'images',
      plugins: [ new expiration.ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 60 }) ]
    })
  );

  // API calls: NetworkFirst with short timeout
  routing.registerRoute(
    ({ url }) => url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io'),
    new strategies.NetworkFirst({
      cacheName: 'api-responses',
      networkTimeoutSeconds: 3,
      plugins: [ new expiration.ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 60 * 5 }) ]
    })
  );

  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
  });
} else {
  // Workbox failed to load; fallback to minimal caching strategy
  self.addEventListener('fetch', (event) => {
    // no-op fallback
  });
}
