// cc-deck service worker — instant loads, an offline app shell, and reliable
// updates (esp. for iOS home-screen apps that otherwise pin a stale bundle).
//
// BUILD is stamped by esbuild on every `npm run build`, so each deploy ships a
// byte-different worker → the browser installs it and we can prompt to reload.
const BUILD = '__BUILD__';
const CACHE = `ccdeck-${BUILD}`;

// App shell precached on install so the UI boots instantly and works offline
// (the live terminal still needs the network, but the app loads either way).
const SHELL = [
  '/', '/index.html', '/terminal.html', '/login.html',
  '/dashboard.js', '/terminal.js', '/xterm.css', '/login.css',
  '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // cache:'reload' bypasses the HTTP cache so we precache truly fresh files.
      c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))).catch(() => {})),
  );
  // Don't skipWaiting automatically — wait until the user clicks "Reload" so we
  // never swap code out from under an active terminal session.
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isBundle = (p) => p === '/dashboard.js' || p === '/terminal.js';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept live data, the version probe, or websockets.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // HTML navigations + JS bundles: network-first, so a reload ALWAYS lands the
  // newest build; fall back to cache only when offline.
  if (req.mode === 'navigate' || isBundle(url.pathname)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match('/index.html'));
      }
    })());
    return;
  }

  // Everything else (icons, css, source maps): stale-while-revalidate — serve
  // cached instantly, refresh in the background.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});

// The page asks us to activate a freshly-installed worker when the user reloads.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
