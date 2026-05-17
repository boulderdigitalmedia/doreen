const CACHE = 'love-notes-v4';
const STATIC = ['manifest.json'];

// On install — only cache static assets, NOT index.html
self.addEventListener('install', e => {
  self.skipWaiting(); // activate immediately, don't wait
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC))
  );
});

// On activate — clear ALL old caches and take control immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control of all open tabs
  );
});

// Fetch strategy:
// - index.html → always network first, fall back to cache
// - photos → cache first (they never change)
// - everything else → network first
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always get index.html from network
  if (url.pathname === '/' || url.pathname.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Update cache with fresh version
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request)) // offline fallback
    );
    return;
  }

  // Photos — cache first (they don't change)
  if (url.pathname.includes('/photos/')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // Everything else — network first
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push notification received
self.addEventListener('push', e => {
  let data = { title: '💚 A note from Jake', body: "Open the app to read today's reason", url: '/' };
  if (e.data) {
    try { data = e.data.json(); } catch {}
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'love-note',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' }
    })
  );
});

// Tap notification → open app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(e.notification.data.url || '/');
    })
  );
});
