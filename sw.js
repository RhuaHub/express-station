/* 驿站助手（重建版）· PWA 壳缓存
   缓存优先只用于带版本号的本地静态资源；版本号一变，旧缓存整体失效。 */
var VERSION = 'station-rebuild-v2';
var BUILD = '2.0.1';
var SHELL = [
  './',
  './index.html',
  './styles.css?v=' + BUILD,
  './rules.js?v=' + BUILD,
  './db.js?v=' + BUILD,
  './auth.js?v=' + BUILD,
  './media.js?v=' + BUILD,
  './app.js?v=' + BUILD,
  './manifest.webmanifest?v=' + BUILD,
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () { });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  /* 壳资源在 install 时已全部预缓存；运行时只做缓存优先，不再往缓存里塞未知资源 */
  e.respondWith(caches.match(e.request).then(function (hit) {
    return hit || fetch(e.request).catch(function () { return caches.match('./index.html'); });
  }));
});
