// Offline support: the app shell is cached; standings always try the network first.
const V = 'ga-league-v2';
const SHELL = ['./', 'index.html', 'logo.webp', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data.json') || url.pathname.endsWith('/lineup.json')) {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); const key = url.pathname.endsWith('/lineup.json') ? 'lineup.json' : 'data.json'; caches.open(V).then((ca) => ca.put(key, c)); return r; })
      .catch(() => caches.match(url.pathname.endsWith('/lineup.json') ? 'lineup.json' : 'data.json')));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
