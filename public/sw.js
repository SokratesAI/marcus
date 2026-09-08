const CACHE = 'marcus-shell-v5';
const SHELL = ['./', './index.html', './styles.css', './app-core.js', './app.js', './manifest.json', './icon.svg', './apple-touch-icon.png'];

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

// ---------- push notifications (issue #154) ----------
// The server sends one Declarative Web Push body:
// {"web_push":8030,"notification":{title, body, navigate, tag}}. Safari 18.4+
// renders that itself and never dispatches this event, which is why the whole
// feature was built and shipped without a push handler here.
//
// Every other browser does the opposite. Chrome and Samsung Internet on Android
// deliver the payload to this worker and show NOTHING unless showNotification()
// is called before the event settles -- so a notification the server encrypted,
// the push service accepted and the phone received was dropped on the floor,
// silently, on the one device Edvard actually reads Marcus on. The declarative
// JSON is parsed here as well: one payload on the wire, two renderers.
function pushNotification(data) {
  let body = null;
  try {
    body = data && typeof data.json === 'function' ? data.json() : null;
  } catch {
    // A payload this worker cannot parse still has to become a notification.
    // Silence is the failure this handler exists to end.
    body = null;
  }
  const n = (body && typeof body === 'object' && body.notification) || {};
  const title = typeof n.title === 'string' && n.title ? n.title : 'Marcus';
  const navigate = typeof n.navigate === 'string' && n.navigate ? n.navigate : './';
  return {
    title,
    options: {
      body: typeof n.body === 'string' ? n.body : '',
      // The server picks the tag so a second send replaces the first on the
      // lock screen instead of stacking; falling back to one shared tag keeps
      // that true for a payload that carried none.
      tag: typeof n.tag === 'string' && n.tag ? n.tag : 'marcus',
      icon: './apple-touch-icon.png',
      data: { navigate },
    },
  };
}

self.addEventListener('push', (e) => {
  const n = pushNotification(e.data);
  e.waitUntil(self.registration.showNotification(n.title, n.options));
});

// A notification that cannot be tapped back into the app is half a
// notification. An already-open Marcus is focused rather than opened a second
// time -- an installed PWA that spawns a duplicate window on every tap is the
// thing that makes people turn reminders off again.
self.addEventListener('notificationclick', (e) => {
  if (e.notification && typeof e.notification.close === 'function') e.notification.close();
  const data = (e.notification && e.notification.data) || {};
  const target = typeof data.navigate === 'string' && data.navigate ? data.navigate : './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (typeof client.focus === 'function') return client.focus();
      }
      return typeof self.clients.openWindow === 'function' ? self.clients.openWindow(target) : undefined;
    })
  );
});
