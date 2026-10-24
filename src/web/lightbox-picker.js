// ===== Lightbox: picker modal ================================================
// The `t` (tags) / `v` (move to album) modal. Part of the lightbox (lightbox.js
// passes in its `core`); returns the picker's API.
function initLightboxPicker(core) {
  var lb = core.lb;
  // ----- Picker modal (`t` = tags, `v` = move to album) -----
  // One modal, two modes, same machinery (quick filter, MRU section, keyboard
  // model, Cancel + primary button, and all the lightbox handler guards):
  // - 'tags': a transactional editor for the current item's tags — checkbox
  //   rows (checked = the image has that tag). Clicks / Space toggle LOCALLY;
  //   Enter/Apply commits all pending changes in one PATCH (one undo op for
  //   the batch); Esc/Cancel/outside-click/navigating discards them.
  // - 'move': the album hierarchy as directly-activatable rows (menu-like, no
  //   selection state): clicking a row, or arrow-navigating to it and hitting
  //   Enter, PATCHes the photo into that album — the server moves the file on
  //   disk too — and pushes the reverse move onto the undo stack. The photo's
  //   current album is highlighted (activating it just closes). Enter in the
  //   filter moves to the first match (only with a non-empty query, so a stray
  //   Enter can't move anything). No primary footer button — a click/tap on a
  //   row IS the action.
  var pickerEl = document.getElementById('lb-picker');
  var pickerFilter = document.getElementById('lb-picker-filter');
  var pickerMru = pickerEl.querySelector('.picker-mru');
  var pickerList = pickerEl.querySelector('.picker-list');
  var pickerMruLabel = pickerEl.querySelector('.picker-label-mru');
  var pickerListLabel = pickerEl.querySelector('.picker-label-list');
  var pickerApplyBtn = pickerEl.querySelector('.picker-apply');
  var pickerOpen = false;
  var pickerMode = null;   // 'tags' | 'move' while open
  var pickerPhoto = null;  // the PhotoSummary the open picker is editing
  var tagsOriginal = {};   // tags mode: path -> true, the set at open time
  var moveCurrentId = null; // move mode: the photo's current album id

  // A most-recently-used list — the last 10 tags added / move targets (each
  // use moves it to the front; tag removals don't touch it). Shown flat, as
  // full paths, between the quick filter and the tree. Persisted in
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
      list: function () { return list; },
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

  function openPicker(mode) {
    var p = core.photo();
    if (!p) return;
    if (core.slideshow.panelOpen()) core.slideshow.setPanel(false); // one modal at a time
    pickerMode = mode;
    pickerPhoto = p;
    pickerOpen = true;
    lb.classList.add('picker-open');
    pickerFilter.value = '';
    pickerMru.replaceChildren();
    pickerList.replaceChildren();
    pickerMruLabel.hidden = true; // shown once the MRU rows are built (if any)
    pickerListLabel.textContent = mode === 'move' ? 'Albums' : 'Tags';
    // Move mode has no commit step (activating a row IS the action), so the
    // primary footer button only exists for tags mode — and starts disabled
    // there (nothing changed yet).
    pickerApplyBtn.hidden = mode === 'move';
    pickerApplyBtn.disabled = true;
    function fail() {
      if (pickerOpen) { closePicker(); toast('could not load ' + mode + ' data', true); }
    }
    if (mode === 'tags') {
      // The hierarchy (fresh each open — it's small) + this photo's current tags.
      Promise.all([
        fetch('/api/tags').then(function (r) { return r.json(); }),
        core.info.loadMeta(p.id)
      ]).then(function (res) {
        if (!pickerOpen || pickerPhoto !== p || pickerMode !== 'tags') return;
        buildTagRows(res[0], res[1].tags || []);
        applyPickerFilter();
      }).catch(fail);
    } else {
      fetch('/api/albums').then(function (r) { return r.json(); }).then(function (albums) {
        if (!pickerOpen || pickerPhoto !== p || pickerMode !== 'move') return;
        buildAlbumRows(albums);
        applyPickerFilter();
      }).catch(fail);
    }
    pickerFilter.focus();
    core.wake();
  }
  function closePicker() {
    pickerOpen = false;
    pickerMode = null;
    pickerPhoto = null;
    // Drop focus from the (now hidden) picker: left on the filter input, its
    // keydown handler swallows every key, so the lightbox's own bindings
    // (arrows, i, s, …) go dead — until the browser gets round to blurring the
    // hidden element (Chrome: its next rendering update; not every browser).
    if (pickerEl.contains(document.activeElement)) document.activeElement.blur();
    lb.classList.remove('picker-open');
    pickerMru.replaceChildren();
    pickerList.replaceChildren();
  }
  function togglePicker(mode) {
    if (pickerOpen && pickerMode === mode) { closePicker(); return; }
    if (pickerOpen) closePicker();
    openPicker(mode);
  }
  // Enter / the primary button when no specific row is the target: commits the
  // tag batch; in move mode there's nothing to commit (activating a row is the
  // action), so it's a no-op.
  function pickerApply() {
    if (pickerMode === 'tags') applyTags();
  }

  // One row. `kind` is 'checkbox' (tags mode: a label wrapping a checkbox) or
  // 'item' (move mode: a bare focusable row — activating it is the action, so
  // there's no input at all). The entry's id/path live on the row (the filter
  // and move activation read them there); tags mode duplicates them onto the
  // checkbox for the apply diff and the twin-mirroring change listener.
  function pickerRow(kind, id, path, text, depth) {
    var row;
    if (kind === 'checkbox') {
      row = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!tagsOriginal[path];
      cb.dataset.id = id;
      cb.dataset.path = path;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(text));
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
  // name-sorted per level by the server), checked for the photo's current tags.
  function buildTagRows(tree, currentPaths) {
    tagsOriginal = {};
    currentPaths.forEach(function (t) { tagsOriginal[t] = true; });
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
  // album), sort siblings by name, DFS into indented item rows. The photo's
  // current album is highlighted `.current` (its display path comes from the
  // same album_display_path as /api/albums, so they match textually).
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
    moveCurrentId = null;
    var frag = document.createDocumentFragment();
    function walk(nodes, depth) {
      nodes.sort(byName);
      nodes.forEach(function (n) {
        var row = pickerRow('item', n.a.id, n.a.path, baseName(n.a.path), depth);
        if (n.a.path === pickerPhoto.album_path) {
          row.classList.add('current');
          moveCurrentId = n.a.id;
        }
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

  // True when any tags-mode checkbox differs from the open-time tag set.
  function tagsDirty() {
    var dirty = false;
    Array.prototype.forEach.call(pickerList.querySelectorAll('.picker-row input'), function (cb) {
      if (cb.checked !== !!tagsOriginal[cb.dataset.path]) dirty = true;
    });
    return dirty;
  }
  // Apply (and Enter) is enabled only with pending changes: an Enter on an
  // unchanged modal would otherwise close it silently — after navigating to a
  // tag and hitting Enter without Space, that reads as "tag added" when
  // nothing happened. The dimmed Apply button makes the no-op state visible.
  function updateApplyState() {
    if (pickerMode === 'tags') pickerApplyBtn.disabled = !tagsDirty();
  }

  // All visible focus targets in DOM order (the MRU section first, then the
  // tree — ArrowDown from the filter walks them as one sequence): the
  // checkboxes in tags mode, the rows themselves in move mode.
  function visiblePickerBoxes() {
    var suffix = pickerMode === 'move' ? '' : ' input';
    return Array.prototype.slice.call(pickerEl.querySelectorAll(
      '.picker-mru:not([hidden]) .picker-row:not([hidden])' + suffix + ', ' +
      '.picker-list .picker-row:not([hidden])' + suffix));
  }

  // Tags mode commit: diff the checkboxes against the set at open time, send
  // one PATCH, push one undo op for the whole batch.
  function applyTags() {
    var p = pickerPhoto;
    if (!p) { closePicker(); return; }
    var add = [], addPaths = [], rem = [], remPaths = [];
    Array.prototype.forEach.call(pickerList.querySelectorAll('.picker-row input'), function (cb) {
      var had = !!tagsOriginal[cb.dataset.path];
      if (cb.checked && !had) { add.push(+cb.dataset.id); addPaths.push(cb.dataset.path); }
      else if (!cb.checked && had) { rem.push(+cb.dataset.id); remPaths.push(cb.dataset.path); }
    });
    // Nothing pending: do NOT close — a silent close after Enter would look
    // like a successful add. Apply is disabled in this state; Esc leaves.
    if (!add.length && !rem.length) return;
    var label = 'tags of ' + p.name + ': ' +
      addPaths.map(function (t) { return '+' + t; })
        .concat(remPaths.map(function (t) { return '−' + t; })).join(' ');
    applyTagChange(p.id, add, addPaths, rem, remPaths).then(function () {
      tagMru.used(add, addPaths); // adds count as "used"; removals don't touch MRU
      closePicker();
      toast(label);
      pushUndo({
        label: label,
        undo: function () { return applyTagChange(p.id, rem, remPaths, add, addPaths); }
      });
    }, function () {
      // Keep the picker (and its pending state) so Enter retries or Esc bails.
      toast('tags not saved', true);
    });
  }

  // Activate a move-mode row (click, or Enter while focused): PATCH the photo
  // into that album, record the target in the MRU, and push the reverse move
  // onto the undo stack. Activating the current album just closes.
  function moveToRow(row) {
    var p = pickerPhoto;
    if (!p) { closePicker(); return; }
    var toId = +row.dataset.id, toPath = row.dataset.path;
    if (toId === moveCurrentId) { closePicker(); return; }
    var fromId = moveCurrentId, fromPath = p.album_path;
    applyMove(p.id, toId, toPath).then(function () {
      albumMru.used([toId], [toPath]);
      closePicker();
      toast('moved ' + p.name + ' → ' + toPath);
      // Undo needs the source album's id; if none matched the photo's album at
      // open time (shouldn't happen), the move just isn't undoable.
      if (fromId != null) {
        pushUndo({
          label: 'move of ' + p.name + ' (' + fromPath + ' → ' + toPath + ')',
          undo: function () { return applyMove(p.id, fromId, fromPath); }
        });
      }
    }, function () {
      // Keep the picker open (e.g. a 409 name collision) — pick another
      // target, retry, or Esc.
      toast('move failed', true);
    });
  }

  // PATCH a tag delta and sync the local view: the cached PhotoDetail (tags are
  // shown in the info panel), the open panel, and — if the tags picker is
  // showing this photo (an undo can land there) — its checkboxes + baseline.
  // Shared by apply and undo, so it works purely from ids/paths (no captured DOM).
  function applyTagChange(photoId, addIds, addPaths, removeIds, removePaths) {
    return fetch('/api/photos/' + photoId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags_add: addIds, tags_remove: removeIds })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var meta = core.info.metaCache[photoId];
      if (meta && meta.tags) {
        var t = meta.tags.filter(function (x) { return removePaths.indexOf(x) === -1; });
        addPaths.forEach(function (x) { if (t.indexOf(x) === -1) t.push(x); });
        t.sort(function (a, b) {
          a = a.toLowerCase(); b = b.toLowerCase();
          return a < b ? -1 : a > b ? 1 : 0;
        });
        meta.tags = t;
      }
      core.info.renderIfShowing(photoId);
      if (pickerOpen && pickerMode === 'tags' && pickerPhoto && pickerPhoto.id === photoId) {
        removePaths.forEach(function (x) { delete tagsOriginal[x]; });
        addPaths.forEach(function (x) { tagsOriginal[x] = true; });
        Array.prototype.forEach.call(pickerEl.querySelectorAll('.picker-row input'), function (cb) {
          if (addPaths.indexOf(cb.dataset.path) !== -1) cb.checked = true;
          if (removePaths.indexOf(cb.dataset.path) !== -1) cb.checked = false;
        });
        updateApplyState();
      }
    });
  }

  // PATCH a photo into another album (the server also renames the file on
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
      core.items().forEach(function (it) {
        if (it.photo && it.photo.id === photoId) it.photo.album_path = albumPath;
      });
      // The cached PhotoDetail's file_path is stale now; drop it — the open
      // info panel refetches lazily via the usual loadMeta path.
      delete core.info.metaCache[photoId];
      core.info.renderIfShowing(photoId);
    });
  }

  pickerFilter.addEventListener('input', applyPickerFilter);
  // Modal keys are handled here (and stopPropagation'd so the lightbox's own
  // document-level bindings — r, i, s, arrows, … — don't also fire).
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
            '.picker-mru:not([hidden]) .picker-row:not([hidden]), ' +
            '.picker-list .picker-row:not([hidden]):not(.ctx)');
          if (hit) moveToRow(hit);
        }
      } else {
        pickerApply();
      }
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      var first = visiblePickerBoxes()[0];
      if (first) {
        first.focus();
        first.closest('.picker-row').scrollIntoView({ block: 'nearest' });
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
      if (n < 0) { pickerFilter.focus(); return; }
      if (n < boxes.length) {
        boxes[n].focus();
        boxes[n].closest('.picker-row').scrollIntoView({ block: 'nearest' });
      }
    }
    // Space is the native checkbox toggle (tags mode) — a local pending
    // change, left alone. Move-mode rows don't react to Space.
  });
  // The same tag can be shown twice (MRU + tree): mirror a toggle onto every
  // checkbox with the same tag id. (Move-mode rows have no inputs at all.)
  pickerEl.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb.type !== 'checkbox' || !cb.dataset.id) return;
    Array.prototype.forEach.call(
      pickerEl.querySelectorAll('.picker-row input[data-id="' + cb.dataset.id + '"]'),
      function (other) { other.checked = cb.checked; });
    updateApplyState();
  });
  // Clicks inside the picker stay in it (the lb handler treats any click with
  // the picker open as a discard, see below). In move mode a click on a row
  // activates it directly — the click IS the move, no selection step.
  pickerEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (pickerMode !== 'move') return;
    var row = e.target.closest('.picker-row');
    if (row) moveToRow(row);
  });
  pickerEl.querySelector('.picker-apply').addEventListener('click', pickerApply);
  pickerEl.querySelector('.picker-cancel').addEventListener('click', closePicker);

  return {
    isOpen: function () { return pickerOpen; },
    close: closePicker,
    toggle: togglePicker,
    apply: pickerApply
  };
}
