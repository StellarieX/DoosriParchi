const cacheName = "doosriparchi-shell-v14";
const shell = ["/", "/style.css", "/app.mjs", "/case.mjs", "/sync-client.mjs", "/jsqr.js",
  "/verify.html", "/export-receipt.mjs", "/export-verifier.mjs"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith("doosriparchi-shell-") && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin ||
      !shell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
});
