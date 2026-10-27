// To publish a new version: change VERSION, then redeploy. The page shows this number.
const VERSION = '1';
const CACHE = `proto-offline-v${VERSION}`;
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'db.js', 'auth.js', 'sync.js', 'config.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache so a new version never precaches stale files.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  // No skipWaiting here: the page shows the update banner and the user decides.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'version') event.source.postMessage({ version: VERSION });
});

// App shell is cache-first. Supabase (another origin) is never intercepted.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true }) ?? (req.mode === 'navigate' && await cache.match('index.html'));
    return hit || fetch(req);
  })());
});
