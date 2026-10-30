/* sw.js — PWA 离线缓存：应用外壳 + OCR 资产缓存优先，API 网络优先 */
const CACHE = "su7-charging-v1";
const ASSETS = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/api.js",
  "/static/db.js",
  "/static/ocr.js",
  "/static/parser.js",
  "/static/manifest.json",
  "/static/tesseract/tesseract.min.js",
  "/static/tesseract/worker.min.js",
  "/static/tesseract/tesseract-core-simd.wasm.js",
  "/static/tessdata/chi_sim.traineddata.gz",
  "/static/icon-192.png",
  "/static/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API 走网络
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/images/")) return;
  // 静态资源：缓存优先，回源并更新缓存
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok && (e.request.method === "GET")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
