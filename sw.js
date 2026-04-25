// ═══════════════════════════════════════════════════════════
// H.O.M.T — Service Worker v2.1
// ── PENTING: Update APP_VERSION setiap kali deploy file baru
//    Ini yang memaksa browser hapus cache lama dan ambil fresh
// ═══════════════════════════════════════════════════════════

const APP_VERSION  = 'homt-v2.2';   // ← UPDATE INI setiap deploy
const FONT_CACHE   = 'homt-fonts-v1';
const PHOTO_CACHE  = 'homt-photos-v1';
const PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

// App shell — JANGAN cache Room_Defect.html di sini
// Biarkan HTML selalu fresh dari network agar perubahan login/role langsung terasa
const PRECACHE_URLS = [
  'manifest.json',
  'firebase-init.js',
];

// ── INSTALL ─────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing:', APP_VERSION);
  event.waitUntil(
    caches.open(APP_VERSION)
      .then(cache => {
        // Precache file statis yang jarang berubah
        return Promise.allSettled(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(e => console.warn('[SW] Precache skip:', url, e.message))
          )
        );
      })
      .then(() => {
        console.log('[SW] Installed:', APP_VERSION);
        return self.skipWaiting(); // Langsung aktif tanpa tunggu tab lama tutup
      })
  );
});

// ── ACTIVATE ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const KEEP = [APP_VERSION, FONT_CACHE, PHOTO_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !KEEP.includes(k))
          .map(k => {
            console.log('[SW] Hapus cache lama:', k);
            return caches.delete(k);
          })
      ))
      .then(() => {
        console.log('[SW] Activated:', APP_VERSION);
        return self.clients.claim(); // Ambil kontrol semua tab langsung
      })
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;

  // Abaikan non-GET dan chrome-extension
  if (req.method !== 'GET') return;
  if (url.startsWith('chrome-extension://')) return;
  if (url.startsWith('moz-extension://')) return;

  // 1. Room_Defect.html → SELALU Network First (jangan cache HTML)
  //    Ini kunci agar perubahan login/role langsung terasa tanpa clear cache
  if (url.includes('Room_Defect.html') || url.endsWith('/') && !url.includes('.')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            // Update cache di background tapi JANGAN serve dari cache untuk HTML
            const clone = res.clone();
            caches.open(APP_VERSION).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          // Offline fallback — ambil dari cache
          caches.match(req).then(cached =>
            cached || new Response(
              '<h1>H.O.M.T Offline</h1><p>Sambungkan ke internet lalu refresh.</p>',
              { headers: { 'Content-Type': 'text/html' }, status: 503 }
            )
          )
        )
    );
    return;
  }

  // 2. GAS (Google Apps Script) → Network First, offline fallback JSON
  if (url.includes('script.google.com')) {
    event.respondWith(networkFirstJSON(req));
    return;
  }

  // 3. Firestore → Network First, offline fallback JSON
  if (url.includes('firestore.googleapis.com') || url.includes('firebase.googleapis.com')) {
    event.respondWith(networkFirstJSON(req));
    return;
  }

  // 4. Fonnte WA API → Network only, gagal silent
  if (url.includes('fonnte.com') || url.includes('api.whatsapp')) {
    event.respondWith(
      fetch(req).catch(() => new Response('{}', {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // 5. Google Drive foto → Cache First + TTL 24 jam
  if (url.includes('drive.google.com') || url.includes('lh3.googleusercontent.com')) {
    event.respondWith(cacheFirstWithTTL(req, PHOTO_CACHE, PHOTO_TTL_MS));
    return;
  }

  // 6. Google Fonts → Cache First (stale-while-revalidate)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // 7. CDN (jsPDF, SheetJS, dll) → Cache First
  if (url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirst(req, APP_VERSION));
    return;
  }

  // 8. Icon, manifest → Cache First + background update
  if (url.includes('icon-') || url.includes('manifest.json') || url.includes('favicon')) {
    event.respondWith(cacheFirstWithRevalidate(req));
    return;
  }

  // 9. Semua lainnya → Network First dengan fallback cache
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          caches.open(APP_VERSION).then(c => c.put(req, res.clone()));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(c => c || new Response('Offline', { status: 503 }))
      )
  );
});

// ══════════════════════════════════════════════════
// STRATEGIES
// ══════════════════════════════════════════════════

async function networkFirstJSON(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ success: false, error: 'Offline', offline: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) caches.open(cacheName).then(c => c.put(req, res.clone()));
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function cacheFirstWithTTL(req, cacheName, ttlMs) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    const age = Date.now() - new Date(cached.headers.get('sw-cached-at') || 0).getTime();
    if (age < ttlMs) return cached;
    cache.delete(req);
  }
  try {
    const res = await fetch(req);
    if (res.ok) {
      const h = new Headers(res.headers);
      h.set('sw-cached-at', new Date().toISOString());
      const r = new Response(await res.blob(), { status: res.status, headers: h });
      cache.put(req, r.clone());
      return r;
    }
    return res;
  } catch {
    return cached || new Response('', { status: 503 });
  }
}

async function cacheFirstWithRevalidate(req) {
  const cache  = await caches.open(APP_VERSION);
  const cached = await cache.match(req);
  fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
  return cached || fetch(req);
}

// ── Push Notification ────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const d = event.data.json();
    event.waitUntil(
      self.registration.showNotification(d.title || 'H.O.M.T', {
        body:    d.body    || '',
        icon:    'icon-192.png',
        badge:   'icon-192.png',
        tag:     d.tag     || 'homt',
        data:    { url: d.url || 'Room_Defect.html' },
        actions: [
          { action: 'open',    title: 'Buka' },
          { action: 'dismiss', title: 'Tutup' },
        ],
      })
    );
  } catch(e) { console.warn('[SW] Push error:', e); }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || 'Room_Defect.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('Room_Defect'));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});

// ── Message handler — force update dari app ─────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => event.source?.postMessage({ type: 'CACHE_CLEARED' }));
  }
});
