// Perbaikan Line 397-454 (Real-time Listener dengan renderDefectList)
function _startRealtimeListeners(db) {
  if (_unsubscribeListener) {
    _unsubscribeListener();
    _unsubscribeListener = null;
  }

  var retryCount = 0;
  var MAX_RETRY  = 3;

  function subscribe() {
    _unsubscribeListener = db.collection('tickets')
      .where('Status', 'in', ['OPEN', 'IN_PROGRESS', 'WAITING_DEFECT'])
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
                if (defect.engineer)     STATE.defects[idx].engineer     = defect.engineer;
                if (defect.startedBy)    STATE.defects[idx].startedBy    = defect.startedBy;
                if (defect.resolvedBy)   STATE.defects[idx].resolvedBy   = defect.resolvedBy;
                // FIX: update materialNote jika Firestore punya (dari sync baru)
                if (defect.materialNote) STATE.defects[idx].materialNote = defect.materialNote;
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

            // Re-render BOTH dashboard AND defect list
            var dp = document.getElementById('page-dashboard');
            if (dp && !dp.hidden && typeof renderDashboard === 'function') {
              renderDashboard();
            }
            
            // 🆕 FIX: Render defect list juga untuk update Reason/MaterialNote
            var dl = document.getElementById('page-defects');
            if (dl && !dl.hidden && typeof renderDefectList === 'function') {
              renderDefectList();
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

// Perbaikan Line 258-358 (Background Refresh dengan semua status yang relevan)
function _refreshDefectsBackground(_orig, db) {
  _orig('getDefects', {})
    .then(function(gasData) {
      if (!gasData || !gasData.length) return;

      // Merge dengan data Firestore untuk status terbaru
      // 🆕 FIX: Query SEMUA status yang mungkin punya MaterialNote, bukan hanya 3
      return db.collection('tickets')
        .where('Status', 'in', ['OPEN','IN_PROGRESS','WAITING_DEFECT','RESOLVED','CLOSED'])
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
            if (fsTime > gasTime && fs.Status) d.Status = fs.Status;
            // 🆕 FIX: Selalu ambil MaterialNote terbaru dari Firestore
            if (fs.MaterialNote) d.MaterialNote = fs.MaterialNote;
            return d;
          });

          _cacheSet(_CACHE_KEY_DEFECTS, merged);

          // Update STATE.defects — GAS adalah source of truth
          if (window.STATE && STATE.defects) {
            var changed = false;
            merged.forEach(function(rawD) {
              var d = (typeof normalizeDefect === 'function') ? normalizeDefect(rawD) : rawD;
              var id = d.id || rawD.id || rawD.ID;

              var idx = STATE.defects.findIndex(function(x) { return x.id === id; });
              if (idx >= 0) {
                var prev = STATE.defects[idx];
                var newNote   = d.materialNote || rawD.materialNote || rawD.MaterialNote || '';
                var newStatus = d.status || rawD.status || rawD.Status || '';
                if (newStatus === 'WAITING_MATERIAL') newStatus = 'WAITING_DEFECT';

                var hasNewInfo = (newNote && newNote !== prev.materialNote)
                              || (newStatus && newStatus !== prev.status);

                if (hasNewInfo) {
                  if (newNote)   prev.materialNote = newNote;
                  if (newStatus) prev.status        = newStatus;
                  if (typeof normalizeDefect === 'function') STATE.defects[idx] = d;
                  changed = true;
                  console.log('[SWR] Updated defect:', id, 'materialNote:', newNote);
                }
              } else {
                STATE.defects.push(d);
                changed = true;
              }
            });

            if (changed) {
              if (typeof renderDashboard === 'function') {
                var dp = document.getElementById('page-dashboard');
                if (dp && !dp.hidden) renderDashboard();
              }
              // 🆕 PENTING: Selalu render defect list setelah update
              if (typeof renderDefectList === 'function') {
                var dl = document.getElementById('page-defects');
                if (dl && !dl.hidden) renderDefectList();
              }
            }
          }
          console.log('[SWR] Background refresh defects selesai:', merged.length, 'tiket');
        })
        .catch(function() {
          // Firestore gagal — pakai data GAS murni, normalize dulu
          _cacheSet(_CACHE_KEY_DEFECTS, gasData);
          if (window.STATE && STATE.defects) {
            var changed = false;
            gasData.forEach(function(rawD) {
              var d   = (typeof normalizeDefect === 'function') ? normalizeDefect(rawD) : rawD;
              var id  = d.id || rawD.id || rawD.ID;
              var idx = STATE.defects.findIndex(function(x) { return x.id === id; });
              if (idx >= 0) {
                var newNote = d.materialNote || rawD.MaterialNote || '';
                if (newNote) {
                  STATE.defects[idx].materialNote = newNote;
                  changed = true;
                }
              } else {
                STATE.defects.push(d);
                changed = true;
              }
            });
            // 🆕 FIX: Render defect list jika ada perubahan
            if (changed && typeof renderDefectList === 'function') {
              var dl = document.getElementById('page-defects');
              if (dl && !dl.hidden) renderDefectList();
            }
          }
        });
    })
    .catch(function(e) {
      console.warn('[SWR] Background refresh gagal:', e.message);
    });
}
