const CACHE_NAME = "vozlectura-pwa-1.0.2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/i18n.js",
  "/app.js",
  "/manifest.json",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

function fetchWithTimeout(requestOrUrl, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const targetUrl = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url;
  return fetch(targetUrl, { cache: "no-cache", signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url, { cache: "reload" }).then((resp) => {
            if (resp && resp.ok) {
              return cache.put(url, resp);
            }
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  // No interceptar peticiones a dominios externos (Google Translate, MyMemory, DictionaryAPI, Wiktionary, etc.)
  // para evitar que la caché de recursos del EPUB (ignoreSearch) devuelva siempre la misma palabra traducida.
  if (url.origin !== self.location.origin) {
    return;
  }

  const isCoverOrAsset =
    url.pathname.includes("/api/books/") &&
    (url.pathname.endsWith("/cover") || url.pathname.includes("/assets/"));

  // No interceptar llamadas dinámicas de API (los libros y audios offline se gestionan en IndexedDB desde app.js)
  if (url.pathname.startsWith("/api/") && !isCoverOrAsset) {
    return;
  }

  const isAppShell =
    event.request.mode === "navigate" ||
    STATIC_ASSETS.includes(url.pathname);

  if (isAppShell) {
    // Estrategia Network-First con respaldo instantáneo en Caché (1.8 s):
    // Si el servidor está encendido, carga siempre al instante la última versión de index.html, styles.css y app.js
    // y actualiza la caché local. Si el servidor está apagado o sin cobertura, abre desde la memoria del teléfono.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const fresh = await fetchWithTimeout(event.request.url, 4500);
          if (fresh && fresh.status === 200) {
            cache.put(event.request, fresh.clone());
            if (STATIC_ASSETS.includes(url.pathname)) {
              cache.put(url.pathname, fresh.clone());
            }
            return fresh;
          }
        } catch (_) {}

        const cached =
          (await cache.match(event.request, { ignoreSearch: true })) ||
          (event.request.mode === "navigate"
            ? (await cache.match("/index.html", { ignoreSearch: true })) ||
              (await cache.match("/", { ignoreSearch: true }))
            : null);

        if (cached) {
          return cached;
        }

        return new Response(
          "VozLectura sin conexión (abre la app una vez con el Service Worker activo para guardarla en caché).",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      })()
    );
    return;
  }

  // Portadas e imágenes del EPUB: Cache-First con actualización rápida
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) {
        return cached;
      }
      try {
        const networkResp = await fetchWithTimeout(event.request, 2500);
        if (networkResp && networkResp.status === 200) {
          cache.put(event.request, networkResp.clone());
        }
        return networkResp;
      } catch (_) {
        return new Response("", { status: 404 });
      }
    })()
  );
});
