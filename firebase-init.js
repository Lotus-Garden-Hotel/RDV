// ═══════════════════════════════════════════════════════════
// H.O.M.T — Firebase Hybrid Bridge v2.2
// File: firebase-init.js
//
// ARSITEKTUR:
//   - GAS = PRIMARY untuk semua WRITE (validasi, notif WA, foto Drive)
//   - Firestore = SECONDARY untuk READ real-time & offline cache
//   - Anonymous Auth wajib agar Security Rules canRead() = true
//
// PRASYARAT DI FIREBASE CONSOLE:
//   1. Authentication → Sign-in method → Anonymous → Enable
//   2. Firestore → Rules → deploy rules dari H.O.M.T_V8_rules.txt
//   3. Firestore → Indexes → buat composite index jika diminta
// ═══════════════════════════════════════════════════════════

var firebaseConfig = {
  apiKey:            "AIzaSyBshlCYJdW85bWjZfNYQw6Ap_OgQIvhEBA",
  authDomain:        "homt-lotusgarden.firebaseapp.com",
  projectId:         "homt-lotusgarden",
  storageBucket:     "homt-lotusgarden.firebasestorage.app",
  messagingSenderId: "904545057231",
  appId:             "1:904545057231:web:025c9e67fd2923e2157aba"
};

// Internal state
var _unsubscribeListener = null;
var _firebaseReady = false;

// ══════════════════════════════════════════════════════════
// MAIN INIT — dipanggil dari _initFirebaseWithGuard di HTML
// ══════════════════════════════════════════════════════════
function initFirebaseHybrid() {
  return _loadFirebaseSDKs()
    .then(function() {
      // Init app
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }

      var auth = firebase.auth();
      var db   = firebase.firestore();

      // Offline persistence — non-fatal jika gagal
      return db.enablePersistence({ synchronizeTabs: true })
        .catch(function(err) {
          if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
            console.warn('[Firebase] Persistence error:', err.code);
          }
        })
        .then(function() {
          // Anonymous sign-in — wajib agar Firestore Security Rules izinkan read
          var user = auth.currentUser;
          if (user) {
            return user;
          }
          return auth.signInAnonymously();
        })
        .then(function() {
          window._HOMT_DB   = db;
          window._HOMT_AUTH = auth;
          _firebaseReady = true;
          window._firebaseReady = true;
          console.log('[Firebase] Hybrid mode aktif');

          // Patch gasCall: read dari Firestore, write tetap ke GAS
          _patchGasCallForFirestore(db);

          // Real-time listener untuk tiket aktif
          _startRealtimeListeners(db);
        });
    })
    .catch(function(e) {
      console.warn('[Firebase] Init gagal, GAS-only mode:', e.message);
      window.FIREBASE_ENABLED = false;
      _firebaseReady = false;
    });
}

// ══════════════════════════════════════════════════════════
// LOAD SDK — urutan penting: app -> auth -> firestore
// ══════════════════════════════════════════════════════════
function _loadFirebaseSDKs() {
  return _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
    .then(function() {
      return _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js');
    })
    .then(function() {
      return _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js');
    });
}

// ══════════════════════════════════════════════════════════
// PATCH gasCall — intercept READ actions ke Firestore
// ══════════════════════════════════════════════════════════
function _patchGasCallForFirestore(db) {
  var _orig = window.gasCall;
  if (!_orig) {
    console.warn('[Firebase] gasCall tidak ditemukan — patch dibatalkan');
    return;
  }

  window.gasCall = function(action, payload) {

    // ── getDefects: GAS = source of truth, Firestore = real-time overlay ──
    // STRATEGI: GAS selalu punya data lengkap (foto, semua field).
    // Firestore hanya dipakai untuk update real-time SETELAH data GAS dimuat.
    if (action === 'getDefects') {
      return Promise.resolve(_orig(action, payload))
        .then(function(gasData) {
          if (!gasData || !gasData.length) return gasData;
          console.log('[Firebase] getDefects dari GAS:', gasData.length, 'tiket');
          // Overlay dengan data Firestore yang lebih baru (jika ada)
          return db.collection('tickets')
            .where('Status', 'in', ['OPEN','IN_PROGRESS','WAITING_MATERIAL'])
            .get()
            .then(function(snap) {
              if (snap.empty) return gasData;
              // Build map dari Firestore untuk merge status terbaru
              var fsMap = {};
              snap.docs.forEach(function(d) {
                fsMap[d.id] = d.data();
              });
              // Merge: pakai data GAS tapi update status dari Firestore jika lebih baru
              return gasData.map(function(d) {
                var fs = fsMap[d.id];
                if (!fs) return d;
                var fsUpdated = fs.UpdatedAt ? new Date(fs.UpdatedAt).getTime() : 0;
                var gasUpdated = d.updatedAt || d.createdAt || 0;
                if (fsUpdated > gasUpdated && fs.Status) {
                  d.status = fs.Status.toLowerCase ? fs.Status : d.status;
                }
                return d;
              });
            })
            .catch(function() { return gasData; }); // Firestore error → tetap pakai GAS
        })
        .catch(function(e) {
          console.warn('[Firebase] getDefects error:', e.message);
          return _orig(action, payload);
        });
    }

    // ── getProjects: GAS = source of truth ────────────────
    // GAS punya semua field lengkap (Title, Description, Tasks, dll)
    // Firestore hanya untuk sync background — bukan untuk READ
    if (action === 'getProjects') {
      return Promise.resolve(_orig(action, payload))
        .then(function(data) {
          console.log('[Firebase] getProjects dari GAS:', (data||[]).length, 'project');
          return data || [];
        })
        .catch(function(e) {
          console.warn('[Firebase] getProjects error:', e.message);
          return [];
        });
    }

    // ── Semua WRITE tetap ke GAS, lalu sync background ke Firestore ──
    return Promise.resolve(_orig(action, payload))
      .then(function(result) {
        if (result && !result.error) {
          _syncToFirestore(action, payload, result, db);
        }
        return result;
      });
  };

  console.log('[Firebase] gasCall patched');
}

// ══════════════════════════════════════════════════════════
// SYNC BACKGROUND ke Firestore setelah GAS berhasil
// ══════════════════════════════════════════════════════════
function _syncToFirestore(action, payload, result, db) {
  var now = new Date().toISOString();

  if (action === 'addDefect' && result.id) {
    // FIX: payload GAS pakai lowercase — simpan PascalCase ke Firestore
    // agar _firestoreToDefect(d.PhotoBefore) bisa baca dengan benar
    db.collection('tickets').doc(result.id).set({
      ID:          result.id,
      RoomNumber:  payload.room        || payload.RoomNumber  || '',
      Category:    payload.category    || payload.Category    || '',
      Description: payload.desc        || payload.Description || '',
      Priority:    payload.priority    || payload.Priority    || 'MEDIUM',
      Reporter:    payload.reporter    || payload.Reporter    || '',
      AreaType:    payload.areaType    || payload.AreaType    || 'ROOM',
      PhotoBefore: payload.photoBefore || payload.PhotoBefore || '',
      PhotoAfter:  payload.photoAfter  || payload.PhotoAfter  || '',
      Notes:       payload.notes       || payload.Notes       || '',
      Status:      'OPEN',
      CreatedAt:   now,
      UpdatedAt:   now,
      _source:     'GAS',
    }).catch(function(e) { console.warn('[Firebase] sync addDefect:', e.message); });
  }

  else if (action === 'updateDefect' && payload.id) {
    var upd = { UpdatedAt: now };
    // FIX: tambah photoBefore & photoAfter agar foto ter-sync ke Firestore
    ['status','engineer','linkedProject','startedBy','resolvedBy',
     'closedBy','notes','photoBefore','photoAfter']
      .forEach(function(k) { if (payload[k] !== undefined) upd[k.charAt(0).toUpperCase()+k.slice(1)] = payload[k]; });
    db.collection('tickets').doc(payload.id).update(upd)
      .catch(function(e) { console.warn('[Firebase] sync updateDefect:', e.message); });
  }

  else if (action === 'addProject' && result.id) {
    // FIX: payload dari GAS pakai lowercase (title, department) — konversi ke PascalCase
    db.collection('projects').doc(result.id).set({
      ProjectID:   result.id,
      Title:       payload.title       || payload.Title       || '',
      Description: payload.description || payload.Description || '',
      Department:  payload.department  || payload.Department  || '',
      Location:    payload.location    || payload.Location    || '',
      Priority:    payload.priority    || payload.Priority    || 'MEDIUM',
      Status:      'PLANNING',
      TargetDate:  payload.targetDate  || payload.TargetDate  || '',
      Notes:       payload.notes       || payload.Notes       || '',
      VendorName:  payload.vendorName  || payload.VendorName  || '',
      VendorPic:   payload.vendorPic   || payload.VendorPic   || '',
      VendorSpk:   payload.vendorSpk   || payload.VendorSpk   || '',
      VendorCost:  payload.vendorCost  || payload.VendorCost  || '',
      CreatedBy:   payload.createdBy   || payload.CreatedBy   || '',
      CreatedAt:   now, UpdatedAt: now, _source: 'GAS',
    }).catch(function(e) { console.warn('[Firebase] sync addProject:', e.message); });
  }

  else if (action === 'updateProject' && payload.id) {
    var pu = { UpdatedAt: now };
    ['title','description','department','location','priority','status',
     'targetDate','notes','vendorName','vendorPic','vendorSpk','vendorCost']
      .forEach(function(k) {
        if (payload[k] !== undefined) pu[k.charAt(0).toUpperCase()+k.slice(1)] = payload[k];
      });
    db.collection('projects').doc(payload.id).update(pu)
      .catch(function(e) { console.warn('[Firebase] sync updateProject:', e.message); });
  }

  else if (action === 'deleteProject' && payload.id) {
    db.collection('projects').doc(payload.id).update({ Status: 'DELETED', UpdatedAt: now })
      .catch(function(e) { console.warn('[Firebase] sync deleteProject:', e.message); });
  }
}

// ══════════════════════════════════════════════════════════
// REAL-TIME LISTENER — update STATE.defects otomatis
// ══════════════════════════════════════════════════════════
function _startRealtimeListeners(db) {
  if (_unsubscribeListener) {
    _unsubscribeListener();
    _unsubscribeListener = null;
  }

  var retryCount = 0;
  var MAX_RETRY  = 3;

  function subscribe() {
    _unsubscribeListener = db.collection('tickets')
      .where('Status', 'in', ['OPEN', 'IN_PROGRESS', 'WAITING_MATERIAL'])
      .onSnapshot(
        function(snap) {
          retryCount = 0;
          if (!window.STATE || !snap) return;

          var changed = false;
          snap.docChanges().forEach(function(change) {
            var data = Object.assign({ ID: change.doc.id }, change.doc.data());
            var defect = _firestoreToDefect(data);

            if (change.type === 'added' || change.type === 'modified') {
              var idx = (STATE.defects || []).findIndex(function(d) { return d.id === data.ID; });
              if (idx >= 0) {
                STATE.defects[idx] = defect;
                changed = true;
              } else if (change.type === 'added' && STATE.defects) {
                STATE.defects.unshift(defect);
                changed = true;
              }
            } else if (change.type === 'removed' && STATE.defects) {
              STATE.defects = STATE.defects.filter(function(d) { return d.id !== data.ID; });
              changed = true;
            }
          });

          if (changed) {
            var dp = document.getElementById('page-dashboard');
            if (dp && dp.classList.contains('active') && typeof renderDashboard === 'function') {
              renderDashboard();
            }
          }
        },
        function(err) {
          console.warn('[Firebase] Listener error:', err.message);
          if (retryCount < MAX_RETRY) {
            retryCount++;
            setTimeout(subscribe, Math.pow(2, retryCount) * 1000);
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
    photoBefore:   d.PhotoBefore   || d.photoBefore  || '',
    photoAfter:    d.PhotoAfter    || d.photoAfter   || '',
    areaType:      d.AreaType      || 'ROOM',
    urgencyScore:  Number(d.UrgencyScore  || 0),
    slaPausedMin:  Number(d.SLAPausedMin  || 0),
    materialNote:  d.MaterialNote  || '',
    waitDurationLabel:   d.WaitDurationLabel   || '',
    repairDurationLabel: d.RepairDurationLabel || '',
    totalDurationLabel:  d.TotalDurationLabel  || '',
    assignedTo:    d.AssignedTo    || '',
  };
}


// ══════════════════════════════════════════════════════════
// NORMALIZE PROJECT — pastikan field selalu PascalCase
// GAS payload lowercase, Firestore mungkin simpan campur
// ══════════════════════════════════════════════════════════
function _normalizeProject(d) {
  return {
    ProjectID:   d.ProjectID   || d.projectId   || d.id || '',
    Title:       d.Title       || d.title        || '—',
    Description: d.Description || d.description  || '',
    Department:  d.Department  || d.department   || '',
    Location:    d.Location    || d.location     || '',
    Priority:    d.Priority    || d.priority     || 'MEDIUM',
    Status:      d.Status      || d.status       || 'PLANNING',
    TargetDate:  d.TargetDate  || d.targetDate   || '',
    StartDate:   d.StartDate   || d.startDate    || '',
    CompletedAt: d.CompletedAt || d.completedAt  || '',
    Notes:       d.Notes       || d.notes        || '',
    VendorName:  d.VendorName  || d.vendorName   || '',
    VendorPic:   d.VendorPic   || d.vendorPic    || '',
    VendorSpk:   d.VendorSpk   || d.vendorSpk    || '',
    VendorCost:  d.VendorCost  || d.vendorCost   || '',
    CreatedBy:   d.CreatedBy   || d.createdBy    || '',
    CreatedAt:   d.CreatedAt   || d.createdAt    || '',
    UpdatedAt:   d.UpdatedAt   || d.updatedAt    || '',
    _tasks:      d._tasks      || [],
    _source:     d._source     || 'Firestore',
  };
}

function _loadScript(src) {
  return new Promise(function(resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) {
      resolve();
      return;
    }
    var s    = document.createElement('script');
    s.src    = src;
    s.onload = resolve;
    s.onerror = function() { reject(new Error('Gagal load: ' + src)); };
    document.head.appendChild(s);
  });
}