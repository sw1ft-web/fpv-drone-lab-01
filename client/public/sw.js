/* Service worker: cache the static shell so the game UI opens offline.
 * Never touches /api, /ws, /health, /ready or /metrics (live data), nor non-GET requests. */
const CACHE = "fpv-shell-v1";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];
const LIVE = /^\/(api|ws|health|ready|metrics)(\/|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    LIVE.test(url.pathname)
  )
    return;
  // Network first (always fresh when online), fall back to the cache offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit ?? caches.match("/")),
      ),
  );
});
