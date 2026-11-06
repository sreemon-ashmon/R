/*
 * notebook.js — RStudio-style notebook editor (index.html)
 *
 * - Anonymous sign-in for normal visitors; master mode requires a real master account.
 * - All writes go through the SQL functions create_notebook / save_notebook / delete_notebook.
 * - Optimistic concurrency (revision) + 3-way merge, Realtime updates, autosave, local draft recovery.
 * - Each cell is one editor tab; the Console is a MOCK R session (see rruntime.js). Real R needs a separate server-side process.
 */
(function () {
  'use strict';

  // this page is always the light RStudio look, whatever the OS theme is
  document.documentElement.classList.add('rs');
  document.documentElement.setAttribute('data-theme', 'light');

  var C = window.NBCore, NB = window.NB, h = NB.h, cfg = NB.cfg;
  var root = document.getElementById('app');

  var S = {
    client: null, user: null, isMaster: false, masterMode: false,
    nbId: null, ownerId: null, ownerName: '', revision: 0, seenRevision: 0,
    title: 'Untitled.ipynb', cells: [], base: { title: undefined, cells: [] },
    dirty: false, editVersion: 0, saving: false, saveAgain: false, saveError: null, retryCount: 0,
    saveTimer: null, retryTimer: null, draftTimer: null, refreshTimer: null, refreshing: false, refreshAgain: false,
    lastSavedAt: null, lastEditedBy: null, lastEditedAt: null,
    selectedId: null, readOnly: false, readOnlyReason: '', autosavePaused: false, pendingConflict: false,
    execCount: 0, env: {}, runtime: 'disconnected', running: {}, outputs: {}, stopAll: false,
    deleted: [], channel: null, live: false, hadDisconnect: false,
    chord: false, chordTimer: null, panel: null, menu: null, skipUnload: false, profileName: '',
    hist: [], histIdx: null, lastRun: null, sourceOnSave: false
  };
  var els = {};

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowIso() { return new Date().toISOString(); }
  function getCell(id) { for (var i = 0; i < S.cells.length; i++) if (S.cells[i].id === id) return S.cells[i]; return null; }
  function indexOfCell(id) { for (var i = 0; i < S.cells.length; i++) if (S.cells[i].id === id) return i; return -1; }
  function wrapOf(id) { return els.cells ? els.cells.querySelector('.cell-wrap[data-id="' + id + '"]') : null; }
  function snapshot() { return { title: S.title, cells: S.cells.map(C.cloneCell) }; }
  function cloneSnap(s) { return { title: s.title, cells: s.cells.map(C.cloneCell) }; }
  function me() { return S.user ? S.user.id : null; }
  function pageUrl(file, qs) { return file + (qs ? '?' + qs : ''); }

  /* ================================================================ boot */

  function fatal(title, message, details, actions) {
    NB.showFatal(root, { title: title, message: message, details: details, actions: actions || [{ label: 'Try again', primary: true, onClick: function () { location.reload(); } }] });
  }

  function showNotFound() {
    NB.showFatal(root, {
      icon: 'lock',
      title: 'Notebook not found',
      message: "This notebook doesn't exist, or you don't have access to it.",
      actions: S.masterMode
        ? [{ label: 'Back to dashboard', primary: true, href: 'master.html' }]
        : [{ label: 'New notebook', primary: true, href: 'index.html?new=1' }]
    });
  }

  async function boot() {
    if (!NB.preflight(root)) return;
    var params = new URLSearchParams(location.search);
    S.masterMode = params.get('mode') === 'master';
    S.client = NB.createClient(S.masterMode ? NB.KEY_MASTER : NB.KEY_USER);

    try {
      var sres = await S.client.auth.getSession();
      var session = sres.data && sres.data.session;

      if (S.masterMode) {
        // mode=master is only a REQUEST. Real authority is verified against the database.
        if (!session || session.user.is_anonymous) {
          location.replace('master.html?next=' + encodeURIComponent('index.html' + location.search));
          return;
        }
        S.user = session.user;
        S.isMaster = await NB.checkMaster(S.client, S.user.id);
        if (!S.isMaster) { showNotFound(); return; }
      } else {
        if (!session) {
          var r = await S.client.auth.signInAnonymously();
          if (r.error) {
            if (NB.isNetworkError(r.error)) { fatal("Can't reach the server", 'Check your internet connection and try again.', r.error.message); return; }
            fatal('Guest sign-in is turned off',
              'In Supabase open Authentication → Sign In / Providers and enable "Allow anonymous sign-ins", then reload this page.',
              r.error.message, [{ label: 'Reload', primary: true, onClick: function () { location.reload(); } }]);
            return;
          }
          session = r.data.session;
        }
        S.user = session.user;
      }

      S.client.auth.onAuthStateChange(function (ev, sess) {
        if (ev === 'SIGNED_OUT') { if (S.nbId) lockNotebook('You were signed out. Reload to continue.'); }
        else if (sess && sess.user) S.user = sess.user;
      });

      var id = params.get('notebook_id');
      var server = null;
      if (id) {
        if (!C.isUuid(id)) { showNotFound(); return; }
        server = await fetchServer(id);
        if (!server) { showNotFound(); return; }
      } else if (S.masterMode) {
        location.replace('master.html'); return;
      } else if (!params.get('new')) {
        var latest = await S.client.from('notebooks').select('id').eq('owner_id', S.user.id).is('deleted_at', null)
          .order('updated_at', { ascending: false }).limit(1);
        if (latest.error) throw latest.error;
        if (latest.data && latest.data.length) server = await fetchServer(latest.data[0].id);
      }

      buildUI();
      if (server) applyServer(server, { initial: true });
      else initNewDraft();
      afterLoad();
    } catch (e) {
      if (NB.isNetworkError(e)) fatal("Can't reach the server", 'Check your internet connection and try again.', e && e.message);
      else fatal('Something went wrong', 'The notebook could not be loaded.', (e && (e.message || e.code)) || String(e));
    }
  }

  /* ========================================================== server access */

  async function fetchServer(id) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var a = await S.client.from('notebooks').select('id, owner_id, filename, revision, updated_at, last_edited_by, deleted_at').eq('id', id).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data || a.data.deleted_at) return null;
      var c = await S.client.from('cells').select('id, cell_type, content, position, last_edited_by, updated_at').eq('notebook_id', id).order('position');
      if (c.error) throw c.error;
      var b = await S.client.from('notebooks').select('revision').eq('id', id).maybeSingle();
      if (b.error) throw b.error;
      if (b.data && b.data.revision !== a.data.revision) continue;   // saved while we were reading; read again
      return { nb: a.data, snap: { title: a.data.filename, cells: C.sortCells((c.data || []).map(C.cloneCell)) } };
    }
    throw new Error('The notebook keeps changing; please try again.');
  }

  /* ============================================================ state load */

  function initNewDraft() {
    S.nbId = null; S.ownerId = me(); S.revision = 0; S.seenRevision = 0;
    S.title = 'Untitled.ipynb';
    S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
    S.base = { title: undefined, cells: [] };
    S.dirty = false; S.lastSavedAt = null;
    els.title.value = S.title;
    document.title = S.title + ' - RStudio'; updateProject();
    syncDom(); selectCell(S.cells[0].id); setStatus();
  }

  function applyServer(server, o) {
    o = o || {};
    var nb = server.nb;
    S.nbId = nb.id; S.ownerId = nb.owner_id; S.revision = nb.revision; S.seenRevision = Math.max(S.seenRevision, nb.revision);
    S.title = nb.filename;
    S.cells = server.snap.cells.map(C.cloneCell);
    if (!S.cells.length) S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
    S.base = cloneSnap(server.snap);
    S.dirty = false; S.editVersion++;
    S.lastEditedBy = nb.last_edited_by; S.lastEditedAt = nb.updated_at;
    if (!o.initial) { S.lastSavedAt = S.lastSavedAt; }
    els.title.value = S.title;
    document.title = S.title + ' - RStudio'; updateProject();
    hideBanner('remote'); hideBanner('conflict'); S.pendingConflict = false; S.autosavePaused = false;
    syncDom();
    if (!S.selectedId || !getCell(S.selectedId)) selectCell(S.cells[0].id); else markSelected();
    writeDraftNow();
    setStatus();
  }

  function afterLoad() {
    window.addEventListener('keydown', onGlobalKey, true);
    window.addEventListener('beforeunload', function (e) {
      if (S.dirty && !S.skipUnload && !S.readOnly) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden && S.dirty) save({ auto: true }); });
    window.addEventListener('online', function () { setStatus(); if (S.dirty) save({ auto: true }); });
    window.addEventListener('offline', setStatus);
    document.addEventListener('mousedown', function (e) {
      if (S.menu && !S.menu.pop.contains(e.target) && !e.target.closest('.menu-btn')) closeMenu();
    });
    setInterval(refreshBadges, 60000);
    setInterval(pollServer, cfg.POLL_MS || 30000);      // safety net: catches deletions and missed realtime events

    if (S.nbId) subscribeRealtime();
    loadProfile();
    if (S.masterMode) showMasterBanner();
    checkDraft();
    focusEditor();
  }

  async function loadProfile() {
    try {
      var r = await S.client.from('profiles').select('display_name').eq('id', S.user.id).maybeSingle();
      if (!r.error && r.data) S.profileName = r.data.display_name || '';
    } catch (e) { /* ignore */ }
    updateAvatar();
  }

  async function showMasterBanner() {
    var name = '';
    if (S.ownerId && S.ownerId !== me()) {
      try {
        var r = await S.client.from('profiles').select('display_name').eq('id', S.ownerId).maybeSingle();
        if (r.data && r.data.display_name) name = r.data.display_name;
      } catch (e) { /* ignore */ }
    }
    S.ownerName = name || ('Guest ' + NB.shortId(S.ownerId));
    showBanner('master', h('div', { class: 'banner info' },
      NB.icon('lock', 18),
      h('span', { class: 'grow', text: 'Master mode — you are editing ' + (S.ownerId === me() ? 'your own notebook' : S.ownerName + '’s notebook') + '. Your edits are marked on each cell.' }),
      h('a', { class: 'btn btn-text', href: 'master.html', text: 'Back to dashboard' })
    ));
  }

  /* ================================================================ banners */

  function showBanner(key, node) {
    hideBanner(key);
    node.dataset.bannerKey = key;
    els.banners.appendChild(node);
  }
  function hideBanner(key) {
    if (!els.banners) return;
    var old = els.banners.querySelector('[data-banner-key="' + key + '"]');
    if (old) old.remove();
  }

  /* ================================================================== save */

  function setStatus() {
    if (!els.status) return;
    var st, text, tip = '';
    var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (S.readOnly) { st = 'readonly'; text = S.readOnlyReason || 'Read-only'; }
    else if (S.saving) { st = 'saving'; text = 'Saving…'; }
    else if (S.saveError) { st = (S.saveError.offline || offline) ? 'offline' : 'error'; text = st === 'offline' ? 'Offline — will retry' : 'Couldn’t save — Retry'; tip = S.saveError.message || ''; }
    else if (S.dirty && offline) { st = 'offline'; text = 'Offline — changes not saved'; }
    else if (S.dirty) { st = 'dirty'; text = 'Unsaved changes'; }
    else if (!S.nbId) { st = 'new'; text = 'Not saved yet — press Ctrl+S'; }
    else {
      st = 'saved'; text = 'All changes saved';
      var when = S.lastSavedAt || S.lastEditedAt;
      if (when) tip = 'Last saved ' + NB.absTime(when) + (S.lastEditedBy && S.lastEditedBy !== S.ownerId ? ' (last edit by master)' : '');
    }
    els.status.dataset.state = st;
    els.statusText.textContent = text;
    els.status.title = tip;
    els.status.setAttribute('aria-label', text);
  }

  function markDirty() {
    if (S.readOnly) return;
    S.dirty = true; S.editVersion++;
    setStatus();
    scheduleAutosave();
    scheduleDraft();
  }

  function scheduleAutosave() {
    clearTimeout(S.saveTimer);
    if (!cfg.AUTOSAVE_MS || S.autosavePaused || S.readOnly) return;
    S.saveTimer = setTimeout(function () { save({ auto: true }); }, cfg.AUTOSAVE_MS);
  }

  function draftKey() { return 'nb-draft:' + (me() || 'x') + ':' + (S.nbId || 'new'); }
  function scheduleDraft() { clearTimeout(S.draftTimer); S.draftTimer = setTimeout(writeDraftNow, 500); }
  function writeDraftNow() {
    try {
      var k = draftKey();
      if (!S.dirty) { localStorage.removeItem(k); return; }
      localStorage.setItem(k, JSON.stringify({
        v: 1, ts: Date.now(), baseRevision: S.revision, title: S.title,
        cells: S.cells.map(function (c) { return { id: c.id, cell_type: c.cell_type, content: c.content, position: c.position }; })
      }));
    } catch (e) { /* storage unavailable: fine */ }
  }
  function checkDraft() {
    try {
      var raw = localStorage.getItem(draftKey());
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || !Array.isArray(d.cells)) return;
      if (S.nbId && d.baseRevision !== S.revision) { localStorage.removeItem(draftKey()); return; }
      var same = d.title === S.title && d.cells.length === S.cells.length && d.cells.every(function (c) {
        var cur = getCell(c.id); return cur && cur.content === c.content && cur.cell_type === c.cell_type && cur.position === c.position;
      });
      if (same) { localStorage.removeItem(draftKey()); return; }
      showBanner('draft', h('div', { class: 'banner info' },
        NB.icon('info', 18),
        h('span', { class: 'grow', text: 'Recovered unsaved changes from ' + NB.relTime(d.ts) + '.' }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Restore', on: { click: function () {
          S.title = C.normalizeTitle(d.title);
          S.cells = C.finalizeCells(d.cells.filter(function (c) { return c && C.isUuid(c.id) && (c.cell_type === 'code' || c.cell_type === 'text'); })
            .map(function (c) { var o = C.cloneCell(c); o.last_edited_by = me(); o.updated_at = nowIso(); o.content = String(c.content || '').slice(0, 100000); return o; }));
          if (!S.cells.length) S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
          els.title.value = S.title; syncDom(); markDirty(); hideBanner('draft');
        } } }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Discard', on: { click: function () {
          try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ }
          hideBanner('draft');
        } } })
      ));
    } catch (e) { /* ignore corrupt drafts */ }
  }

  async function ensureNotebook() {
    if (S.nbId) return;
    var r = await S.client.rpc('create_notebook', { p_filename: S.title });
    if (r.error) throw r.error;
    try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ }
    S.nbId = r.data.id; S.ownerId = me(); S.revision = r.data.revision; S.seenRevision = r.data.revision;
    S.base = { title: S.title, cells: [] };
    try { history.replaceState(null, '', location.pathname + '?notebook_id=' + S.nbId + (S.masterMode ? '&mode=master' : '')); } catch (e) { /* ignore */ }
    subscribeRealtime();
  }

  async function save(opts) {
    opts = opts || {};
    if (S.readOnly) return;
    commitTitle();
    if (S.saving) { S.saveAgain = true; return; }
    if (!S.dirty && S.nbId) { if (opts.manual) NB.toast('All changes saved'); return; }
    if (!S.dirty && !S.nbId && !opts.manual) return;
    if (opts.manual) { S.autosavePaused = false; hideBanner('conflict'); }

    S.saving = true; S.saveError = null;
    clearTimeout(S.saveTimer); clearTimeout(S.retryTimer);
    setStatus();
    try {
      await ensureNotebook();
      var tries = 0;
      for (;;) {
        var snap = snapshot(), ver = S.editVersion;
        var r = await S.client.rpc('save_notebook', {
          p_notebook_id: S.nbId, p_expected_revision: S.revision, p_filename: snap.title,
          p_cells: snap.cells.map(function (c) { return { id: c.id, cell_type: c.cell_type, content: c.content, position: c.position }; })
        });
        if (r.error) throw r.error;
        if (r.data && r.data.status === 'ok') {
          S.revision = r.data.revision; S.seenRevision = Math.max(S.seenRevision, S.revision);
          S.base = cloneSnap(snap);
          S.lastSavedAt = new Date(); S.lastEditedBy = me();
          S.dirty = S.editVersion !== ver;
          S.retryCount = 0; S.saveError = null;
          if (opts.manual) NB.toast('Saved', { kind: 'ok', timeout: 1500 });
          writeDraftNow();
          break;
        }
        // revision mismatch: someone else saved first
        var resolved = await handleConflict(opts);
        if (!resolved) break;
        if (++tries >= 4) { S.saveError = { message: 'This notebook keeps changing. Try again in a moment.' }; break; }
      }
    } catch (e) {
      await handleSaveError(e, opts);
    } finally {
      S.saving = false;
      setStatus();
      if (S.dirty && !S.saveError && !S.readOnly && !S.autosavePaused) {
        if (S.saveAgain) { S.saveAgain = false; save({ auto: true }); } else scheduleAutosave();
      }
      S.saveAgain = false;
      if (S.seenRevision > S.revision && !S.readOnly) scheduleRefresh();
    }
  }

  async function handleSaveError(e, opts) {
    var code = e && e.code, msg = (e && (e.message || e.details)) || 'Unknown error';
    if (code === 'P0002') { lockNotebook('This notebook is no longer available.'); return; }
    if (code === '54000') { S.saveError = { message: 'Notebook limit reached (20). Delete one first.' }; NB.toast('You have reached the 20-notebook limit.', { kind: 'error' }); return; }
    var offline = NB.isNetworkError(e);
    if ((code === '28000' || e.status === 401 || /jwt/i.test(msg)) && !opts.retriedAuth) {
      try {
        var rr = await S.client.auth.refreshSession();
        if (!rr.error && rr.data && rr.data.session) { S.user = rr.data.session.user; S.saving = false; return save(Object.assign({}, opts, { retriedAuth: true })); }
      } catch (e2) { /* fall through */ }
      S.saveError = { message: 'Your session expired. Your changes are kept here — reload to sign in again.' };
      return;
    }
    S.saveError = { message: offline ? 'You appear to be offline.' : msg, offline: offline };
    S.retryCount++;
    if (S.retryCount <= 6) {
      var delay = Math.min(30000, 2000 * Math.pow(2, S.retryCount - 1));
      clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(function () { S.saveError = null; save({ auto: true }); }, delay);
    }
  }

  /* ----------------------------------------------------- conflict handling */

  async function handleConflict(opts) {
    var server = await fetchServer(S.nbId);
    if (!server) { lockNotebook('This notebook was deleted or is no longer available.'); return false; }
    var merged = C.mergeNotebooks(S.base, snapshot(), server.snap);

    if (merged.conflicts.length) {
      if (opts.auto) {
        // never interrupt typing with a dialog: park it behind a banner
        S.autosavePaused = true;
        showConflictBanner();
        return false;
      }
      var choices = await openConflictModal(merged.conflicts);
      if (!choices) { S.autosavePaused = true; showConflictBanner(); return false; }
      applyMerged(C.resolveConflicts(merged, choices), server);
      hideBanner('conflict'); S.autosavePaused = false;
      return true;
    }
    applyMerged({ title: merged.title, cells: merged.cells }, server);
    if (merged.serverChanged) NB.toast(S.masterMode ? 'Merged the latest changes from the owner' : 'Merged the latest changes from master');
    return true;
  }

  function applyMerged(fin, server) {
    S.revision = server.nb.revision; S.seenRevision = Math.max(S.seenRevision, S.revision);
    S.base = cloneSnap(server.snap);
    S.title = fin.title; S.cells = fin.cells.map(C.cloneCell);
    if (!S.cells.length) S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
    els.title.value = S.title; document.title = S.title + ' - RStudio'; updateProject();
    S.dirty = true; S.editVersion++;
    syncDom(); markSelected();
  }

  function showConflictBanner() {
    showBanner('conflict', h('div', { class: 'banner' },
      NB.icon('warning', 18),
      h('span', { class: 'grow', text: 'Someone else changed cells you also edited. Autosave is paused until you choose which version to keep.' }),
      h('button', { class: 'btn btn-text', type: 'button', text: 'Resolve', on: { click: function () { save({ manual: true }); } } })
    ));
    setStatus();
  }

  function whoLabel(uid) {
    if (uid && uid === me()) return 'you';
    if (uid && uid === S.ownerId) return 'the owner';
    return uid ? 'master' : 'unknown';
  }

  function openConflictModal(conflicts) {
    return new Promise(function (resolve) {
      var choices = {}, groups = [];
      var list = h('div', {});
      conflicts.forEach(function (c, idx) {
        choices[c.id] = 'local';
        var name = 'cf' + idx;
        var isTitle = c.id === '__title__';
        var kindText = c.kind === 'title' ? 'Notebook name' : c.kind === 'deleted-on-server' ? 'Cell deleted elsewhere, edited here'
          : c.kind === 'deleted-locally' ? 'Cell deleted here, edited elsewhere' : 'Cell edited in both places';
        function colText(v) { return isTitle ? String(v) : (v ? v.content : '(deleted)'); }
        function col(side, label, v, caption) {
          var input = h('input', { type: 'radio', name: name, value: side });
          if (side === 'local') input.checked = true;
          input.addEventListener('change', function () { choices[c.id] = side; });
          groups.push({ input: input, side: side });
          return h('div', { class: 'conflict-col' + (v === null || v === undefined ? ' gone' : '') },
            h('label', {}, input, h('span', { text: label }), caption ? h('small', { text: ' · ' + caption }) : null),
            h('pre', { text: colText(v) || '(empty)' }));
        }
        list.appendChild(h('div', { class: 'conflict-item' },
          h('div', { class: 'conflict-head' }, h('span', { text: kindText })),
          h('div', { class: 'conflict-cols' },
            col('local', 'Keep mine', c.local),
            col('server', 'Use latest saved', c.server, isTitle ? '' : 'edited by ' + whoLabel(c.server && c.server.last_edited_by))
          )));
      });
      function bulk(side) { groups.forEach(function (g) { if (g.side === side) { g.input.checked = true; g.input.dispatchEvent(new Event('change')); } }); }
      var content = h('div', {},
        h('p', { class: 'modal-text', text: 'These items were changed both by you and by someone else since you last saved. Pick the version to keep for each one. Everything else was merged automatically.' }),
        h('div', { style: { display: 'flex', gap: '8px', margin: '12px 0' } },
          h('button', { class: 'btn btn-outline', type: 'button', text: 'Keep all mine', on: { click: function () { bulk('local'); } } }),
          h('button', { class: 'btn btn-outline', type: 'button', text: 'Use all latest saved', on: { click: function () { bulk('server'); } } })),
        list);
      var done = false;
      NB.openModal({
        title: 'Resolve conflicting changes', content: content, wide: true, dismissable: false,
        buttons: [
          { label: 'Decide later', kind: 'text', onClick: function (close) { done = true; resolve(null); close(); } },
          { label: 'Apply and save', kind: 'primary', onClick: function (close) { done = true; resolve(choices); close(); } }
        ],
        onClose: function () { if (!done) resolve(null); }
      });
    });
  }

  /* -------------------------------------------------------------- realtime */

  function subscribeRealtime() {
    if (!S.nbId || S.channel) return;
    try {
      var ch = S.client.channel('nb:' + S.nbId + ':' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notebooks', filter: 'id=eq.' + S.nbId }, onNotebookEvent)
        .subscribe(function (status) {
          var on = status === 'SUBSCRIBED';
          if (!on && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) S.hadDisconnect = true;
          if (on && S.hadDisconnect) { S.hadDisconnect = false; scheduleRefresh(); }   // catch up on anything missed
          S.live = on; updateLive();
        });
      S.channel = ch;
    } catch (e) { /* realtime is a nice-to-have; saving still works */ }
  }

  function unsubscribeRealtime() {
    try { if (S.channel) S.client.removeChannel(S.channel); } catch (e) { /* ignore */ }
    S.channel = null; S.live = false; updateLive();
  }

  function updateLive() {
    if (!els.live) return;
    els.live.classList.toggle('on', S.live);
    els.live.textContent = S.live ? 'Live' : 'Offline';
    els.live.title = S.live ? 'Receiving live updates' : 'Not receiving live updates';
  }

  function onNotebookEvent(p) {
    var n = (p && p.new) || {};
    if ((p && p.eventType === 'DELETE') || n.deleted_at) { lockNotebook('This notebook was deleted.'); return; }
    if (typeof n.revision === 'number') {
      S.seenRevision = Math.max(S.seenRevision, n.revision);
      if (S.saving) return;                    // our own save is in flight; re-checked when it finishes
      if (n.revision <= S.revision) return;    // echo of our own save
    }
    scheduleRefresh();
  }

  async function pollServer() {
    if (!S.nbId || S.readOnly || S.saving || S.refreshing || document.hidden) return;
    try {
      var r = await S.client.from('notebooks').select('id, revision, deleted_at').eq('id', S.nbId).maybeSingle();
      if (r.error) return;
      if (!r.data || r.data.deleted_at) { lockNotebook('This notebook was deleted or is no longer available.'); return; }
      S.seenRevision = Math.max(S.seenRevision, r.data.revision);
      if (r.data.revision > S.revision) scheduleRefresh();
    } catch (e) { /* try again next tick */ }
  }

  function scheduleRefresh() {
    clearTimeout(S.refreshTimer);
    S.refreshTimer = setTimeout(refreshFromServer, 250);
  }

  async function refreshFromServer() {
    if (!S.nbId || S.readOnly) return;
    if (S.refreshing || S.saving) { S.refreshAgain = true; return; }
    S.refreshing = true;
    try {
      var server = await fetchServer(S.nbId);
      if (!server) { lockNotebook('This notebook was deleted or is no longer available.'); return; }
      if (server.nb.revision <= S.revision) return;
      var who = whoLabel(server.nb.last_edited_by);
      var text = who === 'master' ? 'Master updated this notebook' : who === 'the owner' ? 'The owner updated this notebook' : 'Updated from another tab or device';
      if (!S.dirty) {
        applyServer(server);
        NB.toast(text);
      } else {
        var merged = C.mergeNotebooks(S.base, snapshot(), server.snap);
        if (merged.conflicts.length) { S.autosavePaused = true; showConflictBanner(); }
        else { applyMerged({ title: merged.title, cells: merged.cells }, server); NB.toast(text + ' — merged with your edits'); }
      }
    } catch (e) { /* will retry on next event */ }
    finally {
      S.refreshing = false;
      if (S.refreshAgain) { S.refreshAgain = false; scheduleRefresh(); }
    }
  }

  function lockNotebook(reason) {
    S.readOnly = true; S.readOnlyReason = 'Read-only';
    clearTimeout(S.saveTimer); clearTimeout(S.retryTimer);
    unsubscribeRealtime();
    if (els.cellsRoot) els.cellsRoot.classList.add('readonly');
    if (els.title) els.title.readOnly = true;
    Array.prototype.forEach.call(document.querySelectorAll('.cell textarea'), function (t) { t.readOnly = true; });
    showBanner('locked', h('div', { class: 'banner danger' },
      NB.icon('lock', 18), h('span', { class: 'grow', text: reason }),
      h('a', { class: 'btn btn-text', href: S.masterMode ? 'master.html' : 'index.html?new=1', text: S.masterMode ? 'Back to dashboard' : 'New notebook' })));
    setStatus();
  }

  /* ================================================================ titles */

  function commitTitle() {
    if (!els.title) return;
    var t = C.normalizeTitle(els.title.value);
    var changed = t !== S.title;
    S.title = t; els.title.value = t; document.title = t + ' - RStudio'; updateProject();
    if (changed && !S.readOnly) markDirty();
  }
  function onTitleInput() { if (!S.readOnly && els.title.value !== S.title) markDirty(); }
  function onTitleKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitTitle(); els.title.blur(); }
    else if (e.key === 'Escape') { els.title.value = S.title; els.title.blur(); }
  }


  /* ============================================================ cell model */

  function normalizeIfNeeded() { if (C.needsNormalize(S.cells)) S.cells = C.normalizePositions(S.cells); }

  function insertCell(type, index, o) {
    if (S.readOnly) return null;
    var cell = { id: C.uuid(), cell_type: type, content: '', position: C.positionFor(S.cells, index), last_edited_by: me(), updated_at: nowIso() };
    S.cells.splice(index, 0, cell);
    normalizeIfNeeded();
    syncDom(); markDirty();
    selectCell(cell.id, { focus: !o || o.focus !== false, scroll: true });
    return cell;
  }

  function insertAfter(afterId, type) {
    var idx = afterId ? indexOfCell(afterId) + 1 : 0;
    insertCell(type, idx);
  }

  function deleteCell(id) {
    if (S.readOnly) return;
    var idx = indexOfCell(id); if (idx < 0) return;
    var c = S.cells.splice(idx, 1)[0];
    S.deleted.push({ cell: c, index: idx }); if (S.deleted.length > 30) S.deleted.shift();
    delete S.outputs[id]; delete S.running[id];
    syncDom(); markDirty();
    var next = S.cells[Math.min(idx, S.cells.length - 1)];
    if (next) selectCell(next.id); else S.selectedId = null;
    NB.toast('File closed', { action: { label: 'Reopen', onClick: undoDelete } });
  }

  function undoDelete() {
    if (S.readOnly) return;
    var d = S.deleted.pop(); if (!d) { NB.toast('No closed file to reopen'); return; }
    var idx = Math.min(d.index, S.cells.length);
    S.cells.splice(idx, 0, d.cell);
    S.cells = C.finalizeCells(S.cells);
    syncDom(); markDirty(); selectCell(d.cell.id, { scroll: true });
  }

  function moveCell(id, dir) {
    if (S.readOnly) return;
    var idx = indexOfCell(id), to = idx + dir;
    if (idx < 0 || to < 0 || to >= S.cells.length) return;
    var c = S.cells.splice(idx, 1)[0];
    c.position = C.positionFor(S.cells, to);
    c.last_edited_by = me(); c.updated_at = nowIso();
    S.cells.splice(to, 0, c);
    normalizeIfNeeded();
    syncDom(); markDirty(); selectCell(id, { scroll: true });
  }

  function duplicateCell(id) {
    var src = getCell(id); if (!src || S.readOnly) return;
    var idx = indexOfCell(id) + 1;
    var cell = { id: C.uuid(), cell_type: src.cell_type, content: src.content, position: C.positionFor(S.cells, idx), last_edited_by: me(), updated_at: nowIso() };
    S.cells.splice(idx, 0, cell); normalizeIfNeeded();
    syncDom(); markDirty(); selectCell(cell.id, { scroll: true });
  }

  function convertCell(id, type) {
    var c = getCell(id); if (!c || c.cell_type === type || S.readOnly) return;
    c.cell_type = type; c.last_edited_by = me(); c.updated_at = nowIso();
    delete S.outputs[id];
    syncDom(); markDirty(); selectCell(id);
  }


  /* ======================================================= editor: one tab per cell */

  function tabName(i) { return 'Untitled' + (i + 1); }

  function baseCell(id) {
    var b = S.base && S.base.cells;
    if (!b) return null;
    for (var i = 0; i < b.length; i++) if (b[i].id === id) return b[i];
    return null;
  }

  /** RStudio shows an unsaved document as a red tab with an asterisk. */
  function cellDirty(c) {
    var b = baseCell(c.id);
    return (b ? b.content : '') !== c.content || (!!b && b.cell_type !== c.cell_type);
  }

  function lineCount(v) { var n = 1, i = -1; while ((i = v.indexOf('\n', i + 1)) !== -1) n++; return n; }

  function createWrap(cell) {
    var code = h('code');
    var pre = h('pre', { 'aria-hidden': 'true' }, code);
    var ta = h('textarea', {
      class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
      wrap: 'off', 'aria-label': 'Source editor', rows: '1', maxlength: '100000'
    });
    var gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
    var notice = h('div', { class: 'ed-notice' });
    var cellEl = h('div', { class: 'cell', tabindex: '-1', data: { id: cell.id } },
      gutter, h('div', { class: 'code-editor' }, pre, ta));
    return h('div', { class: 'cell-wrap', data: { id: cell.id, type: cell.cell_type } }, notice, cellEl);
  }

  function paintEditor(wrap, cell) {
    var code = wrap.querySelector('.code-editor code'), v = cell.content;
    var tail = (v === '' || v.slice(-1) === '\n') ? ' ' : '';
    if (cell.cell_type === 'code') code.innerHTML = window.RMock.highlight(v) + tail;
    else code.textContent = v + tail;
    wrap.querySelector('.code-editor').classList.toggle('plain', cell.cell_type !== 'code');
    var n = lineCount(v);
    if (wrap._lines !== n) {
      var nums = []; for (var i = 1; i <= n; i++) nums.push(i);
      wrap.querySelector('.ed-gutter').textContent = nums.join('\n');
      wrap._lines = n;
    }
  }

  function badgeText(cell) {
    if (!cell.last_edited_by || !S.ownerId || cell.last_edited_by === S.ownerId) return '';
    return (cell.last_edited_by === me() ? 'Edited by you as master' : 'Edited by master') + (cell.updated_at ? ' · ' + NB.relTime(cell.updated_at) : '');
  }

  function paintNotice(wrap, cell) {
    var bt = badgeText(cell), n = wrap.querySelector('.ed-notice');
    n.textContent = bt; n.classList.toggle('show', !!bt);
  }

  function refreshCellEl(wrap, cell) {
    var ta = wrap.querySelector('textarea');
    var focused = document.activeElement === ta;
    if (ta.value !== cell.content) {
      var pos = ta.selectionStart;
      ta.value = cell.content;
      if (focused) { try { var p = Math.min(pos, cell.content.length); ta.setSelectionRange(p, p); } catch (e) { /* ignore */ } }
    }
    ta.readOnly = S.readOnly;
    paintEditor(wrap, cell);
    paintNotice(wrap, cell);
  }

  function syncDom() {
    var container = els.cells;
    var want = {};
    S.cells.forEach(function (c) { want[c.id] = true; });
    Array.prototype.slice.call(container.children).forEach(function (w) { if (!want[w.dataset.id]) w.remove(); });
    var prev = null;
    S.cells.forEach(function (cell) {
      var wrap = wrapOf(cell.id);
      if (wrap && wrap.dataset.type !== cell.cell_type) { wrap.remove(); wrap = null; }
      if (!wrap) wrap = createWrap(cell);
      var expected = prev ? prev.nextSibling : container.firstChild;
      if (wrap !== expected) container.insertBefore(wrap, expected);
      refreshCellEl(wrap, cell);
      prev = wrap;
    });
    if (S.selectedId && !getCell(S.selectedId)) S.selectedId = S.cells.length ? S.cells[0].id : null;
    if (els.editor) els.editor.classList.toggle('empty-ed', !S.cells.length);
    markSelected();
    refreshSide('files');
  }

  function refreshBadges() {
    S.cells.forEach(function (c) { var w = wrapOf(c.id); if (w) paintNotice(w, c); });
  }

  /* ------------------------------------------------------------ tab strip */

  function updateTabs() {
    if (!els.tabList) return;
    var sig = S.cells.map(function (c) { return c.id + c.cell_type; }).join('|');
    if (els.tabList._sig !== sig) {
      els.tabList._sig = sig;
      els.tabList.textContent = '';
      S.cells.forEach(function (c) {
        els.tabList.appendChild(h('div', { class: 'rs-tab', role: 'tab', data: { id: c.id } },
          (function () { var d = RI.el(c.cell_type === 'code' ? 'doc' : 'docText'); d.classList.add('doc'); return d; })(),
          h('span', { class: 't' }),
          h('button', { class: 'x', type: 'button', title: 'Close', 'aria-label': 'Close tab', data: { close: c.id } }, RI.el('close', 10))));
      });
    }
    S.cells.forEach(function (c, i) {
      var tab = els.tabList.children[i]; if (!tab) return;
      var dirty = cellDirty(c);
      tab.classList.toggle('dirty', dirty);
      tab.classList.toggle('active', c.id === S.selectedId);
      tab.setAttribute('aria-selected', String(c.id === S.selectedId));
      var t = tab.querySelector('.t'), txt = tabName(i) + (dirty ? '*' : '');
      if (t.textContent !== txt) t.textContent = txt;
    });
  }

  function onTabClick(e) {
    var x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); deleteCell(x.dataset.close); return; }
    var tab = e.target.closest('.rs-tab');
    if (tab) selectCell(tab.dataset.id, { focus: true });
  }
  function onTabAux(e) {
    if (e.button !== 1) return;
    var tab = e.target.closest('.rs-tab');
    if (tab) { e.preventDefault(); deleteCell(tab.dataset.id); }
  }

  /* ------------------------------------------------------------- selection */

  function markSelected() {
    Array.prototype.forEach.call(els.cells.children, function (w) { w.classList.toggle('active', w.dataset.id === S.selectedId); });
    updateTabs();
    updateCursor();
  }

  function selectCell(id, o) {
    o = o || {};
    S.selectedId = id; markSelected();
    var w = wrapOf(id); if (!w) return;
    if (o.focus || o.focusCell) { try { w.querySelector('textarea').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    if (o.scroll) ensureCaretVisible();
    updateCursor();
  }

  function startEdit(id) { var w = wrapOf(id); if (w && !S.readOnly) w.querySelector('textarea').focus(); }
  function stopEdit() { /* RStudio has no preview mode: nothing to do */ }

  function focusEditor() {
    var w = wrapOf(S.selectedId);
    if (w) { try { w.querySelector('textarea').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  function currentTa() { var w = wrapOf(S.selectedId); return w ? w.querySelector('textarea') : null; }

  /* ------------------------------------------------- status bar and caret */

  function updateCursor() {
    if (!els.cursorPos) return;
    var cell = getCell(S.selectedId), ta = currentTa();
    if (!cell || !ta) { els.cursorPos.textContent = ''; els.fileType.textContent = ''; return; }
    var pos = ta.selectionStart || 0, before = ta.value.slice(0, pos);
    var line = lineCount(before), col = pos - (before.lastIndexOf('\n') + 1) + 1;
    els.cursorPos.textContent = line + ':' + col;
    els.fileType.textContent = cell.cell_type === 'code' ? 'R Script' : 'Text File';
  }

  var charW = 0;
  function measureChar() {
    if (charW) return charW;
    var s = h('span', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', font: '16.75px "Lucida Console", Consolas, "DejaVu Sans Mono", monospace' } });
    var ce = els.cells.querySelector('.code-editor');
    if (ce) { var cs = getComputedStyle(ce.querySelector('textarea')); s.style.font = cs.font; }
    s.textContent = new Array(101).join('x');
    document.body.appendChild(s); charW = s.getBoundingClientRect().width / 100; s.remove();
    return charW || 10;
  }

  function ensureCaretVisible() {
    var ta = currentTa(), sc = els.editorScroll; if (!ta || !sc) return;
    var before = ta.value.slice(0, ta.selectionStart), line = lineCount(before) - 1, col = ta.selectionStart - (before.lastIndexOf('\n') + 1);
    var top = line * 19, bottom = top + 19;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (bottom > sc.scrollTop + sc.clientHeight - 20) sc.scrollTop = bottom - sc.clientHeight + 20;
    var left = 55 + 7 + col * measureChar();
    if (left < sc.scrollLeft + 55 + 20) sc.scrollLeft = Math.max(0, left - 55 - 40);
    else if (left > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = left - sc.clientWidth + 80;
  }

  /* ---------------------------------------------------------- editor events */

  function onCellsInput(e) {
    var ta = e.target; if (!ta.matches || !ta.matches('textarea')) return;
    var wrap = ta.closest('.cell-wrap'); if (!wrap) return;
    var cell = getCell(wrap.dataset.id); if (!cell || S.readOnly) return;
    cell.content = ta.value; cell.last_edited_by = me(); cell.updated_at = nowIso();
    paintEditor(wrap, cell);
    paintNotice(wrap, cell);
    markDirty();
    updateCursor(); ensureCaretVisible();
  }

  function onCellsFocusIn(e) {
    var wrap = e.target.closest && e.target.closest('.cell-wrap'); if (!wrap) return;
    if (S.selectedId !== wrap.dataset.id) selectCell(wrap.dataset.id);
  }

  function onCellsFocusOut() { /* nothing: RStudio keeps the caret position */ }

  function onCaretMove() { updateCursor(); }

  /* ------------------------------------------------------------ text helpers */

  var PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  var INDENT = '  ';

  function onCellKey(e) {
    var ta = e.target; if (!ta.matches || !ta.matches('textarea')) return;
    var wrap = ta.closest('.cell-wrap'); if (!wrap) return;
    var id = wrap.dataset.id, cell = getCell(id); if (!cell) return;
    var isCode = cell.cell_type === 'code', mod = e.ctrlKey || e.metaKey;

    // Run line / selection (RStudio: Ctrl+Enter, Alt+Enter keeps the cursor where it is)
    if (e.key === 'Enter' && mod && !e.shiftKey) { e.preventDefault(); runSelection({ advance: true }); return; }
    if (e.key === 'Enter' && e.altKey && !mod) { e.preventDefault(); runSelection({ advance: false }); return; }
    if (S.readOnly) return;
    if (e.key === 'Tab' && !mod && !e.altKey) { e.preventDefault(); indentSelection(ta, e.shiftKey); return; }
    if (isCode && e.key === '/' && mod) { e.preventDefault(); toggleComment(ta); return; }

    if (!isCode || mod || e.altKey) return;
    var v = ta.value, s = ta.selectionStart, en = ta.selectionEnd, next = v.charAt(en), prev = v.charAt(s - 1);

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var before = v.slice(0, s), line = before.slice(before.lastIndexOf('\n') + 1);
      var indent = /^[ \t]*/.exec(line)[0];
      var opens = /[{(\[]\s*$/.test(line), closes = /^[}\])]/.test(next);
      if (opens) indent += INDENT;
      if (opens && closes && s === en) {                      // {|}  ->  {\n  |\n}
        var base = /^[ \t]*/.exec(line)[0];
        insertText(ta, '\n' + indent + '\n' + base);
        var p = s + 1 + indent.length; ta.setSelectionRange(p, p);
      } else insertText(ta, '\n' + indent);
      return;
    }
    if (e.key === 'Backspace' && s === en && PAIRS[prev] && PAIRS[prev] === next) {   // delete both halves of an empty pair
      e.preventDefault(); replaceRange(ta, s - 1, s + 1, '', s - 1, s - 1); return;
    }
    if (PAIRS[e.key] !== undefined && s === en && !e.isComposing) {
      var q = e.key === '"' || e.key === "'";
      if (q && next === e.key) { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); updateCursor(); return; }   // type over the closing quote
      if (q && /[\w.]/.test(prev)) return;                                                                          // apostrophe inside a word
      if (!next || /[\s)\]};,]/.test(next)) {
        e.preventDefault(); insertText(ta, e.key + PAIRS[e.key]); ta.setSelectionRange(s + 1, s + 1); return;
      }
    }
    if ((e.key === ')' || e.key === ']' || e.key === '}') && s === en && next === e.key) {
      e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); updateCursor();
    }
  }

  function insertText(ta, text) {
    var ok = false;
    try { ok = document.execCommand && document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function replaceRange(ta, start, end, text, selStart, selEnd) {
    ta.setSelectionRange(start, end);
    var ok = false;
    try { ok = document.execCommand && document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) { ta.setRangeText(text, start, end, 'preserve'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    ta.setSelectionRange(selStart, selEnd);
  }

  function lineBounds(ta) {
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var start = v.lastIndexOf('\n', s - 1) + 1;
    var endIdx = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    return { start: start, end: endIdx === -1 ? v.length : endIdx };
  }

  function indentSelection(ta, outdent) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    if (!outdent && s === e) { insertText(ta, INDENT); return; }
    var b = lineBounds(ta), block = v.slice(b.start, b.end), lines = block.split('\n'), delta0 = 0, total = 0;
    var out = lines.map(function (l, i) {
      var nl;
      if (outdent) { var m = /^( {1,2}|\t)/.exec(l); nl = m ? l.slice(m[0].length) : l; }
      else nl = l.length ? INDENT + l : l;
      var d = nl.length - l.length; if (i === 0) delta0 = d; total += d; return nl;
    }).join('\n');
    replaceRange(ta, b.start, b.end, out, Math.max(b.start, s + delta0), e + total);
  }

  function toggleComment(ta) {
    var b = lineBounds(ta), v = ta.value, block = v.slice(b.start, b.end), lines = block.split('\n');
    var nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
    var allCommented = nonEmpty.length > 0 && nonEmpty.every(function (l) { return /^\s*#/.test(l); });
    var s = ta.selectionStart, e = ta.selectionEnd, delta0 = 0, total = 0;
    var out = lines.map(function (l, i) {
      var nl;
      if (allCommented) nl = l.replace(/^(\s*)# ?/, '$1');
      else nl = l.trim() === '' ? l : l.replace(/^(\s*)/, '$1# ');
      var d = nl.length - l.length; if (i === 0) delta0 = d; total += d; return nl;
    }).join('\n');
    replaceRange(ta, b.start, b.end, out, Math.max(b.start, s + delta0), Math.max(b.start, e + total));
  }


  /* ================================================================== console */
  /*
   * The Console is a MOCK R session (see rruntime.js). Run / Source send code here and the
   * results are printed the way R prints them. Real R needs a separate server-side process.
   */

  var BANNER = [
    'R version 4.4.1 (2024-06-14 ucrt) -- "Race for Your Life"',
    'Copyright (C) 2024 The R Foundation for Statistical Computing',
    'Platform: x86_64-w64-mingw32/x64',
    '',
    'R is free software and comes with ABSOLUTELY NO WARRANTY.',
    'You are welcome to redistribute it under certain conditions.',
    "Type 'license()' or 'licence()' for distribution details.",
    '',
    'R is a collaborative project with many contributors.',
    "Type 'contributors()' for more information and",
    "'citation()' on how to cite R or R packages in publications.",
    '',
    "Type 'demo()' for some demos, 'help()' for on-line help, or",
    "'help.start()' for an HTML browser interface to help.",
    "Type 'q()' to quit R.",
    ''
  ];

  function conLine(k, t) {
    return h('div', { class: 'ln' + (k && k !== 'out' ? ' ' + k : ''), text: t === '' ? '​' : t });
  }

  function conScroll() { if (els.con) els.con.scrollTop = els.con.scrollHeight; }

  function conPush(lines) {
    if (!els.conLines) return;
    lines.forEach(function (l) { els.conLines.appendChild(conLine(l.k, l.t)); });
    while (els.conLines.children.length > 1500) els.conLines.removeChild(els.conLines.firstChild);
    conScroll();
  }

  function conClear() { if (els.conLines) { els.conLines.textContent = ''; conScroll(); } }

  function recordHistory(code) {
    window.RMock.splitStatements(code).forEach(function (s) {
      var t = s.text.trim();
      if (!s.blank && t && t.charAt(0) !== '#') S.hist.push(s.text);
    });
    if (S.hist.length > 500) S.hist.splice(0, S.hist.length - 500);
  }

  /** Runs code in the mock session. o.echo: show each statement after the prompt; o.sourceOf: "source('~/UntitledN.R')" style. */
  function consoleRun(code, o) {
    o = o || {};
    recordHistory(code);
    var out = [];
    if (o.sourceOf) out.push({ k: 'cmd', t: '> source("~/' + o.sourceOf + '.R"' + (o.echo ? ', echo = TRUE' : '') + ')' });
    var lines = window.RMock.run(code, S.env, { echo: !!o.echo, autoprint: !o.sourceOf || !!o.echo });
    conPush(out.concat(lines));
    S.lastRun = { code: code, o: o };
    refreshSide('env'); refreshSide('hist');
  }

  function conSubmit(text) {
    conPush([{ k: 'cmd', t: '> ' + text }]);
    if (text.trim()) {
      recordHistory(text);
      conPush(window.RMock.run(text, S.env, { echo: false }));
      refreshSide('env'); refreshSide('hist');
    }
  }

  /* --------------------------------------------------- running from the editor */

  /** Ctrl+Enter: run the selection, or the current line (and move to the next line). */
  function runSelection(o) {
    o = o || {};
    var ta = currentTa(), cell = getCell(S.selectedId);
    if (!ta || !cell) return;
    if (cell.cell_type !== 'code') { NB.toast('Only R scripts can be run'); return; }
    var s = ta.selectionStart, e = ta.selectionEnd, code, nextPos = null;
    if (e > s) code = ta.value.slice(s, e);
    else {
      var b = lineBounds(ta);
      code = ta.value.slice(b.start, b.end);
      // a statement that continues over several lines is run as a whole
      var all = ta.value.split('\n'), ln = ta.value.slice(0, s).split('\n').length - 1;
      var st = window.RMock.splitStatements(ta.value), acc = 0;
      for (var i = 0; i < st.length; i++) {
        var span = st[i].lines.length;
        if (ln >= acc && ln < acc + span && span > 1) { code = st[i].text; nextPos = all.slice(0, acc + span).join('\n').length + 1; break; }
        acc += span;
      }
      if (nextPos === null) nextPos = b.end + 1;
    }
    if (!code.trim()) { if (o.advance && nextPos !== null && nextPos <= ta.value.length) ta.setSelectionRange(nextPos, nextPos); updateCursor(); return; }
    consoleRun(code, { echo: true });
    if (o.advance && e === s && nextPos !== null) {
      var p = Math.min(nextPos, ta.value.length);
      ta.setSelectionRange(p, p); updateCursor(); ensureCaretVisible();
    }
  }

  /** Source (Ctrl+Shift+S) and Source with Echo (Ctrl+Shift+Enter): run the whole script. */
  function sourceCell(echo) {
    var cell = getCell(S.selectedId); if (!cell) return;
    if (cell.cell_type !== 'code') { NB.toast('Only R scripts can be sourced'); return; }
    consoleRun(cell.content, { echo: !!echo, sourceOf: tabName(indexOfCell(cell.id)) });
  }

  /** Code ▸ Run All (Ctrl+Alt+R): every line of the script, echoed. */
  function runAllLines() {
    var cell = getCell(S.selectedId); if (!cell || cell.cell_type !== 'code') return;
    consoleRun(cell.content, { echo: true });
  }

  function rerunPrevious() {
    if (!S.lastRun) { NB.toast('Nothing to re-run yet'); return; }
    consoleRun(S.lastRun.code, S.lastRun.o);
  }

  function interruptR() { conPush([{ k: 'note', t: '(interrupted)' }]); }

  function restartR() {
    S.env = {};
    conPush([{ k: 'out', t: '' }, { k: 'out', t: 'Restarting R session...' }, { k: 'out', t: '' }]);
    refreshSide('env');
  }

  function clearWorkspace() { S.env = {}; refreshSide('env'); }

  function saveDoc() {
    save({ manual: true });
    if (S.sourceOnSave) sourceCell(false);
  }

  function findInEditor() {
    var ta = currentTa(); if (!ta) return;
    var input = h('input', { class: 'input', type: 'text', placeholder: 'Find', 'data-autofocus': '1', value: S.findText || '' });
    function next(close) {
      var q = input.value; S.findText = q; if (!q) return;
      var hay = ta.value.toLowerCase(), needle = q.toLowerCase(), from = ta.selectionEnd;
      var i = hay.indexOf(needle, from); if (i < 0) i = hay.indexOf(needle);
      if (close) close();
      if (i < 0) { NB.toast('No matches found'); return; }
      ta.focus(); ta.setSelectionRange(i, i + q.length); updateCursor(); ensureCaretVisible();
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var m = document.querySelector('.modal-foot .btn-primary'); if (m) m.click(); } });
    NB.openModal({
      title: 'Find', content: h('div', {}, input),
      buttons: [{ label: 'Close', kind: 'text' }, { label: 'Find next', kind: 'primary', onClick: function (close) { next(close); } }]
    });
  }

  /* ================================================================== menus */

  function notAvailable(what) { NB.toast(what + ' isn’t available in this browser version'); }

  function currentIndex() { var i = indexOfCell(S.selectedId); return i < 0 ? S.cells.length - 1 : i; }

  function newScript(type) {
    if (S.readOnly) return;
    insertCell(type || 'code', S.cells.length);
  }

  function reopenClosed() { undoDelete(); }

  function execEdit(cmd) { focusEditor(); try { document.execCommand(cmd); } catch (e) { /* ignore */ } }

  function menuDefs() {
    var sel = S.selectedId, idx = indexOfCell(sel), ro = S.readOnly, isCode = idx >= 0 && S.cells[idx].cell_type === 'code';
    var none = idx < 0;
    var X = function (label) { return { label: label, disabled: true, run: function () {} }; };
    return {
      File: [
        { label: 'New File: R Script', kbd: 'Ctrl+Alt+Shift+N', run: function () { newScript('code'); }, disabled: ro },
        { label: 'New File: Text File', run: function () { newScript('text'); }, disabled: ro },
        { label: 'New Notebook', disabled: S.masterMode, run: function () { go('index.html?new=1'); } },
        { sep: true },
        { label: 'Open Notebook…', disabled: S.masterMode, run: openListModal },
        { label: 'Reopen Closed File', run: reopenClosed, disabled: ro || !S.deleted.length },
        { sep: true },
        { label: 'Save', kbd: 'Ctrl+S', run: saveDoc, disabled: ro },
        { label: 'Rename Notebook…', run: openRename, disabled: ro },
        { label: 'Export as .ipynb…', run: downloadIpynb },
        { sep: true },
        { label: 'Close File', run: function () { deleteCell(sel); }, disabled: ro || none },
        { label: 'Delete Notebook…', disabled: ro || !S.nbId, run: deleteNotebook },
        S.masterMode ? { sep: true } : null,
        S.masterMode ? { label: 'Back to Dashboard', run: function () { go('master.html'); } } : null
      ].filter(Boolean),
      Edit: [
        { label: 'Undo', kbd: 'Ctrl+Z', run: function () { execEdit('undo'); }, disabled: ro || none },
        { label: 'Redo', kbd: 'Ctrl+Shift+Z', run: function () { execEdit('redo'); }, disabled: ro || none },
        { sep: true },
        { label: 'Cut', kbd: 'Ctrl+X', run: function () { execEdit('cut'); }, disabled: ro || none },
        { label: 'Copy', kbd: 'Ctrl+C', run: function () { execEdit('copy'); }, disabled: none },
        { label: 'Select All', kbd: 'Ctrl+A', run: function () { execEdit('selectAll'); }, disabled: none },
        { sep: true },
        { label: 'Find…', kbd: 'Ctrl+F', run: findInEditor, disabled: none },
        { sep: true },
        { label: 'Clear Console', kbd: 'Ctrl+L', run: conClear }
      ],
      Code: [
        { label: 'Run Selected Line(s)', kbd: 'Ctrl+Enter', run: function () { focusEditor(); runSelection({ advance: true }); }, disabled: !isCode },
        { label: 'Re-Run Previous', kbd: 'Ctrl+Shift+P', run: rerunPrevious, disabled: !S.lastRun },
        { sep: true },
        { label: 'Source', kbd: 'Ctrl+Shift+S', run: function () { sourceCell(false); }, disabled: !isCode },
        { label: 'Source with Echo', kbd: 'Ctrl+Shift+Enter', run: function () { sourceCell(true); }, disabled: !isCode },
        { label: 'Run All', kbd: 'Ctrl+Alt+R', run: runAllLines, disabled: !isCode },
        { sep: true },
        { label: 'Comment/Uncomment Lines', kbd: 'Ctrl+/', run: function () { var ta = currentTa(); if (ta) { ta.focus(); toggleComment(ta); } }, disabled: ro || !isCode }
      ],
      View: [
        { label: 'Move Focus to Source', run: focusEditor, disabled: none },
        { label: 'Move Focus to Console', run: function () { if (els.conInput) els.conInput.focus(); } },
        { sep: true },
        { label: 'Zoom Source', run: function () { togglePaneMax(els.sourcePane); } },
        { label: 'Zoom Console', run: function () { togglePaneMax(els.consolePane); } }
      ],
      Plots: [X('Zoom Plot'), X('Save as Image…'), X('Save as PDF…'), X('Copy to Clipboard…'), { sep: true }, X('Remove Plot…'), X('Clear All…')],
      Session: [
        { label: 'New Session', disabled: true, run: function () {} },
        { sep: true },
        { label: 'Restart R', kbd: 'Ctrl+Shift+F10', run: restartR },
        { label: 'Interrupt R', run: interruptR },
        { sep: true },
        { label: 'Clear Workspace…', run: clearWorkspace }
      ],
      Build: [X('Install Package'), X('Test Package'), X('Check Package'), { sep: true }, X('Configure Build Tools…')],
      Debug: [X('Toggle Breakpoint'), X('Continue'), X('Stop'), { sep: true }, X('On Error')],
      Profile: [X('Start Profiling'), X('Stop Profiling'), { sep: true }, X('Open Profile…')],
      Tools: [
        { label: 'Keyboard Shortcuts Help', run: showShortcuts },
        { label: 'Your Profile…', run: openProfile },
        { sep: true },
        { label: 'Global Options…', run: function () { notAvailable('Global Options'); } }
      ],
      Help: [
        { label: 'RStudio Help', run: function () { notAvailable('RStudio Help'); } },
        { label: 'Keyboard Shortcuts Help', run: showShortcuts },
        { sep: true },
        { label: 'About RStudio Notebook', run: showAbout }
      ]
    };
  }

  /** Opens a drop-down menu under `anchor`. `key` toggles it closed when clicked twice. */
  function showMenu(anchor, key, items, alignRight) {
    closeMenu();
    var pop = h('div', { class: 'menu-pop', role: 'menu' }, items.map(function (it) {
      if (it.sep) return h('div', { class: 'menu-sep', role: 'separator' });
      return h('button', {
        class: 'menu-item', type: 'button', role: 'menuitem', disabled: !!it.disabled,
        on: { click: function () { closeMenu(); it.run(); } }
      }, h('span', { text: it.label }), it.kbd ? h('span', { class: 'kbd', text: it.kbd }) : null);
    }));
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    var left = alignRight ? r.right - pop.offsetWidth : r.left;
    pop.style.left = Math.max(2, Math.min(left, window.innerWidth - pop.offsetWidth - 2)) + 'px';
    pop.style.top = Math.min(r.bottom, window.innerHeight - pop.offsetHeight - 2) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    S.menu = { pop: pop, btn: anchor, name: key };
  }

  function openMenu(btn, name) { showMenu(btn, name, menuDefs()[name] || []); }

  function closeMenu() {
    if (!S.menu) return;
    S.menu.btn.setAttribute('aria-expanded', 'false');
    S.menu.pop.remove(); S.menu = null;
  }

  function dropdown(anchor, key, items) {
    if (S.menu && S.menu.name === key) { closeMenu(); return; }
    showMenu(anchor, key, items);
  }


  function go(url) {
    var go2 = function () { S.skipUnload = true; location.href = url; };
    if (S.dirty && !S.readOnly) save({ auto: true }).then(function () { if (S.dirty) { NB.confirm('Leave without saving?', 'Some changes could not be saved.', { okLabel: 'Leave', danger: true }).then(function (ok) { if (ok) go2(); }); } else go2(); });
    else go2();
  }


  /* ===================================================== toolbar + side-pane helpers */

  function tbtn(icon, label, o) {
    o = o || {};
    var b = h('button', {
      class: 'rs-btn' + (o.faded ? ' faded' : '') + (o.dis ? ' dis' : '') + (o.cls ? ' ' + o.cls : ''),
      type: 'button', title: o.title || '', 'aria-label': o.title || label || icon,
      on: o.on ? { click: o.on } : null
    });
    if (icon) b.appendChild(RI.el(icon, o.size));
    if (label) b.appendChild(h('span', { class: 'lbl' + (o.dim ? ' dim' : ''), text: label }));
    if (o.caret) b.appendChild(h('span', { class: 'ar' }));
    return b;
  }
  function sep(faint) { return h('span', { class: 'rs-sep' + (faint ? ' faint' : '') }); }
  function spacer() { return h('span', { class: 'rs-spacer' }); }
  function searchBox(placeholder) {
    return h('label', { class: 'rs-search' }, RI.el('search', 16), h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Search', placeholder: placeholder || '' }));
  }
  function noop() { /* decorative control */ }

  /**
   * Places controls at exact pixel positions inside a toolbar row (matches the reference screenshot).
   * list items: [element, leftEdgeInPagePixels, {sep, gap, size}] — x0 is the row's own left edge.
   */
  function placeRow(row, x0, list) {
    list.forEach(function (it) {
      var el = it[0], x = it[1], o = it[2] || {};
      el.style.position = 'absolute';
      el.style.left = (x - x0 - (o.sep ? 0 : 4)) + 'px';
      el.style.top = (o.sep ? 3 : 2) + 'px';
      if (o.sep) el.style.margin = '0';
      if (o.gap !== undefined) el.style.gap = o.gap + 'px';
      row.appendChild(el);
    });
    return row;
  }
  function sepAt() { return sep(); }

  function togglePaneMax(pane) {
    if (!pane) return;
    var on = !pane.classList.contains('max');
    [els.sourcePane, els.consolePane, els.envPane, els.filesPane].forEach(function (p) { if (p) p.classList.remove('max'); });
    pane.classList.toggle('max', on);
  }
  function togglePaneMin(pane) {
    if (!pane) return;
    pane.classList.remove('max');
    pane.classList.toggle('min', !pane.classList.contains('min'));
  }
  function paneControls(getPane) {
    return h('div', { class: 'winctl' },
      h('button', { type: 'button', title: 'Minimize', 'aria-label': 'Minimize pane', on: { click: function () { togglePaneMin(getPane()); } } }, RI.el('paneMin')),
      h('button', { type: 'button', title: 'Maximize', 'aria-label': 'Maximize pane', on: { click: function () { togglePaneMax(getPane()); } } }, RI.el('paneMax')));
  }

  function fmtBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

  function describeValue(v) {
    if (v.t === 'null') return 'NULL';
    var items = v.v.slice(0, 10).map(function (x, i) {
      if (v.t === 'num') return (x === null || isNaN(x)) ? 'NA' : String(Number(x.toPrecision(7)));
      if (v.t === 'lgl') return x === null ? 'NA' : (x ? 'TRUE' : 'FALSE');
      return '"' + x + '"';
    });
    if (v.v.length === 1) return items[0];
    var ty = v.t === 'num' ? 'num' : v.t === 'chr' ? 'chr' : 'logi';
    return ty + ' [1:' + v.v.length + '] ' + items.join(' ') + (v.v.length > 10 ? ' ...' : '');
  }

  /* each side pane is { tabs:[names], active:index }; content() returns { rows:[[nodes]], body:node, center:bool } */
  var SIDE = {
    env: { names: ['Environment', 'History', 'Connections', 'Tutorial'], active: 0 },
    files: { names: ['Files', 'Plots', 'Packages', 'Help', 'Viewer', 'Presentation'], active: 1 }
  };

  function sideContent(key, name) {
    if (name === 'Environment') {
      var keys = Object.keys(S.env).sort(), body;
      if (!keys.length) body = h('div', { class: 'rs-empty', text: 'Environment is empty' });
      else {
        body = h('div', {}, h('div', { class: 'rs-section', text: 'Values' }),
          h('table', { class: 'rs-table' }, h('tbody', {}, keys.map(function (k) {
            return h('tr', {}, h('td', { text: k }), h('td', { class: 'mono', text: describeValue(S.env[k]) }));
          }))));
      }
      return {
        rows: [
          { x0: 938, abs: [
            [tbtn('loadws', null, { title: 'Load workspace', on: function () { notAvailable('Loading a workspace'); } }), 944],
            [tbtn('savews', null, { title: 'Save workspace', size: 24, on: function () { notAvailable('Saving a workspace'); } }), 977],
            [sep(true), 1005, { sep: true }],
            [tbtn('import', 'Import Dataset', { caret: true, on: function () { notAvailable('Import Dataset'); } }), 1015, { gap: 6 }],
            [sep(), 1160, { sep: true }],
            [tbtn('cube', '173 MiB', { caret: true, size: 20, title: 'Memory usage' }), 1166],
            [sep(), 1258, { sep: true }],
            [tbtn('broom', null, { title: 'Clear objects from the workspace', size: 26, on: clearWorkspace }), 1265]
          ], flow: [tbtn('list', 'List', { caret: true, faded: true }), tbtn('grid', null, { caret: true, faded: true, cls: 'ml9' })] },
          { x0: 938, abs: [
            [tbtn(null, 'R', { caret: true, cls: 'bold' }), 947, { gap: 8 }],
            [sep(true), 982, { sep: true }],
            [tbtn('globe', 'Global Environment', { caret: true }), 991, { gap: 5 }]
          ], flow: [searchBox('')] }
        ],
        body: body, center: !keys.length
      };
    }
    if (name === 'History') {
      var hist = S.hist.slice().reverse();
      return {
        rows: [[tbtn('loadws', null, { dis: true }), tbtn('savews', null, { dis: true }), sep(true),
          tbtn(null, 'To Console', { on: function () { var t = S.hist[S.hist.length - 1]; if (t && els.conInput) { els.conInput.value = t; els.conInput.focus(); } } }),
          tbtn(null, 'To Source', { dis: true }), sep(true), tbtn('broom', null, { title: 'Clear history', on: function () { S.hist = []; refreshSide('hist'); } }), spacer(), searchBox('')]],
        body: hist.length ? h('div', {}, hist.map(function (t) {
          return h('div', { class: 'rs-hist', text: t, title: 'Double-click to send to Console', on: { dblclick: function () { if (els.conInput) { els.conInput.value = t; els.conInput.focus(); } } } });
        })) : h('div', { class: 'rs-empty', text: '' }),
        center: false
      };
    }
    if (name === 'Connections') {
      return { rows: [[tbtn(null, 'New Connection', { on: function () { notAvailable('Connections'); } }), spacer(), searchBox('')]], body: h('div', {}), center: false };
    }
    if (name === 'Tutorial') {
      return { rows: [[tbtn(null, 'Home', { dis: true })]], body: h('div', { class: 'rs-pad', text: 'Tutorials are not available in this browser version.' }), center: false };
    }
    if (name === 'Files') {
      return {
        rows: [
          [tbtn(null, 'New Folder', { dis: true }), tbtn(null, 'New Blank File', { caret: true, on: function () { newScript('code'); } }), sep(true),
           tbtn(null, 'Delete', { on: function () { deleteCell(S.selectedId); } }), tbtn(null, 'Rename', { on: openRename }), spacer(), tbtn(null, 'More', { caret: true, dis: true })],
          [tbtn(null, 'Home', { cls: 'bold' }), tbtn(null, '>', { dis: true }), spacer()]
        ],
        body: h('table', { class: 'rs-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Size' }), h('th', { text: 'Modified' }))),
          h('tbody', {}, S.cells.map(function (c, i) {
            return h('tr', {}, h('td', { text: tabName(i) + (c.cell_type === 'code' ? '.R' : '.txt') }), h('td', { text: fmtBytes(c.content.length) }),
              h('td', { text: c.updated_at ? NB.relTime(c.updated_at) : '' }));
          }))),
        center: false
      };
    }
    if (name === 'Plots') {
      return {
        rows: [{ x0: 938, abs: [
          [tbtn('pback', null, { faded: true, dis: true, size: 24 }), 944],
          [tbtn('pfwd', null, { faded: true, dis: true, size: 24 }), 972],
          [sep(true), 1005, { sep: true }],
          [tbtn('zoom', 'Zoom', { faded: true, dim: true, dis: true }), 1016, { gap: 8 }],
          [sep(), 1091, { sep: true }],
          [tbtn('export', 'Export', { caret: true, size: 22, on: function () { notAvailable('Export'); } }), 1101, { gap: 6 }],
          [sep(), 1190, { sep: true }],
          [tbtn('delcirc', null, { title: 'Remove Plot', size: 18, on: noop }), 1196],
          [sep(), 1225, { sep: true }],
          [tbtn('broomFaded', null, { faded: true, size: 24 }), 1234]
        ], flow: [tbtn('brush', null, { faded: true, dis: true })] }],
        body: h('div', {}), center: false
      };
    }
    if (name === 'Packages') {
      var pk = [['base', 'The R Base Package'], ['datasets', 'The R Datasets Package'], ['graphics', 'The R Graphics Package'], ['grDevices', 'The R Graphics Devices and Support for Colours and Fonts'],
        ['methods', 'Formal Methods and Classes'], ['stats', 'The R Stats Package'], ['utils', 'The R Utils Package']];
      return {
        rows: [[tbtn(null, 'Install', { on: function () { notAvailable('Installing packages'); } }), tbtn(null, 'Update', { dis: true }), spacer(), searchBox('')]],
        body: h('div', {}, h('div', { class: 'rs-section', text: 'System Library' }), h('table', { class: 'rs-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Description' }), h('th', { text: 'Version' }))),
          h('tbody', {}, pk.map(function (r) { return h('tr', {}, h('td', { text: r[0] }), h('td', { text: r[1] }), h('td', { text: '4.4.1' })); })))),
        center: false
      };
    }
    if (name === 'Help') {
      return { rows: [[tbtn('pback', null, { faded: true, dis: true }), tbtn('pfwd', null, { faded: true, dis: true }), sep(true), tbtn(null, 'Home', { dis: true }), spacer(), searchBox('')]],
        body: h('div', { class: 'rs-pad', text: 'R documentation is not available in this browser version.' }), center: false };
    }
    return { rows: [[tbtn('pback', null, { faded: true, dis: true }), tbtn('pfwd', null, { faded: true, dis: true })]], body: h('div', {}), center: false };
  }

  function renderSide(key) {
    var P = els[key]; if (!P) return;
    var def = SIDE[key], name = def.names[def.active], c = sideContent(key, name);
    Array.prototype.forEach.call(P.tabEls, function (t, i) { t.classList.toggle('active', i === def.active); t.setAttribute('aria-selected', String(i === def.active)); });
    P.tools.textContent = '';
    c.rows.forEach(function (row) {
      if (Array.isArray(row)) { P.tools.appendChild(h('div', { class: 'rs-tools tall' }, row)); return; }
      var el = h('div', { class: 'rs-tools tall abs' });
      placeRow(el, row.x0, row.abs);
      (row.flow || []).forEach(function (n) { el.appendChild(n); });
      P.tools.appendChild(el);
    });
    P.body.textContent = '';
    P.body.className = 'rs-body rs-scroll' + (c.center ? ' center' : '');
    P.body.appendChild(c.body);
  }

  var SIDE_DEPENDS = { env: { Environment: 'env', History: 'hist' }, files: { Files: 'files' } };
  /** Re-render a side pane only when the visible tab shows the data that changed ('env' | 'hist' | 'files'). */
  function refreshSide(what) {
    ['env', 'files'].forEach(function (key) {
      if (!els[key]) return;
      var def = SIDE[key], dep = SIDE_DEPENDS[key][def.names[def.active]];
      if (dep === what) renderSide(key);
    });
  }

  function buildSidePane(key, cls, getPane) {
    var def = SIDE[key], P = { tabEls: [] };
    P.tabs = h('div', { class: 'rs-tabs', role: 'tablist' },
      def.names.map(function (n, i) {
        var t = h('div', { class: 'rs-tab', role: 'tab', text: n, on: { click: function () { def.active = i; renderSide(key); } } });
        P.tabEls.push(t); return t;
      }), paneControls(getPane));
    P.tools = h('div', { class: 'rs-toolrows' });
    P.body = h('div', { class: 'rs-body rs-scroll' });
    P.root = h('section', { class: 'rs-pane ' + cls }, P.tabs, P.tools, P.body);
    els[key] = P;
    return P;
  }

  /* ================================================================ dialogs */

  function showShortcuts() {
    var rows = [
      ['Ctrl+S', 'Save notebook'], ['Ctrl+Enter', 'Run current line or selection'], ['Alt+Enter', 'Run current line or selection (cursor stays)'],
      ['Ctrl+Shift+Enter', 'Source the script with echo'], ['Ctrl+Shift+S', 'Source the script'], ['Ctrl+Alt+R', 'Run all lines'],
      ['Ctrl+Shift+P', 'Re-run previous'], ['Ctrl+/', 'Comment / uncomment lines'], ['Tab / Shift+Tab', 'Indent / outdent'],
      ['Ctrl+Alt+Shift+N', 'New R script'], ['Ctrl+Shift+F10', 'Restart R'], ['Ctrl+L', 'Clear console (when the console is focused)'],
      ['Up / Down', 'Console: previous / next command']
    ];
    NB.openModal({
      title: 'Keyboard Shortcuts', wide: true,
      content: h('table', { class: 'shortcut-table' }, h('tbody', {}, rows.map(function (r) { return h('tr', {}, h('td', { text: r[0] }), h('td', { text: r[1] })); }))),
      buttons: [{ label: 'Close', kind: 'primary' }]
    });
  }

  function showAbout() {
    NB.openModal({
      title: 'About RStudio Notebook',
      content: h('div', {},
        h('p', { class: 'modal-text', text: 'An RStudio-style editor. Each tab is a script saved to a shared database, and a master can open and edit them.' }),
        h('p', { class: 'modal-text', text: 'The Console is a mock: it simulates assignment, arithmetic, vectors, print() and cat() only. Real R needs a separate server-side R process.' })),
      buttons: [{ label: 'Close', kind: 'primary' }]
    });
  }

  function openRename() {
    if (S.readOnly) return;
    var input = h('input', { class: 'input', type: 'text', maxlength: '120', value: S.title, 'data-autofocus': '1', spellcheck: 'false' });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var b = document.querySelector('.modal-foot .btn-primary'); if (b) b.click(); } });
    NB.openModal({
      title: 'Rename Notebook', content: h('div', {}, input),
      buttons: [
        { label: 'Cancel', kind: 'text' },
        { label: 'Rename', kind: 'primary', onClick: function (close) { els.title.value = input.value; commitTitle(); close(); } }
      ]
    });
  }

  function updateProject() {
    if (!els.projLabel) return;
    var t = S.title && S.title !== 'Untitled.ipynb' ? String(S.title).replace(/\.ipynb$/i, '') : '(None)';
    els.projLabel.textContent = 'Project: ' + t;
  }


  async function openListModal() {
    var list = h('div', {}, h('div', { class: 'side-empty', text: 'Loading…' }));
    NB.openModal({ title: 'Open notebook', content: list, buttons: [{ label: 'Close', kind: 'text' }] });
    try {
      var r = await S.client.from('notebooks').select('id, filename, updated_at').eq('owner_id', S.user.id).is('deleted_at', null).order('updated_at', { ascending: false }).limit(50);
      if (r.error) throw r.error;
      list.textContent = '';
      if (!r.data.length) list.appendChild(h('div', { class: 'side-empty', text: 'You have no saved notebooks yet.' }));
      r.data.forEach(function (n) {
        list.appendChild(h('button', { class: 'nb-list-item', type: 'button', on: { click: function () { go('index.html?notebook_id=' + n.id); } } },
          h('span', { text: n.filename }), h('small', { text: NB.relTime(n.updated_at) })));
      });
    } catch (e) { list.textContent = ''; list.appendChild(h('div', { class: 'side-empty', text: 'Could not load your notebooks.' })); }
  }

  function downloadIpynb() {
    commitTitle();
    var json = JSON.stringify(C.toIpynb(S.title, S.cells), null, 1);
    var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    var a = h('a', { href: url, download: S.title });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  async function deleteNotebook() {
    var ok = await NB.confirm('Delete this notebook?', '“' + S.title + '” will be removed' + (S.masterMode ? ' for its owner too' : '') + '.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      var r = await S.client.rpc('delete_notebook', { p_notebook_id: S.nbId });
      if (r.error) throw r.error;
      try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ }
      S.skipUnload = true;
      location.href = S.masterMode ? 'master.html' : 'index.html?new=1';
    } catch (e) { NB.toast('Could not delete: ' + ((e && e.message) || 'error'), { kind: 'error' }); }
  }

  function updateAvatar() {
    if (!els.avatar) return;
    var label = S.masterMode ? 'M' : ((S.profileName || 'Guest').charAt(0).toUpperCase());
    els.avatar.textContent = label;
    els.avatar.classList.toggle('master', S.masterMode);
    els.avatar.title = (S.masterMode ? 'Master' : (S.profileName || 'Guest')) + ' — account';
  }

  function openProfile() {
    var input = h('input', { class: 'input', type: 'text', maxlength: '60', value: S.profileName, placeholder: 'e.g. Sreesanth', 'data-autofocus': '1' });
    var who = S.masterMode ? 'Signed in as master' + (S.user && S.user.email ? ' (' + S.user.email + ')' : '') : 'You are using a guest account. Your notebooks stay linked to this browser.';
    var buttons = [{ label: 'Cancel', kind: 'text' }];
    if (S.masterMode) buttons.unshift({ label: 'Sign out', kind: 'text', onClick: async function (close) { await S.client.auth.signOut(); S.skipUnload = true; location.href = 'master.html'; close(); } });
    buttons.push({
      label: 'Save', kind: 'primary', onClick: async function (close) {
        var name = input.value.trim().slice(0, 60);
        var r = await S.client.from('profiles').update({ display_name: name || null }).eq('id', S.user.id).select('display_name');
        if (r.error || !r.data || !r.data.length) { NB.toast('Could not save your name', { kind: 'error' }); return; }
        S.profileName = name; updateAvatar(); NB.toast('Name saved', { kind: 'ok' }); close();
      }
    });
    NB.openModal({
      title: 'Your profile',
      content: h('div', {}, h('p', { class: 'modal-text', text: who }), h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', { text: 'Display name (shown to the master)' }), input)),
      buttons: buttons
    });
  }


  /* ================================================================ keyboard */

  function modalOpen() { return !!document.querySelector('.modal-backdrop'); }

  function onGlobalKey(e) {
    var mod = e.ctrlKey || e.metaKey, k = (e.key || '');
    if (mod && !e.altKey && !e.shiftKey && (k === 's' || k === 'S')) {
      e.preventDefault(); e.stopPropagation();
      if (!modalOpen()) { commitTitle(); saveDoc(); }
      return;
    }
    if (modalOpen()) return;
    if (k === 'Escape' && S.menu) { closeMenu(); return; }
    if (mod && e.shiftKey && !e.altKey && (k === 'S' || k === 's')) { e.preventDefault(); sourceCell(false); return; }
    if (mod && e.shiftKey && !e.altKey && k === 'Enter') { e.preventDefault(); sourceCell(true); return; }
    if (mod && e.altKey && !e.shiftKey && (k === 'r' || k === 'R' || k === '®')) { e.preventDefault(); runAllLines(); return; }
    if (mod && e.shiftKey && !e.altKey && (k === 'P' || k === 'p')) { e.preventDefault(); rerunPrevious(); return; }
    if (mod && e.shiftKey && k === 'F10') { e.preventDefault(); restartR(); return; }
    if (mod && e.altKey && e.shiftKey && (k === 'N' || k === 'n')) { e.preventDefault(); newScript('code'); return; }
  }


  /* ================================================================= build UI */

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch (e) { /* ignore */ }
  }

  function buildUI() {
    root.textContent = '';
    els.title = h('input', { type: 'hidden', value: S.title });          // holds the notebook name (rename via File menu)
    els.statusText = h('span', { text: '' });
    els.status = h('button', { class: 'rs-status', type: 'button', 'aria-live': 'polite', on: { click: function () { if (S.saveError || (S.dirty && !S.saving)) save({ manual: true }); } } }, els.statusText);
    els.live = h('span', { class: 'live-chip', hidden: true });

    /* ---- title bar ---- */
    function winBtn(cls, icon, label, fn) {
      return h('button', { class: 'rs-winbtn ' + cls, type: 'button', title: label, 'aria-label': label, on: { click: fn } }, RI.el(icon));
    }
    var logo = RI.el('rlogo', 18); logo.classList.add('logo');
    var titlebar = h('div', { class: 'rs-title' }, logo, h('span', { class: 'name', text: 'RStudio' }), h('span', { class: 'spacer' }),
      winBtn('min', 'winMin', 'Minimize', noop), winBtn('restore', 'winRestore', 'Restore', toggleFullscreen), winBtn('close', 'winClose', 'Close', noop));

    /* ---- menu bar ---- */
    var menuNames = ['File', 'Edit', 'Code', 'View', 'Plots', 'Session', 'Build', 'Debug', 'Profile', 'Tools', 'Help'];
    els.menubar = h('nav', { class: 'rs-menubar', 'aria-label': 'Menu' }, menuNames.map(function (n) {
      return h('button', {
        class: 'menu-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: n,
        on: {
          click: function (e) { if (S.menu && S.menu.name === n) closeMenu(); else openMenu(e.currentTarget, n); },
          mouseenter: function (e) { if (S.menu && S.menu.name !== n && menuNames.indexOf(S.menu.name) >= 0) openMenu(e.currentTarget, n); }
        }
      });
    }));

    /* ---- main toolbar ---- */
    function dd(btn, key, items) { btn.classList.add('menu-btn'); btn.addEventListener('click', function () { dropdown(btn, key, typeof items === 'function' ? items() : items); }); return btn; }
    els.goto = h('input', {
      type: 'text', placeholder: 'Go to file/function', spellcheck: 'false', 'aria-label': 'Go to file/function',
      on: {
        keydown: function (e) {
          if (e.key !== 'Enter') return;
          var q = els.goto.value.trim().toLowerCase(); if (!q) return;
          for (var i = 0; i < S.cells.length; i++) if (tabName(i).toLowerCase().indexOf(q) >= 0) { selectCell(S.cells[i].id, { focus: true }); els.goto.value = ''; return; }
          NB.toast('No matching file');
        }
      }
    });
    els.projLabel = h('span', { class: 'lbl', text: 'Project: (None)' });
    var projBtn = h('button', { class: 'rs-btn rs-proj menu-btn', type: 'button', 'aria-label': 'Project', title: 'Project' }, RI.el('rlogoSmall', 18), els.projLabel, h('span', { class: 'ar' }));
    projBtn.addEventListener('click', function () {
      dropdown(projBtn, 'tb-proj', [
        { label: 'Rename Notebook…', run: openRename, disabled: S.readOnly },
        { label: 'Open Notebook…', run: openListModal, disabled: S.masterMode },
        { label: 'New Notebook', run: function () { go('index.html?new=1'); }, disabled: S.masterMode },
        { sep: true },
        { label: 'Close Project', run: noop, disabled: true }
      ]);
    });
    var gotoBox = h('label', { class: 'rs-goto' }, RI.el('wrench', 20), els.goto);
    var panesBtn = tbtn('panes', null, { title: 'Workspace Panes', faded: true, caret: true, dis: true });
    var addinsBtn = tbtn(null, 'Addins', { caret: true, on: function (e) { dropdown(e.currentTarget, 'tb-addins', [{ label: 'Browse Addins…', run: noop, disabled: true }]); } });
    els.toolbar = h('div', { class: 'rs-toolbar', role: 'toolbar', 'aria-label': 'Main toolbar' });
    placeRow(els.toolbar, 0, [
      [(function () { var b = dd(tbtn('newfile', null, { title: 'New File', caret: true, size: 18 }), 'tb-new', function () {
        return [{ label: 'R Script', run: function () { newScript('code'); }, disabled: S.readOnly }, { label: 'Text File', run: function () { newScript('text'); }, disabled: S.readOnly }]; }); return b; })(), 6, { gap: 12 }],
      [sep(), 50, { sep: true }],
      [tbtn('newproj', null, { title: 'New Project…', on: function () { notAvailable('Projects'); } }), 56],
      [sep(), 87, { sep: true }],
      [dd(tbtn('openfile', null, { title: 'Open an existing file', caret: true }), 'tb-open', function () {
        return [{ label: 'Open Notebook…', run: openListModal, disabled: S.masterMode }, { label: 'Reopen Closed File', run: reopenClosed, disabled: S.readOnly || !S.deleted.length }]; }), 96, { gap: 5 }],
      [sep(), 140, { sep: true }],
      [tbtn('save', null, { title: 'Save current document (Ctrl+S)', on: saveDoc }), 147],
      [tbtn('saveall', null, { title: 'Save all open documents', on: saveDoc }), 176],
      [sep(), 209, { sep: true }],
      [tbtn('printer', null, { title: 'Print', faded: true, dis: true }), 217],
      [sep(), 245, { sep: true }],
      [gotoBox, 255, { sep: true }],
      [sep(), 450, { sep: true }],
      [panesBtn, 460, { gap: 8 }],
      [addinsBtn, 503, { gap: 7 }]
    ]);
    gotoBox.style.top = '2px';
    els.toolbar.appendChild(els.status); els.toolbar.appendChild(projBtn);

    els.banners = h('div', { class: 'rs-banners' });

    /* ---- source pane ---- */
    els.tabList = h('div', { class: 'rs-tablist', role: 'tablist', on: { click: onTabClick, auxclick: onTabAux } });
    els.cursorPos = h('div', { class: 'cellpos', text: '' });
    els.fileType = h('span', { text: '' });
    els.sourceOnSave = h('button', { class: 'rs-check', type: 'button', role: 'checkbox', 'aria-checked': 'false',
      on: { click: function () { S.sourceOnSave = !S.sourceOnSave; els.sourceOnSave.classList.toggle('on', S.sourceOnSave); els.sourceOnSave.setAttribute('aria-checked', String(S.sourceOnSave)); } } },
      h('span', { class: 'box' }), h('span', { class: 'lbl', text: 'Source on Save' }));
    var srcDD = tbtn('sourceIcon', 'Source', { caret: true, title: 'Source the active document (Ctrl+Shift+S)', on: function () { sourceCell(false); } });
    var srcCaret = h('button', { class: 'rs-btn menu-btn', type: 'button', style: { padding: '0 2px' }, 'aria-label': 'Source options',
      on: { click: function (e) { dropdown(e.currentTarget, 'src-opts', [{ label: 'Source', kbd: 'Ctrl+Shift+S', run: function () { sourceCell(false); } }, { label: 'Source with Echo', kbd: 'Ctrl+Shift+Enter', run: function () { sourceCell(true); } }]); } } });
    srcDD.querySelector('.ar').remove();
    srcCaret.appendChild(h('span', { class: 'ar' }));
    var wand = tbtn('wand', null, { caret: true, title: 'Code Tools' });
    wand.classList.add('menu-btn');
    wand.addEventListener('click', function () {
      dropdown(wand, 'code-tools', [{ label: 'Comment/Uncomment Lines', kbd: 'Ctrl+/', run: function () { var ta = currentTa(); if (ta) { ta.focus(); toggleComment(ta); } }, disabled: S.readOnly },
        { label: 'Run Selected Line(s)', kbd: 'Ctrl+Enter', run: function () { focusEditor(); runSelection({ advance: true }); } }]);
    });
    els.sourceTools = h('div', { class: 'rs-tools abs' });
    placeRow(els.sourceTools, 10, [
      [tbtn('back', null, { faded: true, dis: true, title: 'Go back' }), 20],
      [tbtn('fwd', null, { faded: true, dis: true, title: 'Go forward' }), 44],
      [sep(), 71, { sep: true }],
      [tbtn('showwin', null, { faded: true, dis: true, title: 'Show in new window' }), 80],
      [sep(true), 105, { sep: true }],
      [tbtn('save', null, { title: 'Save current document', size: 24, on: saveDoc }), 118],
      [els.sourceOnSave, 147],
      [sep(), 272, { sep: true }],
      [tbtn('find', null, { title: 'Find/Replace', on: findInEditor }), 280],
      [wand, 312, { gap: 9 }],
      [sep(), 355, { sep: true }],
      [tbtn('compile', null, { faded: true, dis: true, title: 'Compile report' }), 363],
      [tbtn('run', 'Run', { title: 'Run the current line or selection (Ctrl+Enter)', on: function () { focusEditor(); runSelection({ advance: true }); } }), 623],
      [sep(), 683, { sep: true }],
      [tbtn('rerun', null, { title: 'Re-run the previous code region', on: rerunPrevious }), 690],
      [tbtn('upfaded', null, { faded: true, dis: true }), 726],
      [tbtn('downfaded', null, { faded: true, dis: true }), 753],
      [sep(), 784, { sep: true }],
      [srcDD, 793, { gap: 6 }],
      [srcCaret, 871],
      [sep(true), 887, { sep: true }],
      [tbtn('upDoc', null, { faded: true, dis: true }), 897]
    ]);

    els.cells = h('div', { id: 'cells' });
    els.editorScroll = h('div', { class: 'rs-editor-scroll rs-scroll' }, els.cells);
    els.cellsRoot = els.editorScroll;                                       // lockNotebook() marks this read-only
    els.editor = h('main', { class: 'rs-editor' }, els.editorScroll);
    els.statusbar = h('div', { class: 'rs-statusbar' },
      els.cursorPos, h('div', { class: 'cellscope' }, h('span', { text: '(Top Level)' }), RI.el('updown')), h('div', { class: 'grow' }),
      h('div', { class: 'celltype' }, els.fileType, RI.el('updown')));
    els.sourcePane = h('section', { class: 'rs-pane p-source' },
      h('div', { class: 'rs-tabs' }, els.tabList, paneControls(function () { return els.sourcePane; })),
      els.sourceTools, els.editor, els.statusbar);

    /* ---- console pane ---- */
    els.conLines = h('div', { class: 'con-lines' }, BANNER.map(function (t) { return conLine('out', t); }));
    els.conInput = h('input', {
      type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'R console input',
      on: {
        keydown: function (e) {
          var inp = els.conInput;
          if (e.key === 'Enter') {
            e.preventDefault(); var t = inp.value; inp.value = ''; S.histIdx = null; conSubmit(t);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault(); if (!S.hist.length) return;
            S.histIdx = S.histIdx === null ? S.hist.length - 1 : Math.max(0, S.histIdx - 1); inp.value = S.hist[S.histIdx];
          } else if (e.key === 'ArrowDown') {
            e.preventDefault(); if (S.histIdx === null) return;
            S.histIdx++; if (S.histIdx >= S.hist.length) { S.histIdx = null; inp.value = ''; } else inp.value = S.hist[S.histIdx];
          } else if (e.key === 'Escape') { inp.value = ''; S.histIdx = null; }
          else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); conClear(); }
        }
      }
    });
    els.con = h('div', { class: 'rs-console', role: 'log', on: { mouseup: function (e) { if (e.target !== els.conInput && !String(window.getSelection()).length) els.conInput.focus(); } } },
      els.conLines, h('div', { class: 'prompt' }, h('span', { class: 'gt', text: '>' }), els.conInput));
    els.conHead = h('div', { class: 'rs-console-head' }, RI.el('rlogoCon', 22),
      h('span', { class: 'path' }, h('span', { text: 'R 4.4.1 · ~/' }), RI.el('shareFaded', 16)),
      h('button', { class: 'rs-btn faded clear', type: 'button', title: 'Clear console (Ctrl+L)', 'aria-label': 'Clear console', on: { click: conClear } }, RI.el('broomFaded', 22)));
    els.conOther = h('div', { class: 'rs-body', hidden: true });
    var conTabNames = [['Console', false], ['Terminal', true], ['Background Jobs', true]];
    var conTabEls = conTabNames.map(function (t, i) {
      return h('div', { class: 'rs-tab' + (i === 0 ? ' active' : ''), role: 'tab', on: {
        click: function (e) {
          if (e.target.closest('.x')) return;
          conTabEls.forEach(function (x, j) { x.classList.toggle('active', j === i); });
          els.conHead.hidden = els.con.hidden = i !== 0; els.conOther.hidden = i === 0;
          els.conOther.textContent = '';
          if (i === 1) els.conOther.appendChild(h('div', { class: 'rs-pad', text: 'The terminal is not available in this browser version.' }));
          if (i === 2) els.conOther.appendChild(h('div', { class: 'rs-pad', text: 'No background jobs.' }));
          if (i === 0) els.conInput.focus();
        } } }, h('span', { text: t[0] }), t[1] ? h('button', { class: 'x', type: 'button', 'aria-label': 'Close ' + t[0], title: 'Close' }, RI.el('close', 10)) : null);
    });
    els.consolePane = h('section', { class: 'rs-pane p-console' },
      h('div', { class: 'rs-tabs' }, conTabEls, paneControls(function () { return els.consolePane; })),
      els.conHead, els.con, els.conOther);

    /* ---- environment + files panes ---- */
    buildSidePane('env', 'p-env', function () { return els.envPane; });
    buildSidePane('files', 'p-files', function () { return els.filesPane; });
    els.envPane = els.env.root; els.filesPane = els.files.root;

    els.layout = h('div', { class: 'rs-panes' },
      h('div', { class: 'rs-col left' }, els.sourcePane, els.consolePane),
      h('div', { class: 'rs-col right' }, els.envPane, els.filesPane));

    els.cells.addEventListener('input', onCellsInput);
    els.cells.addEventListener('keydown', onCellKey);
    els.cells.addEventListener('keyup', onCaretMove);
    els.cells.addEventListener('mouseup', onCaretMove);
    els.cells.addEventListener('focusin', onCellsFocusIn);
    document.addEventListener('selectionchange', function () { if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('code-input')) updateCursor(); });

    root.appendChild(h('div', { class: 'rs-app' }, titlebar, els.menubar, els.toolbar, els.banners, els.layout));

    renderSide('env'); renderSide('files');
    updateLive(); updateAvatar(); updateProject();
    requestAnimationFrame(conScroll);
  }


  // test hook (harmless in production)
  window.__nb = { S: S, els: els, save: save, consoleRun: consoleRun, refreshFromServer: refreshFromServer, insertCell: insertCell };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
