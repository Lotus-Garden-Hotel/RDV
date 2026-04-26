// ═══════════════════════════════════════════════════════════
// H.O.M.T — Firebase Hybrid Bridge v3.0
// Strategi: Stale-While-Revalidate
//
// ALUR PERFORMA:
//   1. INSTAN  → Tampilkan cache IndexedDB (offline-first)
//   2. CEPAT   → Firestore overlay status real-time (~200ms)
//   3. AKURAT  → GAS background refresh data lengkap (~2-8s)
//   4. LIVE    → onSnapshot update status otomatis
//
// FALLBACK:
//   Firebase gagal → app jalan 100% via GAS (tidak ada perubahan)
//   GAS gagal      → data dari cache IndexedDB tetap tampil
// ═══════════════════════════════════════════════════════════

var firebaseConfig = {
  apiKey:            "AIzaSyBshlCYJdW85bWjZfNYQw6Ap_OgQIvhEBA",
  authDomain:        "homt-lotusgarden.firebaseapp.com",
  projectId:         "homt-lotusgarden",
  storageBucket:     "homt-lotusgarden.firebasestorage.app",
  messagingSenderId: "904545057231",
  appId:             "1:904545057231:web:025c9e67fd2923e2157aba"
};

var _unsubscribeListener = null;
var _firebaseReady       = false;
var _db                  = null;

// ══════════════════════════════════════════════════════════
// CACHE LAYER — IndexedDB via localStorage fallback
// Simpan snapshot terakhir agar bisa tampil INSTAN
// ══════════════════════════════════════════════════════════
var _CACHE_KEY_DEFECTS  = 'homt_cache_defects';
var _CACHE_KEY_PROJECTS = 'homt_cache_projects';
var _CACHE_TTL_MS       = 5 * 60 * 1000; // 5 menit — refresh jika stale

function _cacheGet(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    // Tidak expired
    if (Date.now() - (obj.ts || 0) < _CACHE_TTL_MS) {
      return obj.data;
    }
    return obj.data; // Tetap return meski stale — akan di-revalidate background
  } catch(e) { return null; }
}

function _cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
  } catch(e) {
    // localStorage penuh — clear cache lama dan coba lagi
    try {
      localStorage.removeItem(_CACHE_KEY_DEFECTS);
      localStorage.removeItem(_CACHE_KEY_PROJECTS);
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
    } catch(e2) { /* silent */ }
  }
}

function _cacheIsStale(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return true;
    var obj = JSON.parse(raw);
    return Date.now() - (obj.ts || 0) > _CACHE_TTL_MS;
  } catch(e) { return true; }
}

// ══════════════════════════════════════════════════════════
// MAIN INIT
// ══════════════════════════════════════════════════════════
function initFirebaseHybrid() {
  return _loadFirebaseSDKs()
    .then(function() {
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }

      var auth = firebase.auth();
      var db   = firebase.firestore();

      // Offline persistence — IndexedDB sebagai cache otomatis Firestore
      return db.enablePersistence({ synchronizeTabs: true })
        .catch(function(err) {
          if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
            console.warn('[Firebase] Persistence error:', err.code);
          }
        })
        .then(function() {
          var user = auth.currentUser;
          if (user) return user;
          return auth.signInAnonymously();
        })
        .then(function() {
          _db = db;
          window._HOMT_DB   = db;
          window._HOMT_AUTH = auth;
          _firebaseReady = true;
          window._firebaseReady = true;
          console.log('[Firebase] v3.0 Hybrid + SWR aktif ✅');

          // Patch gasCall dengan strategi SWR
          _patchGasCallSWR(db);

          // Real-time listener
          _startRealtimeListeners(db);
        });
    })
    .catch(function(e) {
      console.warn('[Firebase] Init gagal → GAS-only mode:', e.message);
      window.FIREBASE_ENABLED = false;
      _firebaseReady = false;
      // gasCall TIDAK di-patch → app jalan normal 100% via GAS
    });
}

// ══════════════════════════════════════════════════════════
// PATCH gasCall — STALE-WHILE-REVALIDATE
// ══════════════════════════════════════════════════════════
function _patchGasCallSWR(db) {
  var _orig = window.gasCall;
  if (!_orig) {
    console.warn('[Firebase] gasCall tidak ditemukan');
    return;
  }

  window.gasCall = function(action, payload) {

    // ════════════════════════════════════════
    // GET DEFECTS — SWR 3 lapis
    // ════════════════════════════════════════
    if (action === 'getDefects') {
      return new Promise(function(resolve) {

        // LAPIS 1: Cache lokal → INSTAN (0ms)
        var cached = _cacheGet(_CACHE_KEY_DEFECTS);
        if (cached && cached.length > 0) {
          resolve(cached);
          console.log('[SWR] getDefects dari cache:', cached.length, 'tiket (instan)');

          // Jika cache masih fresh, cukup andalkan Firestore real-time
          // Jika stale, refresh dari GAS di background
          if (_cacheIsStale(_CACHE_KEY_DEFECTS)) {
            _refreshDefectsBackground(_orig, db);
          }
          return;
        }

        // Tidak ada cache — LAPIS 2: Firestore dulu (cepat ~200-500ms)
        db.collection('tickets')
          .where('Status', '!=', 'DELETED')
          .orderBy('Status')
          .orderBy('CreatedAt', 'desc')
          .limit(300)
          .get({ source: 'cache' }) // Coba dari IndexedDB Firestore dulu
          .catch(function() {
            // IndexedDB kosong — ambil dari network
            return db.collection('tickets')
              .where('Status', '!=', 'DELETED')
              .orderBy('Status')
              .orderBy('CreatedAt', 'desc')
              .limit(300)
              .get();
          })
          .then(function(snap) {
            if (!snap.empty) {
              var fsData = snap.docs.map(function(d) {
                return _firestoreToDefect(Object.assign({ ID: d.id }, d.data()));
              });
              resolve(fsData);
              console.log('[SWR] getDefects dari Firestore:', fsData.length, 'tiket (~200ms)');
              _cacheSet(_CACHE_KEY_DEFECTS, fsData);

              // LAPIS 3: GAS background refresh untuk data lengkap
              _refreshDefectsBackground(_orig, db);
              return;
            }
            // Firestore kosong — langsung ke GAS
            throw new Error('Firestore kosong');
          })
          .catch(function() {
            // FALLBACK: GAS langsung (2-8 detik)
            console.log('[SWR] Fallback ke GAS untuk getDefects');
            resolve(_orig(action, payload).then(function(data) {
              if (data && data.length) _cacheSet(_CACHE_KEY_DEFECTS, data);
              return data;
            }));
          });
      });
    }

    // ════════════════════════════════════════
    // GET PROJECTS — SWR 3 lapis
    // ════════════════════════════════════════
    if (action === 'getProjects') {
      return new Promise(function(resolve) {

        // LAPIS 1: Cache lokal → INSTAN
        var cached = _cacheGet(_CACHE_KEY_PROJECTS);
        if (cached && cached.length > 0) {
          resolve(cached);
          console.log('[SWR] getProjects dari cache:', cached.length, 'project (instan)');

          if (_cacheIsStale(_CACHE_KEY_PROJECTS)) {
            _refreshProjectsBackground(_orig, db);
          }
          return;
        }

        // LAPIS 2: GAS langsung (projects tidak di Firestore secara penuh)
        // GAS = source of truth untuk projects karena ada _tasks
        _orig(action, payload)
          .then(function(data) {
            if (data && data.length) {
              resolve(data);
              _cacheSet(_CACHE_KEY_PROJECTS, data);
              console.log('[SWR] getProjects dari GAS:', data.length, 'project');
            } else {
              resolve(data || []);
            }
          })
          .catch(function(e) {
            console.warn('[SWR] getProjects GAS error:', e.message);
            resolve([]);
          });
      });
    }

    // ════════════════════════════════════════
    // SEMUA WRITE → GAS + sync Firestore background
    // ════════════════════════════════════════
    return Promise.resolve(_orig(action, payload))
      .then(function(result) {
        if (result && !result.error) {
          // Invalidate cache setelah write berhasil
          if (action === 'addDefect' || action === 'updateDefect') {
            _cacheSet(_CACHE_KEY_DEFECTS, null); // force revalidate
          }
          if (action === 'addProject' || action === 'updateProject' || action === 'deleteProject') {
            _cacheSet(_CACHE_KEY_PROJECTS, null); // force revalidate
          }
          // Sync ke Firestore di background
          _syncToFirestore(action, payload, result, db);
        }
        return result;
      });
  };

  console.log('[Firebase] gasCall patched dengan SWR ✅');
}

// ══════════════════════════════════════════════════════════
// BACKGROUND REFRESH — update STATE + cache + re-render
// ══════════════════════════════════════════════════════════
function _refreshDefectsBackground(_orig, db) {
  _orig('getDefects', {})
    .then(function(gasData) {
      if (!gasData || !gasData.length) return;

      // Merge dengan data Firestore untuk status terbaru
      return db.collection('tickets')
        .where('Status', 'in', ['OPEN','IN_PROGRESS','WAITING_MATERIAL'])
        .get()
        .then(function(snap) {
          var fsMap = {};
          snap.docs.forEach(function(d) { fsMap[d.id] = d.data(); });

          var merged = gasData.map(function(d) {
            var fs = fsMap[d.id || d.ID];
            if (!fs) return d;
            var fsTime  = fs.UpdatedAt ? new Date(fs.UpdatedAt).getTime() : 0;
            var gasTime = d.updatedAt || d.createdAt || 0;
            // Pakai status Firestore jika lebih baru
            if (fsTime > gasTime && fs.Status) d.status = fs.Status;
            return d;
          });

          _cacheSet(_CACHE_KEY_DEFECTS, merged);

          // Update STATE.defects jika ada perubahan
          if (window.STATE && STATE.defects) {
            var changed = false;
            merged.forEach(function(d) {
              var idx = STATE.defects.findIndex(function(x) {
                return x.id === (d.id || d.ID);
              });
              if (idx >= 0) {
                // Hanya update jika data baru lebih lengkap
                if (d.desc && !STATE.defects[idx].desc) {
                  STATE.defects[idx] = d;
                  changed = true;
                }
              } else {
                STATE.defects.push(d);
                changed = true;
              }
            });

            if (changed && typeof renderDashboard === 'function') {
              var dp = document.getElementById('page-dashboard');
              if (dp && !dp.hidden) renderDashboard();
            }
          }
          console.log('[SWR] Background refresh defects selesai:', merged.length, 'tiket');
        })
        .catch(function() {
          // Firestore gagal — pakai data GAS murni
          _cacheSet(_CACHE_KEY_DEFECTS, gasData);
          if (window.STATE) STATE.defects = gasData;
        });
    })
    .catch(function(e) {
      console.warn('[SWR] Background refresh gagal:', e.message);
    });
}

function _refreshProjectsBackground(_orig, db) {
  _orig('getProjects', {})
    .then(function(data) {
      if (!data || !data.length) return;
      _cacheSet(_CACHE_KEY_PROJECTS, data);

      if (window.STATE) {
        STATE.projects = data;
        // Re-render projects jika sedang dibuka
        var pp = document.getElementById('page-projects');
        if (pp && !pp.hidden && typeof _renderProjectCards === 'function') {
          _updateDeptDashboard && _updateDeptDashboard();
          _renderProjectCards();
        }
      }
      console.log('[SWR] Background refresh projects selesai:', data.length);
    })
    .catch(function(e) {
      console.warn('[SWR] Background refresh projects gagal:', e.message);
    });
}

// ══════════════════════════════════════════════════════════
// REAL-TIME LISTENER — Firestore onSnapshot
// Update STATE otomatis saat ada perubahan dari user lain
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
          if (!window.STATE || !snap || snap.docChanges().length === 0) return;

          var changed = false;
          snap.docChanges().forEach(function(change) {
            var data   = Object.assign({ ID: change.doc.id }, change.doc.data());
            var defect = _firestoreToDefect(data);

            if (change.type === 'added' || change.type === 'modified') {
              var idx = (STATE.defects || []).findIndex(function(d) {
                return d.id === data.ID;
              });
              if (idx >= 0) {
                // Hanya update field status — jangan timpa data lengkap dari GAS
                STATE.defects[idx].status = defect.status;
                if (defect.engineer)  STATE.defects[idx].engineer  = defect.engineer;
                if (defect.startedBy) STATE.defects[idx].startedBy = defect.startedBy;
                if (defect.resolvedBy)STATE.defects[idx].resolvedBy= defect.resolvedBy;
                changed = true;
              } else if (change.type === 'added') {
                STATE.defects && STATE.defects.unshift(defect);
                changed = true;
              }
            } else if (change.type === 'removed' && STATE.defects) {
              STATE.defects = STATE.defects.filter(function(d) { return d.id !== data.ID; });
              changed = true;
            }
          });

          if (changed) {
            // Invalidate cache
            _cacheSet(_CACHE_KEY_DEFECTS, STATE.defects);

            // Re-render hanya halaman yang aktif
            var dp = document.getElementById('page-dashboard');
            if (dp && !dp.hidden && typeof renderDashboard === 'function') {
              renderDashboard();
            }
            console.log('[SWR] Real-time update:', snap.docChanges().length, 'changes');
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
// SYNC BACKGROUND ke Firestore setelah GAS write berhasil
// ══════════════════════════════════════════════════════════
function _syncToFirestore(action, payload, result, db) {
  var now = new Date().toISOString();

  if (action === 'addDefect' && result.id) {
    db.collection('tickets').doc(result.id).set(
      Object.assign({}, payload, {
        ID: result.id, Status: 'OPEN',
        CreatedAt: now, UpdatedAt: now, _source: 'GAS'
      })
    ).catch(function(e) { console.warn('[Firebase] sync addDefect:', e.message); });
  }

  else if (action === 'updateDefect' && payload.id) {
    var upd = { UpdatedAt: now };
    ['status','engineer','linkedProject','startedBy','resolvedBy','closedBy','notes']
      .forEach(function(k) {
        if (payload[k] !== undefined) {
          upd[k.charAt(0).toUpperCase()+k.slice(1)] = payload[k];
        }
      });
    db.collection('tickets').doc(payload.id).update(upd)
      .catch(function(e) { console.warn('[Firebase] sync updateDefect:', e.message); });
  }

  else if (action === 'addProject' && result.id) {
    db.collection('projects').doc(result.id).set(
      Object.assign({}, payload, {
        ProjectID: result.id, Status: 'PLANNING',
        CreatedAt: now, UpdatedAt: now, _source: 'GAS'
      })
    ).catch(function(e) { console.warn('[Firebase] sync addProject:', e.message); });
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
    db.collection('projects').doc(payload.id)
      .update({ Status: 'DELETED', UpdatedAt: now })
      .catch(function(e) { console.warn('[Firebase] sync deleteProject:', e.message); });
  }
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
    photoBefore:   d.PhotoBefore   || d.photoBefore   || '',
    photoAfter:    d.PhotoAfter    || d.photoAfter    || '',
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

function _loadFirebaseSDKs() {
  return _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
    .then(function() {
      return _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js');
    })
    .then(function() {
      return _loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js');
    });
}

function _loadScript(src) {
  return new Promise(function(resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    var s    = document.createElement('script');
    s.src    = src;
    s.onload = resolve;
    s.onerror = function() { reject(new Error('Gagal load: ' + src)); };
    document.head.appendChild(s);
  });
}