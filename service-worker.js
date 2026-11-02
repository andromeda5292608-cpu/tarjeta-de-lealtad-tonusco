'use strict';

const CACHE_NAME = 'club-tonusco-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-tonusco.svg', '/icon-tonusco-192.png', '/icon-tonusco-512.png', '/logo-tonusco.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('club-tonusco-shell-') && key !== CACHE_NAME)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  }).catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || caches.match('/index.html'))));
});
