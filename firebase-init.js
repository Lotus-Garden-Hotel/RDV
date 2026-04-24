// ═══════════════════════════════════════════════════════════
// H.O.M.T — Firebase Hybrid Bridge v1.0
// File: firebase-init.js
//
// CARA KERJA (Hybrid Mode):
//   - GAS tetap jadi PRIMARY untuk semua write operasi
//     (validasi, notif WA, foto Drive, audit log)
//   - Firestore jadi SECONDARY untuk:
//     * Real-time read (onSnapshot) menggantikan polling
//     * Cache offline (IndexedDB built-in Firestore)
//     * Sync balik dari Firestore ke Sheets via GAS trigger
//
// AKTIFKAN:
//   1. Isi firebaseConfig di bawah dengan nilai dari Firebase Console
//   2. Di Room_Defect.html set: window.FIREBASE_ENABLED = true
//   3. Upload firebase-init.js ke GitHub bersama Room_Defect.html
// ═══════════════════════════════════════════════════════════

// ── Firebase Config — GANTI dengan nilai dari Firebase Console ──
const firebaseConfig = {
  apiKey: "AIzaSyBshlCYJdW85bWjZfNYQw6Ap_OgQIvhEBA",
  authDomain: "homt-lotusgarden.firebaseapp.com",
  projectId: "homt-lotusgarden",
  storageBucket: "homt-lotusgarden.firebasestorage.app",
  messagingSenderId: "904545057231",
  appId: "1:904545057231:web:025c9e67fd2923e2157aba"
};
// ══════════════════════════════════════════════════════════
// MAIN INIT — dipanggil dari Room_Defect.html jika FIREBASE_ENABLED = true
// ══════════════════════════════════════════════════════════
async function initFirebaseHybrid() {
  // Load Firebase SDK dinamis (tidak bundled di HTML agar ringan)
  await _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  await _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js');
  await _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js');

  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    // Aktifkan offline persistence (IndexedDB)
    await firebase.firestore().enablePersistence({ synchronizeTabs: true })
      .catch(err => {
        if (err.code === 'failed-precondition') console.warn('[Firebase] Multi-tab — persistence disabled');
        else if (err.code === 'unimplemented')  console.warn('[Firebase] Browser tidak support IndexedDB');
      });

    const db = firebase.firestore();
    window._HOMT_DB = db;

    console.log('[Firebase] Hybrid mode aktif ✅');

    // Override gasCall untuk tickets — baca dari Firestore, write tetap ke GAS
    _patchGasCallForFirestore(db);

    // Mulai real-time listeners
    _startRealtimeListeners(db);

  } catch (e) {
    console.error('[Firebase] Init gagal, fallback ke GAS only:', e);
    window.FIREBASE_ENABLED = false;
  }
}

// ══════════════════════════════════════════════════════════
// PATCH gasCall — tetap gunakan GAS untuk WRITE
// ══════════════════════════════════════════════════════════
function _patchGasCallForFirestore(db) {
  // Simpan gasCall asli
  const _origGasCall = window.gasCall;

  window.gasCall = async function(action, payload) {

    // ── READ actions → baca dari Firestore (lebih cepat, offline-capable) ──
    if (action === 'getDefects') {
      try {
        const snap = await db.collection('tickets')
          .where('Status', '!=', 'DELETED')
          .orderBy('Status')
          .orderBy('CreatedAt', 'desc')
          .limit(200)
          .get();

        if (!snap.empty) {
          return snap.docs.map(d => ({ ID: d.id, ...d.data() }));
        }
      } catch (e) {
        console.warn('[Firebase] getDefects fallback ke GAS:', e.message);
      }
      return _origGasCall(action, payload);
    }

    if (action === 'getProjects') {
      try {
        const snap = await db.collection('projects')
          .where('Status', '!=', 'DELETED')
          .get();
        if (!snap.empty) {
          // Fetch tasks per project
          const projects = snap.docs.map(d => ({ ProjectID: d.id, ...d.data(), _tasks: [] }));
          const taskSnap = await db.collection('projectTasks').get();
          const taskMap  = {};
          taskSnap.forEach(t => {
            const d = t.data();
            if (!taskMap[d.ProjectID]) taskMap[d.ProjectID] = [];
            taskMap[d.ProjectID].push({ TaskID: t.id, ...d });
          });
          projects.forEach(p => { p._tasks = (taskMap[p.ProjectID] || []).sort((a,b) => (a.Order||0)-(b.Order||0)); });
          return projects;
        }
      } catch (e) {
        console.warn('[Firebase] getProjects fallback ke GAS:', e.message);
      }
      return _origGasCall(action, payload);
    }

    // ── WRITE actions → tetap ke GAS + sync ke Firestore ──
    // GAS yang jadi source of truth untuk write:
    // validasi, notif WA, foto Drive, audit log semua ada di GAS
    const result = await _origGasCall(action, payload);

    // Setelah GAS berhasil, sync ke Firestore di background
    if (result && !result.error) {
      _syncToFirestoreBackground(action, payload, result, db);
    }

    return result;
  };

  console.log('[Firebase] gasCall patched ✅');
}

// ══════════════════════════════════════════════════════════
// SYNC BACKGROUND — update Firestore setelah GAS berhasil
// ══════════════════════════════════════════════════════════
async function _syncToFirestoreBackground(action, payload, result, db) {
  try {
    switch (action) {

      case 'addDefect': {
        if (!result.id) break;
        await db.collection('tickets').doc(result.id).set({
          ...payload,
          ID:        result.id,
          Status:    'OPEN',
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          _syncedAt: new Date().toISOString(),
          _source:   'GAS',
        });
        break;
      }

      case 'updateDefect': {
        if (!payload.id) break;
        const updates = {
          UpdatedAt: new Date().toISOString(),
          _syncedAt: new Date().toISOString(),
        };
        if (payload.status)        updates.Status        = payload.status;
        if (payload.engineer)      updates.Engineer      = payload.engineer;
        if (payload.linkedProject) updates.LinkedProject = payload.linkedProject;
        if (payload.startedBy)     updates.StartedBy     = payload.startedBy;
        if (payload.resolvedBy)    updates.ResolvedBy    = payload.resolvedBy;
        if (payload.closedBy)      updates.ClosedBy      = payload.closedBy;
        await db.collection('tickets').doc(payload.id).update(updates);
        break;
      }

      case 'addProject': {
        if (!result.id) break;
        await db.collection('projects').doc(result.id).set({
          ...payload,
          ProjectID:  result.id,
          Status:     'PLANNING',
          CreatedAt:  new Date().toISOString(),
          UpdatedAt:  new Date().toISOString(),
          _syncedAt:  new Date().toISOString(),
          _source:    'GAS',
        });
        break;
      }

      case 'updateProject': {
        if (!payload.id) break;
        const projUpdates = { UpdatedAt: new Date().toISOString(), _syncedAt: new Date().toISOString() };
        ['title','description','department','location','priority','status',
         'targetDate','notes','vendorName','vendorPic','vendorSpk','vendorCost'].forEach(k => {
          if (payload[k] !== undefined) projUpdates[k.charAt(0).toUpperCase()+k.slice(1)] = payload[k];
        });
        await db.collection('projects').doc(payload.id).update(projUpdates);
        break;
      }

      case 'deleteProject': {
        if (!payload.id) break;
        await db.collection('projects').doc(payload.id).update({
          Status:    'DELETED',
          UpdatedAt: new Date().toISOString(),
          _syncedAt: new Date().toISOString(),
        });
        break;
      }
    }
  } catch (e) {
    // Silent — GAS sudah berhasil, Firestore sync gagal tidak critical
    console.warn('[Firebase] Sync background gagal:', action, e.message);
  }
}

// ══════════════════════════════════════════════════════════
// REAL-TIME LISTENERS — onSnapshot untuk tickets aktif
// ══════════════════════════════════════════════════════════
function _startRealtimeListeners(db) {
  // Listen tiket OPEN & IN_PROGRESS — update dashboard otomatis
  db.collection('tickets')
    .where('Status', 'in', ['OPEN', 'IN_PROGRESS', 'WAITING_MATERIAL'])
    .onSnapshot(snap => {
      if (!window.STATE || !snap) return;
      snap.docChanges().forEach(change => {
        const data = { ID: change.doc.id, ...change.doc.data() };
        if (change.type === 'added' || change.type === 'modified') {
          const idx = STATE.defects?.findIndex(d => d.id === data.ID);
          if (idx >= 0) {
            STATE.defects[idx] = _firestoreToDefect(data);
          } else if (change.type === 'added') {
            STATE.defects?.unshift(_firestoreToDefect(data));
          }
        }
      });
      // Re-render dashboard jika sedang tampil
      if (typeof renderDashboard === 'function' && document.getElementById('page-dashboard')?.style.display !== 'none') {
        renderDashboard();
      }
      console.log('[Firebase] Real-time update:', snap.docChanges().length, 'changes');
    }, err => {
      console.warn('[Firebase] Listener error:', err.message);
    });
}

// Helper: konversi Firestore doc ke format STATE.defects
function _firestoreToDefect(d) {
  return {
    id:            d.ID            || d.id,
    room:          d.RoomNumber    || '',
    category:      d.Category      || '',
    desc:          d.Description   || '',
    priority:      d.Priority      || 'MEDIUM',
    status:        d.Status        || 'OPEN',
    reporter:      d.Reporter      || '',
    engineer:      d.Engineer      || '',
    notes:         d.Notes         || '',
    createdAt:     d.CreatedAt     ? new Date(d.CreatedAt).getTime() : 0,
    startedAt:     d.StartedAt     ? new Date(d.StartedAt).getTime() : 0,
    resolvedAt:    d.ResolvedAt    ? new Date(d.ResolvedAt).getTime() : 0,
    closedAt:      d.ClosedAt      ? new Date(d.ClosedAt).getTime() : 0,
    startedBy:     d.StartedBy     || '',
    resolvedBy:    d.ResolvedBy    || '',
    closedBy:      d.ClosedBy      || '',
    linkedProject: d.LinkedProject || '',
    photoBefore:   d.PhotoBefore   || '',
    photoAfter:    d.PhotoAfter    || '',
    areaType:      d.AreaType      || 'ROOM',
    urgencyScore:  Number(d.UrgencyScore || 0),
  };
}

// ══════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════
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
