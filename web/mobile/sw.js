// App-shell cache for the field app. API calls are never cached here: the app keeps its own per-user work cache and
// offline queue, so a stale API response can never be mistaken for live data.
const CACHE='mouldcare-field-v6',SHELL=['/mobile/','/mobile/index.html','/mobile/app.js','/mobile/style.css','/mobile/icon-192.png','/mobile/icon-512.png','/mobile/manifest.webmanifest','/shared/i18n.js','/shared/signature.js'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
// Network first for the shell so updates arrive when online; the cache answers when the network does not.
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin!==location.origin||event.request.method!=='GET'||!(url.pathname.startsWith('/mobile/')||url.pathname.startsWith('/shared/')))return;event.respondWith(fetch(event.request).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy))}return res}).catch(()=>caches.match(event.request)));});
