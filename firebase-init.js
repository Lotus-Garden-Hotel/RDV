// ═══════════════════════════════════════════════════════════
// H.O.M.T — Firebase Hybrid Bridge v2.0
// File: firebase-init.js
//
// FIX v2.0:
//   - Anonymous Auth sebelum akses Firestore
//   - Fix enableMultiTabIndexedDbPersistence deprecated
//   - Fallback ke GAS jika Firebase error (silent)
//   - onSnapshot dengan retry logic
// ═══════════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey:            "AIzaSyBshlCYJdW85bWjZfNYQw6Ap_OgQIvhEBA",
  authDomain:        "homt-lotusgarden.firebaseapp.com",
  projectId:         "homt-lotusgarden",
  storageBucket:     "homt-lotusgarden.firebasestorage.app",
  messagingSenderId: "904545057231",
  appId:             "1:904545057231:web:025c9e67fd2923e2157aba"
};

// Track listener agar bisa di-unsubscribe
let _unsubscribeListener = null;
let _firebaseReady       = false;

// ══════════════════════════════════════════════════════════
// MAIN INIT
// ══════════════════════════════════════════════════════════
async function initFirebaseHybrid() {
  try {
    // Load SDK — urutan penting: app → auth → firestore
    await _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
    await _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js');
    await _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js');

    // Init Firebase app
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    const auth = firebase.auth();
    const db   = firebase.firestore();

    // ── Fix deprecated API — gunakan settings baru ──
    db.settings({
      cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED,
      experimentalForceLongPolling: false,
    });

    // ── Enable offline persistence dengan API yang benar ──
    try {
      await db.enablePersistence({ synchronizeTabs: true });
      console.log('[Firebase] Offline persistence aktif ✅');
    } catch(err) {
      if (err.code === 'failed-precondition') {
        console.warn('[Firebase] Multi-tab — persistence di satu tab saja');
      } else if (err.code === 'unimplemented') {
        console.warn('[Firebase] Browser tidak support offline persistence');
      }
      // Tidak fatal — lanjut tanpa persistence
    }

    // ── Anonymous Sign-In ──────────────────────────────────
    // H.O.M.T pakai custom login (nama+role via GAS), bukan Firebase Auth.
    // Kita pakai Anonymous Auth agar Security Rules bisa verifikasi
    // request.auth != null tanpa paksa user login ulang ke Google.
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        await auth.signInAnonymously();
        console.log('[Firebase] Anonymous auth OK ✅');
      } else {
        console.log('[Firebase] Auth sudah ada:', currentUser.uid.substring(0,8)+'...');
      }
    } catch(authErr) {
      // Jika Anonymous Auth tidak diaktifkan di Firebase Console
      console.warn('[Firebase] Anonymous auth gagal:', authErr.message);
      console.warn('[Firebase] → Aktifkan Anonymous Auth di Firebase Console → Authentication → Sign-in method');
      // Fallback: lanjut tanpa Firebase, pakai GAS saja
      window.FIREBASE_ENABLED = false;
      return;
    }

    window._HOMT_DB   = db;
    window._HOMT_AUTH = auth;
    _firebaseReady = true;

    console.log('[Firebase] Hybrid mode aktif ✅');

    // Patch gasCall untuk baca dari Firestore
    _patchGasCallForFirestore(db);

    // Start real-time listener
    _startRealtimeListeners(db);

  } catch(e) {
    console.error('[Firebase] Init gagal, gunakan GAS only:', e.message);
    window.FIREBASE_ENABLED = false;
  }
}

// ══════════════════════════════════════════════════════════
// PATCH gasCall
// ══════════════════════════════════════════════════════════
function _patchGasCallForFirestore(db) {
  const _orig = window.gasCall;
  if (!_orig) { console.warn('[Firebase] gasCall tidak ditemukan'); return; }

  window.gasCall = async function(action, payload) {

    // ── READ: ambil dari Firestore ──
    if (action === 'getDefects') {
      try {
        const snap = await db.collection('tickets')
          .where('Status', '!=', 'DELETED')
          .orderBy('Status')
          .orderBy('CreatedAt', 'desc')
          .limit(300)
          .get();

        if (!snap.empty) {
          console.log('[Firebase] getDefects dari Firestore:', snap.size, 'dokumen');
          return snap.docs.map(d => ({ ID: d.id, ...d.data() }));
        }
        // Kosong — fallback ke GAS (mungkin belum migrasi)
        console.log('[Firebase] Firestore kosong, fallback ke GAS');
      } catch(e) {
        console.warn('[Firebase] getDefects fallback ke GAS:', e.message);
      }
      return _orig(action, payload);
    }

    if (action === 'getProjects') {
      try {
        const snap = await db.collection('projects')
          .where('Status', '!=', 'DELETED')
          .orderBy('Status')
          .get();

        if (!snap.empty) {
          const projects = snap.docs.map(d => ({ ProjectID: d.id, ...d.data(), _tasks: [] }));

          // Fetch tasks
          const taskSnap = await db.collection('projectTasks').get();
          const taskMap  = {};
          taskSnap.forEach(t => {
            const td = t.data();
            if (!taskMap[td.ProjectID]) taskMap[td.ProjectID] = [];
            taskMap[td.ProjectID].push({ TaskID: t.id, ...td });
          });
          projects.forEach(p => {
            p._tasks = (taskMap[p.ProjectID] || [])
              .sort((a,b) => (a.Order||0) - (b.Order||0));
          });

          console.log('[Firebase] getProjects dari Firestore:', projects.length);
          return projects;
        }
      } catch(e) {
        console.warn('[Firebase] getProjects fallback ke GAS:', e.message);
      }
      return _orig(action, payload);
    }

    // ── WRITE: tetap ke GAS + sync background ke Firestore ──
    const result = await _orig(action, payload);
    if (result && !result.error) {
      _syncToFirestore(action, payload, result, db).catch(e =>
        console.warn('[Firebase] Sync gagal (non-critical):', action, e.message)
      );
    }
    return result;
  };

  console.log('[Firebase] gasCall patched ✅');
}

// ══════════════════════════════════════════════════════════
// SYNC BACKGROUND ke Firestore setelah GAS berhasil
// ══════════════════════════════════════════════════════════
async function _syncToFirestore(action, payload, result, db) {
  const now = new Date().toISOString();

  switch(action) {
    case 'addDefect':
      if (!result.id) break;
      await db.collection('tickets').doc(result.id).set({
        ...payload, ID: result.id,
        Status: 'OPEN', CreatedAt: now, UpdatedAt: now,
        _syncedAt: now, _source: 'GAS',
      });
      break;

    case 'updateDefect':
      if (!payload.id) break;
      const upd = { UpdatedAt: now, _syncedAt: now };
      if (payload.status)        upd.Status        = payload.status;
      if (payload.engineer)      upd.Engineer      = payload.engineer;
      if (payload.linkedProject) upd.LinkedProject = payload.linkedProject;
      if (payload.startedBy)     upd.StartedBy     = payload.startedBy;
      if (payload.resolvedBy)    upd.ResolvedBy    = payload.resolvedBy;
      if (payload.closedBy)      upd.ClosedBy      = payload.closedBy;
      if (payload.notes)         upd.Notes         = payload.notes;
      await db.collection('tickets').doc(payload.id).update(upd);
      break;

    case 'addProject':
      if (!result.id) break;
      await db.collection('projects').doc(result.id).set({
        ...payload, ProjectID: result.id,
        Status: 'PLANNING', CreatedAt: now, UpdatedAt: now,
        _syncedAt: now, _source: 'GAS',
      });
      break;

    case 'updateProject':
      if (!payload.id) break;
      const projUpd = { UpdatedAt: now, _syncedAt: now };
      ['title','description','department','location','priority','status',
       'targetDate','notes','vendorName','vendorPic','vendorSpk','vendorCost']
      .forEach(k => {
        if (payload[k] !== undefined) {
          projUpd[k.charAt(0).toUpperCase()+k.slice(1)] = payload[k];
        }
      });
      await db.collection('projects').doc(payload.id).update(projUpd);
      break;

    case 'deleteProject':
      if (!payload.id) break;
      await db.collection('projects').doc(payload.id).update({
        Status: 'DELETED', UpdatedAt: now, _syncedAt: now,
      });
      break;
  }
}

// ══════════════════════════════════════════════════════════
// REAL-TIME LISTENER dengan retry
// ══════════════════════════════════════════════════════════
function _startRealtimeListeners(db) {
  // Unsubscribe listener lama jika ada
  if (_unsubscribeListener) {
    _unsubscribeListener();
    _unsubscribeListener = null;
  }

  let retryCount = 0;
  const MAX_RETRY = 3;

  function subscribe() {
    _unsubscribeListener = db.collection('tickets')
      .where('Status', 'in', ['OPEN', 'IN_PROGRESS', 'WAITING_MATERIAL'])
      .onSnapshot(
        snap => {
          retryCount = 0; // reset on success
          if (!window.STATE || !snap) return;

          let changed = false;
          snap.docChanges().forEach(change => {
            const data = { ID: change.doc.id, ...change.doc.data() };
            if (change.type === 'added' || change.type === 'modified') {
              const idx = STATE.defects?.findIndex(d => d.id === data.ID);
              if (idx >= 0) {
                STATE.defects[idx] = _firestoreToDefect(data);
                changed = true;
              } else if (change.type === 'added' && STATE.defects) {
                STATE.defects.unshift(_firestoreToDefect(data));
                changed = true;
              }
            } else if (change.type === 'removed') {
              if (STATE.defects) {
                STATE.defects = STATE.defects.filter(d => d.id !== data.ID);
                changed = true;
              }
            }
          });

          if (changed) {
            const dashPage = document.getElementById('page-dashboard');
            if (dashPage && dashPage.style.display !== 'none') {
              if (typeof renderDashboard === 'function') renderDashboard();
            }
            console.log('[Firebase] Real-time update:', snap.docChanges().length, 'changes');
          }
        },
        err => {
          console.warn('[Firebase] Listener error:', err.message);
          // Retry dengan exponential backoff
          if (retryCount < MAX_RETRY) {
            retryCount++;
            const delay = Math.pow(2, retryCount) * 1000;
            console.log(`[Firebase] Retry listener dalam ${delay/1000}s...`);
            setTimeout(subscribe, delay);
          } else {
            console.warn('[Firebase] Listener gagal setelah', MAX_RETRY, 'retry — gunakan GAS polling');
          }
        }
      );
  }

  subscribe();
}

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
function _firestoreToDefect(d) {
  return {
    id:            d.ID            || d.id            || '',
    room:          d.RoomNumber    || '',
    category:      d.Category      || '',
    desc:          d.Description   || '',
    priority:      d.Priority      || 'MEDIUM',
    status:        d.Status        || 'OPEN',
    reporter:      d.Reporter      || '',
    engineer:      d.Engineer      || '',
    notes:         d.Notes         || '',
    createdAt:     d.CreatedAt     ? new Date(d.CreatedAt).getTime()  : 0,
    startedAt:     d.StartedAt     ? new Date(d.StartedAt).getTime()  : 0,
    resolvedAt:    d.ResolvedAt    ? new Date(d.ResolvedAt).getTime() : 0,
    closedAt:      d.ClosedAt      ? new Date(d.ClosedAt).getTime()   : 0,
    startedBy:     d.StartedBy     || '',
    resolvedBy:    d.ResolvedBy    || '',
    closedBy:      d.ClosedBy      || '',
    linkedProject: d.LinkedProject || '',
    photoBefore:   d.PhotoBefore   || '',
    photoAfter:    d.PhotoAfter    || '',
    areaType:      d.AreaType      || 'ROOM',
    urgencyScore:  Number(d.UrgencyScore || 0),
    slaPausedMin:  Number(d.SLAPausedMin || 0),
    materialNote:  d.MaterialNote  || '',
    waitDurationLabel:   d.WaitDurationLabel   || '',
    repairDurationLabel: d.RepairDurationLabel || '',
    totalDurationLabel:  d.TotalDurationLabel  || '',
    assignedTo:    d.AssignedTo    || '',
  };
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s   = document.createElement('script');
    s.src     = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('Gagal load: ' + src));
    document.head.appendChild(s);
  });
}
