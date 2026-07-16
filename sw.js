'use strict';

/* ポスティングマップ Service Worker
   - アプリシェル(HTML/CSS/JS/マニフェスト)のみをキャッシュする
   - 地図タイル(OpenStreetMap・国土地理院)は絶対にキャッシュしない
     -> 常に最新のタイルを取得し、キャッシュ容量の肥大化も防ぐ
*/

const CACHE_NAME = 'posting-map-shell-v5';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 地図タイルはキャッシュしない(常にネットワークから取得)
  if (url.hostname.endsWith('tile.openstreetmap.org') || url.hostname.endsWith('cyberjapandata.gsi.go.jp')) {
    return; // ブラウザの通常のfetchに任せる(SWで横取りしない)
  }

  // GET以外はそのまま
  if (event.request.method !== 'GET') return;

  // アプリシェル: キャッシュ優先、なければネットワーク取得しキャッシュへ追加
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          // 同一オリジンの静的ファイルのみキャッシュに追加(CDN等は都度取得)
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
