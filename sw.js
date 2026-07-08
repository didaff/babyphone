// Service worker : cache complet dès la première visite pour un
// fonctionnement 100% hors ligne ensuite.
//
// Stratégie de mise à jour explicite (pas de cache périmé silencieux) :
// - à chaque déploiement, incrémenter SW_VERSION ci-dessous ;
// - le nouveau SW s'installe et pré-cache la nouvelle version en arrière-plan
//   SANS prendre le contrôle immédiatement (pas de self.skipWaiting() ici) ;
// - la page affiche alors une bannière "nouvelle version disponible"
//   (app.js) ; ce n'est que si l'utilisateur clique "Mettre à jour" que la
//   page envoie {type:'SKIP_WAITING'} et que le nouveau SW prend le relais.
const SW_VERSION = 'v5';
const CACHE_NAME = 'babyphone-' + SW_VERSION;

const PRECACHE_URLS = [
  './',
  './index.html',
  './bebe.html',
  './parent.html',
  './aide.html',
  './manifest.json',
  './style.css',
  './app.js',
  './config.js',
  './qr-transport.js',
  './webrtc-pairing.js',
  './bebe.js',
  './parent.js',
  './pako.min.js',
  './qrcode.min.js',
  './jsQR.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Cache d'abord, réseau en secours (et mise en cache opportuniste de ce que
// le réseau renvoie) : priorité absolue au fonctionnement hors ligne.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
