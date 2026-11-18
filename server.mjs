import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { handleApi, requestOrigin, send } from "./backend.mjs";

const files = {
  "/": ["public/index.html", "text/html"],
  "/style.css": ["public/style.css", "text/css"],
  "/app.mjs": ["public/app.mjs", "text/javascript"],
  "/case.mjs": ["public/case.mjs", "text/javascript"],
  "/sync-client.mjs": ["public/sync-client.mjs", "text/javascript"],
  "/sw.js": ["public/sw.js", "text/javascript"],
  "/jsqr.js": ["node_modules/jsqr/dist/jsQR.js", "text/javascript"]
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path.startsWith("/api/") || path === "/healthz") return handleApi(req, res, path);
  if (!requestOrigin(req)) return send(res, 403, { error: "Open the configured demo address." });
  if (req.method !== "GET" || !Object.hasOwn(files, path)) return send(res, 404, { error: "Page unavailable." });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const [file, type] = files[path];
    const content = await readFile(new URL(file, import.meta.url));
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(content);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "The referral workspace is unavailable." });
  }
});

server.requestTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 4180), process.env.HOST ?? "127.0.0.1", () => {
  console.log("DoosriParchi listening at " + (process.env.PUBLIC_ORIGIN || "http://127.0.0.1:" + server.address().port));
});
