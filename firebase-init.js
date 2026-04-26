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
          // Kembalikan format yang kompatibel dengan normalizeDefect di HTML
          // Pastikan field key PascalCase (RoomNumber, Status, Category, dll)
          return snap.docs.map(d => {
            const raw = d.data();
            // Jika data disimpan dengan key lowercase, normalisasi ke PascalCase
            return {
              ID:                  d.id,
              RoomNumber:          raw.RoomNumber    || raw.room         || '',
              Category:            raw.Category      || raw.category     || '',
              Description:         raw.Description   || raw.description  || raw.desc || '',
              Priority:            raw.Priority      || raw.priority     || 'MEDIUM',
              Status:              raw.Status        || raw.status       || 'OPEN',
              Reporter:            raw.Reporter      || raw.reporter     || '',
              Engineer:            raw.Engineer      || raw.engineer     || '',
              Notes:               raw.Notes         || raw.notes        || '',
              PhotoBefore:         raw.PhotoBefore   || raw.photoBefore  || '',
              PhotoAfter:          raw.PhotoAfter    || raw.photoAfter   || '',
              SLA_Clock:           raw.SLA_Clock     || raw.slaClockIso  || '',
              StartedAt:           raw.StartedAt     || raw.startedAt    || '',
              ResolvedAt:          raw.ResolvedAt    || raw.resolvedAt   || '',
              ClosedAt:            raw.ClosedAt      || raw.closedAt     || '',
              ReopenedAt:          raw.ReopenedAt    || raw.reopenedAt   || '',
              CreatedAt:           raw.CreatedAt     || raw.createdAt    || raw.Timestamp || '',
              UpdatedAt:           raw.UpdatedAt     || raw.updatedAt    || '',
              WaitingMaterialAt:   raw.WaitingMaterialAt || raw.waitingMaterialAt || '',
              MaterialNote:        raw.MaterialNote  || raw.materialNote || '',
              AssignedTo:          raw.AssignedTo    || raw.assignedTo   || '',
              AreaType:            raw.AreaType      || raw.areaType     || 'ROOM',
              UrgencyScore:        Number(raw.UrgencyScore  || raw.urgencyScore  || 0),
              SLAPausedMin:        Number(raw.SLAPausedMin  || raw.slaPausedMin  || 0),
              RepairDurationMin:   Number(raw.RepairDurationMin  || 0),
              RepairDurationLabel: raw.RepairDurationLabel || '',
              WaitDurationMin:     Number(raw.WaitDurationMin    || 0),
              WaitDurationLabel:   raw.WaitDurationLabel   || '',
              TotalDurationMin:    Number(raw.TotalDurationMin   || 0),
              TotalDurationLabel:  raw.TotalDurationLabel  || '',
              LinkedProject:       raw.LinkedProject  || raw.linkedProject || '',
            };
          });
        }
        // Kosong — fallback ke GAS (mungkin belum migrasi)
        console.log('[Firebase] Firestore kosong, fallback ke GAS');
      } catch(e) {
        if (e.code === 'failed-precondition' || (e.message && e.message.includes('index'))) {
          console.warn('[Firebase] Index Firestore belum dibuat → fallback GAS. Buat composite index di Firebase Console untuk koleksi "tickets": Status (!=) + CreatedAt (desc)');
        } else {
          console.warn('[Firebase] getDefects fallback ke GAS:', e.message);
        }
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
          // FIX: normalisasi dokumen Firestore ke PascalCase
          // Data lama mungkin tersimpan dengan key lowercase — pastikan selalu PascalCase
          const projects = snap.docs.map(d => {
            const raw = d.data();
            return _normFirestoreProject(d.id, raw);
          });

          // Fetch tasks
          const taskSnap = await db.collection('projectTasks').get();
          const taskMap  = {};
          taskSnap.forEach(t => {
            const td  = t.data();
            const pid = td.ProjectID || td.projectId || td.projectID || '';
            if (!taskMap[pid]) taskMap[pid] = [];
            taskMap[pid].push(_normFirestoreTask(t.id, td));
          });
          projects.forEach(p => {
            p._tasks = (taskMap[p['ProjectID']] || [])
              .sort((a,b) => (Number(a['Order'])||0) - (Number(b['Order'])||0));
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
      // FIX: normalisasi payload lowercase ke PascalCase sebelum simpan ke Firestore
      await db.collection('tickets').doc(result.id).set({
        ID:           result.id,
        RoomNumber:   String(payload.room      || payload.RoomNumber || ''),
        Category:     payload.category         || payload.Category   || '',
        Description:  payload.description      || payload.desc       || '',
        Priority:     payload.priority         || payload.Priority   || 'MEDIUM',
        Status:       'OPEN',
        Reporter:     payload.reporter         || payload.Reporter   || '',
        Engineer:     payload.engineer         || payload.Engineer   || '',
        Notes:        payload.notes            || payload.Notes      || '',
        PhotoBefore:  payload.photoBefore      || payload.PhotoBefore|| '',
        PhotoAfter:   '',
        AreaType:     payload.areaType         || payload.AreaType   || 'ROOM',
        SLA_Clock:    result.slaDeadline       || '',
        CreatedAt:    now,
        UpdatedAt:    now,
        _syncedAt:    now,
        _source:      'GAS',
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
      // FIX: payload pakai lowercase keys (title, department, dll)
      // Normalisasi ke PascalCase agar konsisten dengan data GAS Sheets
      await db.collection('projects').doc(result.id).set({
        ProjectID:    result.id,
        Title:        payload.title        || '',
        Description:  payload.description  || '',
        Department:   payload.department   || 'ENG',
        Location:     payload.location     || '',
        Priority:     payload.priority     || 'MEDIUM',
        Status:       'PLANNING',
        CreatedBy:    payload.createdBy    || '',
        AssignedTo:   payload.assignedTo   || '',
        StartDate:    payload.startDate    || now,
        TargetDate:   payload.targetDate   || '',
        CompletedAt:  '',
        CreatedAt:    now,
        UpdatedAt:    now,
        Notes:        payload.notes        || '',
        LinkedDefects: payload.linkedDefects || '',
        VendorName:   payload.vendorName   || '',
        VendorPic:    payload.vendorPic    || '',
        VendorSpk:    payload.vendorSpk    || '',
        VendorCost:   payload.vendorCost   || 0,
        _syncedAt:    now,
        _source:      'GAS',
      });
      // Sync tasks jika ada
      if (payload.tasks && payload.tasks.length > 0) {
        const batch = db.batch();
        payload.tasks.forEach((taskTitle, idx) => {
          const taskId  = 'TSK-' + result.id.replace('PRJ-','') + '-' + String(idx+1).padStart(2,'0');
          const taskRef = db.collection('projectTasks').doc(taskId);
          batch.set(taskRef, {
            TaskID:     taskId,
            ProjectID:  result.id,
            Title:      taskTitle,
            AssignedTo: payload.assignedTo || '',
            Status:     'TODO',
            Order:      idx + 1,
            CreatedAt:  now,
            UpdatedAt:  now,
            DoneAt:     '',
            PhotoURL:   '',
            PhotoNote:  '',
          });
        });
        await batch.commit();
      }
      break;

    case 'updateProject':
      if (!payload.id) break;
      const projUpd = { UpdatedAt: now, _syncedAt: now };
      // FIX: map lowercase payload keys ke PascalCase untuk Firestore
      const _keyMap = {
        title:'Title', description:'Description', department:'Department',
        location:'Location', priority:'Priority', status:'Status',
        targetDate:'TargetDate', notes:'Notes',
        vendorName:'VendorName', vendorPic:'VendorPic',
        vendorSpk:'VendorSpk', vendorCost:'VendorCost',
        assignedTo:'AssignedTo', linkedDefects:'LinkedDefects',
      };
      Object.entries(_keyMap).forEach(([lc, pc]) => {
        if (payload[lc] !== undefined) projUpd[pc] = payload[lc];
      });
      if (payload.status === 'COMPLETED') projUpd.CompletedAt = now;
      await db.collection('projects').doc(payload.id).update(projUpd);
      // Update task status jika ada
      if (payload.taskId && payload.taskStatus) {
        const taskUpd = { Status: payload.taskStatus, UpdatedAt: now, _syncedAt: now };
        if (payload.taskStatus === 'DONE') taskUpd.DoneAt = now;
        if (payload.taskPhotoUrl) taskUpd.PhotoURL = payload.taskPhotoUrl;
        if (payload.taskPhotoNote) taskUpd.PhotoNote = payload.taskPhotoNote;
        await db.collection('projectTasks').doc(payload.taskId).update(taskUpd);
      }
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
// NORMALIZATION HELPERS — Firestore key case fix
// ══════════════════════════════════════════════════════════

/**
 * Normalisasi dokumen project Firestore ke PascalCase konsisten dengan GAS Sheets.
 * Data lama mungkin punya keys lowercase (title, department, dll) karena bug
 * _syncToFirestore lama yang spread payload langsung tanpa konversi.
 */
function _normFirestoreProject(docId, raw) {
  // Helper: ambil nilai dari PascalCase ATAU lowercase key
  const _v = (pc, lc) => raw[pc] !== undefined ? raw[pc] : (raw[lc] !== undefined ? raw[lc] : '');
  return {
    ProjectID:    docId,
    Title:        _v('Title',        'title'),
    Description:  _v('Description',  'description'),
    Department:   _v('Department',   'department') || 'ENG',
    Location:     _v('Location',     'location'),
    Priority:     _v('Priority',     'priority') || 'MEDIUM',
    Status:       _v('Status',       'status') || 'PLANNING',
    CreatedBy:    _v('CreatedBy',    'createdBy'),
    AssignedTo:   _v('AssignedTo',   'assignedTo'),
    StartDate:    _v('StartDate',    'startDate'),
    TargetDate:   _v('TargetDate',   'targetDate'),
    CompletedAt:  _v('CompletedAt',  'completedAt'),
    CreatedAt:    _v('CreatedAt',    'createdAt'),
    UpdatedAt:    _v('UpdatedAt',    'updatedAt'),
    Notes:        _v('Notes',        'notes'),
    LinkedDefects: _v('LinkedDefects', 'linkedDefects'),
    VendorName:   _v('VendorName',   'vendorName'),
    VendorPic:    _v('VendorPic',    'vendorPic'),
    VendorSpk:    _v('VendorSpk',    'vendorSpk'),
    VendorCost:   Number(_v('VendorCost', 'vendorCost')) || 0,
    _tasks:       [],
    _source:      raw._source || 'Firestore',
  };
}

/**
 * Normalisasi dokumen task Firestore ke PascalCase.
 */
function _normFirestoreTask(docId, raw) {
  const _v = (pc, lc) => raw[pc] !== undefined ? raw[pc] : (raw[lc] !== undefined ? raw[lc] : '');
  return {
    TaskID:     docId,
    ProjectID:  _v('ProjectID',  'projectId') || _v('ProjectID', 'projectID'),
    Title:      _v('Title',      'title'),
    AssignedTo: _v('AssignedTo', 'assignedTo'),
    Status:     _v('Status',     'status') || 'TODO',
    Order:      Number(_v('Order', 'order')) || 0,
    CreatedAt:  _v('CreatedAt',  'createdAt'),
    UpdatedAt:  _v('UpdatedAt',  'updatedAt'),
    DoneAt:     _v('DoneAt',     'doneAt'),
    PhotoURL:   _v('PhotoURL',   'photoUrl') || _v('PhotoURL', 'photoURL'),
    PhotoNote:  _v('PhotoNote',  'photoNote'),
  };
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
