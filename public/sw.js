const cacheName = "doosriparchi-shell-v15";
const shell = ["/", "/style.css", "/app.mjs", "/case.mjs", "/sync-client.mjs", "/jsqr.js",
  "/demo.html", "/demo.mjs", "/issuer-keys.mjs", "/verify.html", "/export-receipt.mjs", "/export-verifier.mjs", "/fhir-import.mjs"];

async function shellResponse(path) {
  const page = path === "/" || path.endsWith(".html");
  const type = page ? /^text\/html\b/i : path.endsWith(".css") ? /^text\/css\b/i : /^(?:text|application)\/(?:java|ecma)script\b/i;
  const response = await fetch(path, { cache: "reload", redirect: "error", signal: AbortSignal.timeout(2500) });
  if (!response.ok || !type.test(response.headers.get("content-type") ?? "")) throw new Error("App file unavailable: " + path);
  return response;
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const responses = await Promise.all(shell.map(shellResponse));
    const cache = await caches.open(cacheName);
    await Promise.all(responses.map((response, index) => cache.put(shell[index], response)));
    await self.skipWaiting();
  })());
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
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    try { return await shellResponse(url.pathname); }
    catch { return new Response("Reconnect to load this app file.", { status: 503 }); }
  })());
});
