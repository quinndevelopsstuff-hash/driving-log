// v1.2.5 — increment this comment on every deploy to guarantee the browser detects a byte change
'use strict';

const CACHE_NAME = 'drive-log-v1';

const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png',
];

// Cache all assets on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  // Do NOT call skipWaiting() here — the app prompts the user before activating a new version
});

// Activate immediately when the app explicitly requests it (user clicked "Reload")
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Remove old caches on activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Open the app to the right section when a notification is tapped
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.action === 'daily-reminder' || event.notification.tag === 'daily-reminder')
    ? 'index.html#log'
    : 'index.html';
  event.waitUntil(clients.openWindow(url));
});

// Cache-first, fall back to network
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Refresh cache in background for next visit
        fetch(event.request).then(response => {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
