/* Contrail — service worker : coquille hors-ligne, cache API/médias, cible de partage */
const VERSION = 'contrail-v1.0.0';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const MEDIA = 'contrail-media';
const TILES = 'contrail-tiles';
const SHARE = 'contrail-share';

const VIEWS = ['dashboard', 'spots', 'spot-form', 'spot-detail', 'airframe', 'flights', 'flight-form', 'fleets', 'fleet-detail',
  'liveries', 'stats', 'locations', 'radar', 'watchlist', 'achievements', 'story', 'shares', 'settings', 'drafts', 'more', 'public'];
const PRECACHE = [
  '/', '/manifest.webmanifest', '/static/css/app.css', '/static/vendor/leaflet/leaflet.css', '/static/vendor/leaflet/leaflet.js',
  '/static/icons/icon.svg', '/static/icons/icon-192.png',
  '/static/js/app.js', '/static/js/api.js', '/static/js/i18n.js', '/static/js/ui.js', '/static/js/offline.js',
  '/static/js/lib/icons.js', '/static/js/lib/map.js', '/static/js/lib/fields.js',
  ...VIEWS.map((v) => `/static/js/views/${v}.js`),
  '/static/i18n/fr.json', '/static/i18n/en.json', '/static/i18n/es.json', '/static/i18n/ja.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('contrail-v') && !k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

async function networkFirstApi(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-contrail-cache', 'offline');
      return new Response(await hit.blob(), { status: 200, headers });
    }
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

async function cacheFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); trim(cacheName, max); }
  return res;
}

async function handleShareTarget(req) {
  const form = await req.formData();
  const file = form.get('image');
  if (file && file.size) {
    const c = await caches.open(SHARE);
    await c.put('/shared-image', new Response(file, { headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name || 'photo.jpg') } }));
  }
  return Response.redirect('/#/spots/new?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/share-target') { e.respondWith(handleShareTarget(req)); return; }
  if (req.method !== 'GET') return;

  if (url.hostname.endsWith('tile.openstreetmap.org')) { e.respondWith(cacheFirst(req, TILES, 1500).catch(() => new Response('', { status: 504 }))); return; }
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/static/')) { e.respondWith(staleWhileRevalidate(req)); return; }
  if (url.pathname.startsWith('/media/thumbs/') || url.pathname.startsWith('/media/images/')) { e.respondWith(cacheFirst(req, MEDIA, 600)); return; }
  if (url.pathname.startsWith('/api/')) {
    const live = ['/api/radar', '/api/notifications', '/api/auth', '/api/public', '/api/backups', '/api/export', '/api/lookup', '/api/watchlist/check'];
    if (live.some((p) => url.pathname.startsWith(p))) return;
    e.respondWith(networkFirstApi(req));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = e.notification.data?.link || '#/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { await c.focus(); c.navigate(`/${link}`); return; }
    await self.clients.openWindow(`/${link}`);
  })());
});
