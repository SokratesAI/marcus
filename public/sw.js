const CACHE = 'marcus-shell-v3';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg'];

// A stalled connection neither resolves nor rejects, so a bare network-first
// fetch() can leave respondWith() pending for the browser's own socket timeout.
// Anything render-blocking behind that (the Google Fonts stylesheets, the
// Chart.js script tag) then holds the whole page, which reads as the app hanging.
const SAME_ORIGIN_TIMEOUT_MS = 3000;
const CROSS_ORIGIN_TIMEOUT_MS = 5000;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

function after(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// cache.put rejects on an opaque cross-origin response; a rejection here must
// never take the response down with it.
function stash(request, response) {
  return caches.open(CACHE).then((c) => c.put(request, response)).catch(() => {});
}

function fromNetwork(request) {
  return fetch(request).then((res) => {
    stash(request, res.clone());
    return res;
  });
}

// network-first so edits during development show up immediately, but bounded:
// same-origin falls back to the cached shell, cross-origin fails outright rather
// than blocking the page on an asset the app can render without.
function respond(request) {
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  const network = fromNetwork(request);
  // the rejection is handled below, but only once the cache lookup resolves --
  // mark it handled now so a fast failure does not fire unhandledrejection.
  network.catch(() => {});
  return caches.match(request).then((cached) => {
    const timeout = sameOrigin ? SAME_ORIGIN_TIMEOUT_MS : CROSS_ORIGIN_TIMEOUT_MS;
    const fallback = () => cached || new Response('', { status: 504, statusText: 'Offline or too slow' });
    return Promise.race([
      network.catch(fallback),
      after(timeout).then(fallback),
    ]);
  });
}

// The API is state, not shell. Caching a GET /api/state means a slow network
// hands back an old revision from the cache, and "Load the server copy" would
// then restore stale data over the live browser copy -- so it goes straight to
// the network and is never stashed.
function isApi(url) {
  const u = new URL(url);
  return u.origin === self.location.origin && u.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (isApi(e.request.url)) return;
  e.respondWith(respond(e.request));
});
