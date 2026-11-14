/* Service Worker：应用外壳离线缓存。
   只缓存本站 GET 静态资源，绝不拦截云盘上传、GitHub 同步等跨域请求。 */
'use strict';

var VERSION = 'station-shell-v2';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
  './auth.js',
  './photos.js',
  './camera.js',
  './sync.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // 单个资源失败不应让整次安装失败
      return Promise.all(SHELL.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  // 只接管同源静态资源，跨域（云盘 / GitHub API）一律直连
  if (url.origin !== self.location.origin) return;

  // 页面导航：先走网络拿最新版，失败再回落到缓存的外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  e.respondWith(
    caches.open(VERSION).then(function (c) {
      return c.match(req).then(function (hit) {
        var fetching = fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') c.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || fetching;
      });
    })
  );
});
