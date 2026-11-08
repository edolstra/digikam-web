// ===== Picker modal ==========================================================
// The Tag (`t`) / Move (`v`) modal, shared by the lightbox (editing the current
// item) and the grid's selection mode (editing every checked item): both open it
// on a list of PhotoSummaries, and a single item is just the N = 1 case. Exposed
// as the module-level `PICKER`, created once at startup.
var PICKER = null;

// Run `tasks` (functions returning Promises) at most `limit` at a time.
// Resolves — never rejects — to one {ok, value} per task, in order.
function runPool(tasks, limit) {
  var results = new Array(tasks.length), next = 0;
  function worker() {
    if (next >= tasks.length) return Promise.resolve();
    var i = next++;
    return Promise.resolve().then(tasks[i]).then(
      function (v) { results[i] = { ok: true, value: v }; },
      function () { results[i] = { ok: false }; }
    ).then(worker);
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(worker());
  return Promise.all(workers).then(function () { return results; });
}

// "img001.jpg" for one item, "5 items" for several (toasts / undo labels).
function itemsLabel(photos) {
  return photos.length === 1 ? photos[0].name : photos.length + ' items';
}

function initPicker() {
  // One modal, two modes, same machinery (quick filter, MRU section, keyboard
  // model, Cancel + primary button):
  // - 'tags': a transactional editor for the items' tags — checkbox rows, each
  //   on (every item has the tag), off (none has it), or "some" (an
  //   indeterminate checkbox plus a k/N count). Clicks / Space change rows
  //   LOCALLY — on ↔ off, or some → on → off → some for a row that started
  //   out as "some"; Enter/Apply commits all pending changes (per item, only
  //   what that item lacks / has; a row left at "some" changes nothing) as one
  //   PATCH per item and one undo op for the whole batch; Esc/Cancel/
  //   outside-click discard them.
  // - 'move': the album hierarchy as directly-activatable rows (menu-like, no
  //   selection state): clicking a row, or arrow-navigating to it and hitting
  //   Enter, PATCHes every item not already there into that album — the server
  //   moves the file on disk too — and pushes the reverse moves (each item back
  //   to its own album) onto the undo stack as one op. The items' album is
  //   highlighted when they all share one (activating it just closes). Enter in
  //   the filter moves to the first match (only with a non-empty query, so a
  //   stray Enter can't move anything). No primary footer button — a click/tap
  //   on a row IS the action.
  // With several items some PATCHes can fail while others succeed: if all
  // fail the modal stays open (retry, or Esc); otherwise it closes, the toast
  // says how many failed, and the undo op covers the ones that succeeded.
  //
  // `#picker` is a full-screen backdrop around the dialog box: a click on it
  // discards the modal, and it keeps clicks/touches away from whatever is
  // underneath (the grid, or the lightbox's tap/swipe handling).
  var pickerEl = document.getElementById('picker');
  var pickerFilter = document.getElementById('picker-filter');
  var pickerMru = pickerEl.querySelector('.picker-mru');
  var pickerList = pickerEl.querySelector('.picker-list');
  var pickerMruLabel = pickerEl.querySelector('.picker-label-mru');
  var pickerListLabel = pickerEl.querySelector('.picker-label-list');
  var pickerApplyBtn = pickerEl.querySelector('.picker-apply');
  var pickerOpen = false;
  var pickerMode = null;    // 'tags' | 'move' while open
  var pickerPhotos = null;  // the PhotoSummaries the open picker edits (≥ 1)
  var busy = false;         // a commit's PATCHes are in flight (no second one)
  var photoTags = {};       // tags mode: photo id -> {tag path: true}, its tags
  var tagCounts = {};       // tags mode: tag path -> how many of the items have it
  var moveSources = {};     // move mode: photo id -> {id, path} of its album
  var moveShared = null;    // move mode: the album path all the items share, or null

  // A most-recently-used list — the last 10 tags added / move targets (each
  // use moves it to the front; tag removals don't touch it). Shown flat, as
  // full paths, below the tree — oldest first, so the most recent entry ends
  // up at the bottom, right next to the filter. Persisted (newest first) in
  // localStorage so it survives reloads; unavailable/corrupt storage (private
  // mode, quota) just degrades to session-only. Entries that no longer exist
  // in the hierarchy are skipped when the picker is built.
  function makeMru(key) {
    var list = [];
    try {
      var stored = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(stored)) {
        list = stored.filter(function (t) {
          return t && typeof t.id === 'number' && typeof t.path === 'string';
        }).slice(0, 10);
      }
    } catch (e) { /* start empty */ }
    return {
      // In display order: oldest first, most recent last.
      list: function () { return list.slice().reverse(); },
      used: function (ids, paths) {
        ids.forEach(function (id, i) {
          list = list.filter(function (t) { return t.id !== id; });
          list.unshift({ id: id, path: paths[i] });
        });
        list = list.slice(0, 10);
        try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* ignore */ }
      }
    };
  }
  var tagMru = makeMru('digikam.tagMru');
  var albumMru = makeMru('digikam.albumMru');

  function openPicker(mode, photos) {
    if (!photos || !photos.length) return;
    if (pickerOpen) closePicker();
    var ps = photos.slice();
    pickerMode = mode;
    pickerPhotos = ps;
    pickerOpen = true;
    photoTags = {};
    tagCounts = {};
    // While an element is fullscreen (the lightbox) the browser paints only
    // its subtree, so host the modal there; otherwise in the body.
    var host = document.fullscreenElement || document.body;
    if (pickerEl.parentNode !== host) host.appendChild(pickerEl);
    pickerEl.classList.add('open');
    pickerFilter.value = '';
    pickerMru.replaceChildren();
    pickerList.replaceChildren();
    pickerMruLabel.hidden = true; // shown once the MRU rows are built (if any)
    pickerListLabel.textContent = (mode === 'move' ? 'Albums' : 'Tags') +
      (ps.length > 1 ? ' · ' + ps.length + ' items' : '');
    // Move mode has no commit step (activating a row IS the action), so the
    // primary footer button only exists for tags mode — and starts disabled
    // there (nothing changed yet).
    pickerApplyBtn.hidden = mode === 'move';
    pickerApplyBtn.disabled = true;
    // Still the same open picker when an async load lands?
    function current() { return pickerOpen && pickerPhotos === ps && pickerMode === mode; }
    function fail() {
      if (current()) { closePicker(); toast('could not load ' + mode + ' data', true); }
    }
    if (mode === 'tags') {
      // The hierarchy (fresh each open — it's small) + each item's current
      // tags (a few requests at a time; cached per photo, see meta.js).
      Promise.all([
        fetch('/api/tags').then(function (r) { return r.json(); }),
        runPool(ps.map(function (p) { return function () { return loadMeta(p.id); }; }), 6)
      ]).then(function (res) {
        if (!current()) return;
        var metas = res[1];
        if (metas.some(function (m) { return !m.ok; })) { fail(); return; }
        ps.forEach(function (p, i) {
          var set = photoTags[p.id] = {};
          (metas[i].value.tags || []).forEach(function (t) {
            if (set[t]) return;
            set[t] = true;
            tagCounts[t] = (tagCounts[t] || 0) + 1;
          });
        });
        buildTagRows(res[0]);
        applyPickerFilter();
      }).catch(fail);
    } else {
      fetch('/api/albums').then(function (r) { return r.json(); }).then(function (albums) {
        if (!current()) return;
        buildAlbumRows(albums);
        applyPickerFilter();
      }).catch(fail);
    }
    pickerFilter.focus();
  }
  function closePicker() {
    pickerOpen = false;
    pickerMode = null;
    pickerPhotos = null;
    photoTags = {};
    tagCounts = {};
    // Drop focus from the (now hidden) picker: left on the filter input, its
    // keydown handler swallows every key, so the page's own bindings (the
    // lightbox's arrows, i, s, …) go dead — until the browser gets round to
    // blurring the hidden element (Chrome: its next rendering update; not
    // every browser).
    if (pickerEl.contains(document.activeElement)) document.activeElement.blur();
    pickerEl.classList.remove('open');
    pickerMru.replaceChildren();
    pickerList.replaceChildren();
  }
  function togglePicker(mode, photos) {
    if (pickerOpen && pickerMode === mode) { closePicker(); return; }
    openPicker(mode, photos);
  }
  // Enter / the primary button when no specific row is the target: commits the
  // tag batch; in move mode there's nothing to commit (activating a row is the
  // action), so it's a no-op.
  function pickerApply() {
    if (pickerMode === 'tags') applyTags();
  }

  // ----- Tags mode: row states -----
  // Each checkbox carries its tag's id/path, its state at open time (or as
  // since changed by an undo landing here) in `data-orig`, and the pending
  // state in `data-cur` — each 'on' | 'off' | 'some'.
  function origState(path) {
    var k = tagCounts[path] || 0;
    return k === 0 ? 'off' : k === pickerPhotos.length ? 'on' : 'some';
  }
  function setBoxState(cb, st) {
    cb.dataset.cur = st;
    cb.checked = st === 'on';
    cb.indeterminate = st === 'some';
  }
  // The grey "k/N" after a tag only some of the items have.
  function setCount(cb) {
    var k = tagCounts[cb.dataset.path] || 0, n = pickerPhotos.length;
    cb.parentNode.querySelector('.picker-count').textContent = (k > 0 && k < n) ? k + '/' + n : '';
  }
  // Every checkbox for tag `id` (it can be shown twice: MRU + tree).
  function boxesFor(id) {
    return Array.prototype.slice.call(pickerEl.querySelectorAll('.picker-row input[data-id="' + id + '"]'));
  }
  // A click / Space on a checkbox: the next state in its cycle, on every
  // copy of the row. (Set from the click handler, after the browser's own
  // toggle, which it overrides; not cancelled, or the browser would restore
  // the pre-click state.)
  function cycleBox(cb) {
    var cur = cb.dataset.cur, next;
    if (cb.dataset.orig === 'some') next = cur === 'some' ? 'on' : cur === 'on' ? 'off' : 'some';
    else next = cur === 'on' ? 'off' : 'on';
    boxesFor(cb.dataset.id).forEach(function (x) { setBoxState(x, next); });
    updateApplyState();
  }
  // Re-derive the rows' original states from the tag counts (after an undo
  // changed an item's tags under the open picker): rows without pending
  // changes follow; pending ones keep their state.
  function rederiveRows() {
    Array.prototype.forEach.call(pickerEl.querySelectorAll('.picker-row input'), function (cb) {
      var o = origState(cb.dataset.path);
      if (cb.dataset.cur === cb.dataset.orig) setBoxState(cb, o);
      cb.dataset.orig = o;
      setCount(cb);
    });
    updateApplyState();
  }

  // One row. `kind` is 'checkbox' (tags mode: a label wrapping a checkbox, the
  // name and the k/N count) or 'item' (move mode: a bare focusable row —
  // activating it is the action, so there's no input at all). The entry's
  // id/path live on the row (the filter and move activation read them there);
  // tags mode duplicates them onto the checkbox for the apply diff and the
  // twin mirroring.
  function pickerRow(kind, id, path, text, depth) {
    var row;
    if (kind === 'checkbox') {
      row = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = id;
      cb.dataset.path = path;
      var cnt = document.createElement('span');
      cnt.className = 'picker-count';
      row.append(cb, text, cnt);
      cb.dataset.orig = origState(path);
      setBoxState(cb, cb.dataset.orig);
      setCount(cb);
    } else {
      row = document.createElement('div');
      row.tabIndex = -1; // focusable by arrows/script, not in the Tab order
      row.textContent = text;
    }
    row.className = 'picker-row';
    row.style.setProperty('--depth', depth);
    row.dataset.id = id;
    row.dataset.path = path;
    return row;
  }

  // Tags mode: the MRU rows (flat, full paths) and the tree (already
  // name-sorted per level by the server), in their states for the items' tags.
  function buildTagRows(tree) {
    var treeIds = {};
    var frag = document.createDocumentFragment();
    function walk(nodes, prefix, depth) {
      nodes.forEach(function (n) {
        var path = prefix + '/' + n.name;
        treeIds[n.id] = true;
        frag.appendChild(pickerRow('checkbox', n.id, path, n.name, depth));
        if (n.children && n.children.length) walk(n.children, path, depth + 1);
      });
    }
    walk(tree, '', 0);
    pickerList.replaceChildren(frag);

    var mru = document.createDocumentFragment();
    tagMru.list().forEach(function (t) {
      if (treeIds[t.id]) mru.appendChild(pickerRow('checkbox', t.id, t.path, t.path, 0));
    });
    pickerMru.replaceChildren(mru);
  }

  // Move mode: build the album tree from the flat /api/albums list — index by
  // path, attach children to parents (every ancestor of an album is itself an
  // album), sort siblings by name, DFS into indented item rows. The items'
  // album is highlighted `.current` when they all share one (its display path
  // comes from the same album_display_path as /api/albums, so they match
  // textually). Also records each item's album id, for undo.
  function buildAlbumRows(albums) {
    var byPath = {};
    albums.forEach(function (a) { byPath[a.path] = { a: a, children: [] }; });
    var roots = [];
    albums.forEach(function (a) {
      var slash = a.path.lastIndexOf('/');
      var parent = slash > 0 ? byPath[a.path.slice(0, slash)] : null;
      (parent ? parent.children : roots).push(byPath[a.path]);
    });
    function baseName(path) { return path.slice(path.lastIndexOf('/') + 1); }
    function byName(x, y) {
      var nx = baseName(x.a.path).toLowerCase(), ny = baseName(y.a.path).toLowerCase();
      return nx < ny ? -1 : nx > ny ? 1 : 0;
    }
    moveSources = {};
    moveShared = pickerPhotos[0].album_path;
    pickerPhotos.forEach(function (p) {
      var n = byPath[p.album_path];
      moveSources[p.id] = n ? { id: n.a.id, path: p.album_path } : null;
      if (p.album_path !== moveShared) moveShared = null;
    });
    var frag = document.createDocumentFragment();
    function walk(nodes, depth) {
      nodes.sort(byName);
      nodes.forEach(function (n) {
        var row = pickerRow('item', n.a.id, n.a.path, baseName(n.a.path), depth);
        if (n.a.path === moveShared) row.classList.add('current');
        frag.appendChild(row);
        walk(n.children, depth + 1);
      });
    }
    walk(roots, 0);
    pickerList.replaceChildren(frag);

    // MRU move targets, skipping albums that no longer exist (or were renamed).
    var mru = document.createDocumentFragment();
    albumMru.list().forEach(function (t) {
      if (byPath[t.path] && byPath[t.path].a.id === t.id) {
        mru.appendChild(pickerRow('item', t.id, t.path, t.path, 0));
      }
    });
    pickerMru.replaceChildren(mru);
  }

  // Quick filter: case-insensitive substring match against the entry's full
  // absolute path — "foo" matches /foo, /foobar, /barfoo, /foo/bar, and (since
  // a descendant's path contains its ancestors') everything under a match.
  // Non-matching ancestors of a match stay visible for context, dimmed (.ctx).
  function applyPickerFilter() {
    var q = pickerFilter.value.trim().toLowerCase();
    // The MRU rows: a plain path-substring match (flat — no ancestor logic).
    // The section (and its divider) disappears when nothing in it is visible.
    var anyMru = false;
    Array.prototype.forEach.call(pickerMru.children, function (row) {
      var match = !q || row.dataset.path.toLowerCase().indexOf(q) !== -1;
      row.hidden = !match;
      anyMru = anyMru || match;
    });
    pickerMru.hidden = !anyMru;
    pickerMruLabel.hidden = !anyMru; // the label goes with its section
    var anc = []; // current ancestor chain, indexed by depth (rows are in DFS order)
    Array.prototype.forEach.call(pickerList.children, function (row) {
      var d = +row.style.getPropertyValue('--depth');
      anc[d] = row;
      anc.length = d + 1;
      var match = !q || row.dataset.path.toLowerCase().indexOf(q) !== -1;
      row.hidden = !match;
      row.classList.remove('ctx');
      if (match && q) {
        for (var i = 0; i < d; i++) {
          if (anc[i].hidden) { anc[i].hidden = false; anc[i].classList.add('ctx'); }
        }
      }
    });
  }

  // True when any tags-mode row has a pending change.
  function tagsDirty() {
    return Array.prototype.some.call(pickerList.querySelectorAll('.picker-row input'), function (cb) {
      return cb.dataset.cur !== cb.dataset.orig;
    });
  }
  // Apply (and Enter) is enabled only with pending changes: an Enter on an
  // unchanged modal would otherwise close it silently — after navigating to a
  // tag and hitting Enter without Space, that reads as "tag added" when
  // nothing happened. The dimmed Apply button makes the no-op state visible.
  function updateApplyState() {
    if (pickerMode === 'tags') pickerApplyBtn.disabled = busy || !tagsDirty();
  }

  // All visible focus targets in DOM order (the tree first, then the MRU
  // section — the arrow keys walk them as one sequence): the checkboxes in
  // tags mode, the rows themselves in move mode.
  function visiblePickerBoxes() {
    var suffix = pickerMode === 'move' ? '' : ' input';
    return Array.prototype.slice.call(pickerEl.querySelectorAll(
      '.picker-list .picker-row:not([hidden])' + suffix + ', ' +
      '.picker-mru:not([hidden]) .picker-row:not([hidden])' + suffix));
  }

  // Tags mode commit: from the rows with pending changes, work out per item
  // what it lacks / has, send one PATCH per item that changes, and push one
  // undo op for the whole batch (reversing exactly what was applied).
  function applyTags() {
    var ps = pickerPhotos;
    if (!ps) { closePicker(); return; }
    if (busy) return;
    var want = []; // {id, path, on} per changed tag (the tree has each tag once)
    Array.prototype.forEach.call(pickerList.querySelectorAll('.picker-row input'), function (cb) {
      if (cb.dataset.cur !== cb.dataset.orig) {
        want.push({ id: +cb.dataset.id, path: cb.dataset.path, on: cb.dataset.cur === 'on' });
      }
    });
    var changes = [];
    ps.forEach(function (p) {
      var has = photoTags[p.id] || {};
      var c = { photo: p, add: [], addPaths: [], rem: [], remPaths: [] };
      want.forEach(function (w) {
        if (w.on && !has[w.path]) { c.add.push(w.id); c.addPaths.push(w.path); }
        else if (!w.on && has[w.path]) { c.rem.push(w.id); c.remPaths.push(w.path); }
      });
      if (c.add.length || c.rem.length) changes.push(c);
    });
    // Nothing pending: do NOT close — a silent close after Enter would look
    // like a successful add. Apply is disabled in this state; Esc leaves.
    if (!changes.length) return;
    var adds = want.filter(function (w) { return w.on; });
    var summary = adds.map(function (w) { return '+' + w.path; })
      .concat(want.filter(function (w) { return !w.on; }).map(function (w) { return '−' + w.path; }))
      .join(' ');
    busy = true;
    updateApplyState();
    runPool(changes.map(function (c) {
      return function () { return applyTagChange(c.photo.id, c.add, c.addPaths, c.rem, c.remPaths); };
    }), 4).then(function (res) {
      busy = false;
      updateApplyState();
      var done = changes.filter(function (c, i) { return res[i].ok; });
      var failed = changes.length - done.length;
      if (!done.length) {
        // Keep the picker (and its pending state) so Enter retries or Esc bails.
        toast('tags not saved', true);
        return;
      }
      // Adds count as "used"; removals don't touch the MRU.
      tagMru.used(adds.map(function (w) { return w.id; }), adds.map(function (w) { return w.path; }));
      if (pickerPhotos === ps) closePicker();
      var label = 'tags of ' + itemsLabel(done.map(function (c) { return c.photo; })) + ': ' + summary;
      toast(failed ? label + ' (' + failed + ' of ' + changes.length + ' items failed)' : label, failed > 0);
      pushUndo({
        label: label,
        undo: function () {
          return undoAll(done.map(function (c) {
            return function () { return applyTagChange(c.photo.id, c.rem, c.remPaths, c.add, c.addPaths); };
          }));
        }
      });
    });
  }

  // Activate a move-mode row (click, or Enter while focused): PATCH every item
  // not already there into that album, record the target in the MRU, and push
  // the reverse moves onto the undo stack. Activating the items' own album
  // just closes.
  function moveToRow(row) {
    var ps = pickerPhotos;
    if (!ps) { closePicker(); return; }
    if (busy) return;
    var toId = +row.dataset.id, toPath = row.dataset.path;
    var todo = ps.filter(function (p) { return p.album_path !== toPath; });
    if (!todo.length) { closePicker(); return; }
    var from = {};
    todo.forEach(function (p) { from[p.id] = moveSources[p.id]; });
    busy = true;
    runPool(todo.map(function (p) {
      return function () { return applyMove(p.id, toId, toPath); };
    }), 4).then(function (res) {
      busy = false;
      var done = todo.filter(function (p, i) { return res[i].ok; });
      var failed = todo.length - done.length;
      if (!done.length) {
        // Keep the picker open (e.g. a 409 name collision) — pick another
        // target, retry, or Esc.
        toast('move failed', true);
        return;
      }
      albumMru.used([toId], [toPath]);
      if (pickerPhotos === ps) closePicker();
      var msg = 'moved ' + itemsLabel(done) + ' → ' + toPath;
      toast(failed ? msg + ' (' + failed + ' of ' + todo.length + ' items failed)' : msg, failed > 0);
      // Undo needs each source album's id; an item whose album wasn't in the
      // listing at open time (shouldn't happen) just isn't moved back.
      var back = done.filter(function (p) { return from[p.id]; });
      if (!back.length) return;
      pushUndo({
        label: back.length === 1
          ? 'move of ' + back[0].name + ' (' + from[back[0].id].path + ' → ' + toPath + ')'
          : 'move of ' + itemsLabel(back) + ' → ' + toPath,
        undo: function () {
          return undoAll(back.map(function (p) {
            return function () { return applyMove(p.id, from[p.id].id, from[p.id].path); };
          }));
        }
      });
    });
  }

  // Replay an undo's per-item reversals; rejects if any failed, so undo.js puts
  // the op back for a retry. Replaying the already-reversed ones again is
  // harmless: re-adding a present tag, re-removing an absent one, or moving an
  // item to the album it's in are all no-ops on the server.
  function undoAll(tasks) {
    return runPool(tasks, 4).then(function (res) {
      if (res.some(function (r) { return !r.ok; })) throw new Error('undo incomplete');
    });
  }

  // PATCH one item's tag delta and sync the local view: the cached
  // PhotoDetail (tags are shown in the info panel), the open panel, and — if
  // the tags picker is open on this item (an undo can land there) — its row
  // states. Shared by apply and undo, so it works purely from ids/paths (no
  // captured DOM).
  function applyTagChange(photoId, addIds, addPaths, removeIds, removePaths) {
    return fetch('/api/photos/' + photoId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags_add: addIds, tags_remove: removeIds })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var meta = metaCache[photoId];
      if (meta && meta.tags) {
        var t = meta.tags.filter(function (x) { return removePaths.indexOf(x) === -1; });
        addPaths.forEach(function (x) { if (t.indexOf(x) === -1) t.push(x); });
        t.sort(function (a, b) {
          a = a.toLowerCase(); b = b.toLowerCase();
          return a < b ? -1 : a > b ? 1 : 0;
        });
        meta.tags = t;
      }
      LB.photoChanged(photoId);
      var set = pickerOpen && pickerMode === 'tags' && photoTags[photoId];
      if (set) {
        removePaths.forEach(function (x) { if (set[x]) { delete set[x]; tagCounts[x]--; } });
        addPaths.forEach(function (x) { if (!set[x]) { set[x] = true; tagCounts[x] = (tagCounts[x] || 0) + 1; } });
        rederiveRows();
      }
    });
  }

  // PATCH an item into another album (the server also renames the file on
  // disk) and sync the local view. Shared by the picker and undo, so it works
  // from ids/paths only. The grid tile deliberately stays until the next
  // re-render — removing it live would desync the open lightbox's items.
  function applyMove(photoId, albumId, albumPath) {
    return fetch('/api/photos/' + photoId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album: albumId })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var p = gridPhotos[photoId];
      if (p) p.album_path = albumPath;
      // The cached PhotoDetail's file_path is stale now; drop it — the open
      // info panel refetches lazily via the usual loadMeta path.
      delete metaCache[photoId];
      LB.photoChanged(photoId);
    });
  }

  pickerFilter.addEventListener('input', applyPickerFilter);
  // Modal keys are handled here (and stopPropagation'd so the page's own
  // document-level bindings — the lightbox's r, i, s, arrows, the grid's
  // navigation, … — don't also fire).
  pickerFilter.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (pickerMode === 'move') {
        // Type-and-Enter: move to the first real match (never a dim .ctx
        // ancestor), and only with a non-empty query — a stray Enter on the
        // empty filter must not move anything.
        if (pickerFilter.value.trim()) {
          var hit = pickerEl.querySelector(
            '.picker-list .picker-row:not([hidden]):not(.ctx), ' +
            '.picker-mru:not([hidden]) .picker-row:not([hidden])');
          if (hit) moveToRow(hit);
        }
      } else {
        pickerApply();
      }
    }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // The filter sits below the rows, and the arrows cycle through
      // rows + filter: ArrowUp goes to the row just above (the last one),
      // ArrowDown wraps around to the first.
      e.preventDefault();
      var boxes = visiblePickerBoxes();
      var target = e.key === 'ArrowUp' ? boxes[boxes.length - 1] : boxes[0];
      if (target) {
        target.focus();
        target.closest('.picker-row').scrollIntoView({ block: 'nearest' });
      }
    }
  });
  // Keys on the rows (MRU + tree) and buttons. The filter input's own handler
  // above stopPropagation's, so its keys never reach this one.
  pickerEl.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
    if (e.target.closest('button')) return; // Enter on Cancel/Apply = native click
    if (e.key === 'Enter') {
      e.preventDefault();
      var row = pickerMode === 'move' && e.target.closest('.picker-row');
      if (row) moveToRow(row); else pickerApply();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var boxes = visiblePickerBoxes();
      var i = boxes.indexOf(document.activeElement);
      if (i === -1) return;
      var n = i + (e.key === 'ArrowDown' ? 1 : -1);
      // Off either end: back to the filter (the cycle described above).
      if (n < 0 || n >= boxes.length) { pickerFilter.focus(); return; }
      boxes[n].focus();
      boxes[n].closest('.picker-row').scrollIntoView({ block: 'nearest' });
    }
    // Space is the native checkbox toggle (tags mode), which the click
    // handler below turns into the row's next state. Move-mode rows don't
    // react to Space.
  });
  // Clicks stay in the picker (it covers the page or the lightbox). One on the
  // backdrop itself — outside the dialog box — discards it. In tags mode a
  // checkbox click (also a click on its label, or Space) steps the row's state;
  // in move mode a click on a row activates it directly — the click IS the
  // move, no selection step.
  pickerEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (e.target === pickerEl) { closePicker(); return; }
    if (pickerMode === 'tags') {
      var cb = e.target;
      if (cb.type === 'checkbox' && cb.dataset.id) cycleBox(cb);
      return;
    }
    var row = e.target.closest('.picker-row');
    if (row) moveToRow(row);
  });
  pickerEl.querySelector('.picker-apply').addEventListener('click', pickerApply);
  pickerEl.querySelector('.picker-cancel').addEventListener('click', closePicker);

  PICKER = {
    isOpen: function () { return pickerOpen; },
    open: openPicker,
    close: closePicker,
    toggle: togglePicker,
    apply: pickerApply
  };
}
