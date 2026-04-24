// ═══════════════════════════════════════════════════════════
// H.O.M.T — Service Worker v2.0
// Room_Defect.html — Lotus Garden Hotel by Waringinhospitality
//
// STRATEGI CACHE:
//   - App shell (HTML)        → Cache First + background update
//   - Font Google             → Cache First (stale-while-revalidate)
//   - GAS / Firestore API     → Network First + offline fallback
//   - Foto (Drive proxy)      → Cache First (24 jam TTL)
//   - QR / external           → Network only, gagal silent
// ═══════════════════════════════════════════════════════════

const APP_VERSION   = 'homt-v2.0';
const FONT_CACHE    = 'homt-fonts-v1';
const PHOTO_CACHE   = 'homt-photos-v1';
const PHOTO_TTL_MS  = 24 * 60 * 60 * 1000; // 24 jam

// File yang di-precache saat install (app shell)
const PRECACHE_URLS = [
  '/Room_Defect.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── INSTALL: precache app shell ─────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS.filter(u => {
        // Jangan crash jika icon belum ada
        return !u.includes('icon');
      })))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.warn('[SW] Precache partial fail:', err);
        return self.skipWaiting();
      })
  );
});

// ── ACTIVATE: hapus cache lama ──────────────────────────────
self.addEventListener('activate', event => {
  const KEEP = [APP_VERSION, FONT_CACHE, PHOTO_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !KEEP.includes(k)).map(k => {
          console.log('[SW] Hapus cache lama:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: routing strategy ─────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;

  // Abaikan non-GET
  if (req.method !== 'GET') return;

  // 1. GAS (Google Apps Script) → Network First, offline fallback JSON
  if (url.includes('script.google.com')) {
    event.respondWith(networkFirstJSON(req));
    return;
  }

  // 2. Firestore REST API → Network First, offline fallback JSON
  if (url.includes('firestore.googleapis.com') || url.includes('firebase.googleapis.com')) {
    event.respondWith(networkFirstJSON(req));
    return;
  }

  // 3. WhatsApp API (Fonnte) → Network only, gagal silent
  if (url.includes('fonnte.com') || url.includes('api.whatsapp')) {
    event.respondWith(
      fetch(req).catch(() => new Response('{}', {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // 4. Google Drive foto proxy → Cache First + TTL 24 jam
  if (url.includes('drive.google.com') || url.includes('lh3.googleusercontent.com')) {
    event.respondWith(cacheFirstWithTTL(req, PHOTO_CACHE, PHOTO_TTL_MS));
    return;
  }

  // 5. Google Fonts → Cache First (stale-while-revalidate)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // 6. CDN (jsPDF, dll) → Cache First
  if (url.includes('cdnjs.cloudflare.com') || url.includes('cdn.')) {
    event.respondWith(cacheFirst(req, APP_VERSION));
    return;
  }

  // 7. App shell (HTML + aset lokal) → Cache First + background update
  if (url.includes('Room_Defect.html') || url.includes('manifest.json') ||
      url.includes('icon-') || url.includes('favicon')) {
    event.respondWith(cacheFirstWithRevalidate(req));
    return;
  }

  // 8. Semua lainnya → Network First
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && res.status < 400) {
          const clone = res.clone();
          caches.open(APP_VERSION).then(c => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached ||
        new Response('Offline', { status: 503 })
      ))
  );
});

// ══════════════════════════════════════════════════
// HELPER STRATEGIES
// ══════════════════════════════════════════════════

/** Network First — fallback ke cache, fallback ke JSON error */
async function networkFirstJSON(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ success: false, error: 'Offline — tidak ada koneksi internet', offline: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/** Cache First — ambil dari cache, fetch jika miss */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    return new Response('Offline', { status: 503 });
  }
}

/** Cache First dengan TTL — untuk foto */
async function cacheFirstWithTTL(req, cacheName, ttlMs) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  if (cached) {
    const date = cached.headers.get('sw-cached-at');
    const age  = date ? Date.now() - new Date(date).getTime() : 0;
    if (!date || age < ttlMs) return cached;
    // Expired — hapus dan fetch ulang di background
    cache.delete(req);
  }

  try {
    const res = await fetch(req);
    if (res.ok) {
      // Tambah header timestamp
      const headers = new Headers(res.headers);
      headers.set('sw-cached-at', new Date().toISOString());
      const resWithTs = new Response(await res.blob(), { status: res.status, headers });
      cache.put(req, resWithTs.clone());
      return resWithTs;
    }
    return res;
  } catch (err) {
    return cached || new Response('', { status: 503 });
  }
}

/** Cache First + background revalidate (stale-while-revalidate) */
async function cacheFirstWithRevalidate(req) {
  const cache  = await caches.open(APP_VERSION);
  const cached = await cache.match(req);

  // Revalidate di background
  const fetchPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  return cached || await fetchPromise || new Response('Offline', { status: 503 });
}

// ── Push notification handler (opsional — untuk Firebase Cloud Messaging) ──
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'H.O.M.T', {
        body:    data.body    || '',
        icon:    '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     data.tag     || 'homt-notif',
        data:    { url: data.url || '/Room_Defect.html' },
        actions: [
          { action: 'open', title: 'Buka App' },
          { action: 'dismiss', title: 'Tutup' },
        ],
      })
    );
  } catch (e) { console.warn('[SW] Push parse error:', e); }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/Room_Defect.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('Room_Defect'));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
