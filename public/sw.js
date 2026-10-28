const CACHE_NAME = 'creatine-pwa-v3';
const CONFIG_CACHE = 'creatine-config';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('creatine-pwa-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Network-first so updates to the app are picked up; cache is the offline fallback.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

async function readDosage() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const res = await cache.match('/__config');
    if (res) {
      const cfg = await res.json();
      if (cfg && cfg.dosage) return String(cfg.dosage);
    }
  } catch (err) {
    // fall through to the generic text
  }
  return null;
}

// A push from the server arrives here, even when the app is closed.
// iOS requires every push to show a notification, so this must always call showNotification.
self.addEventListener('push', (e) => {
  e.waitUntil(
    (async () => {
      const dosage = await readDosage();
      await self.registration.showNotification('Creatine Reminder 💪', {
        body: dosage ? `Time to take your ${dosage}g of creatine.` : 'Time to take your creatine.',
        tag: 'creatine-reminder',
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        data: { url: './index.html' }
      });
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
