// ===== Lightbox: info panel + rating =========================================
// The ⓘ metadata overlay (#lb-info) and the rating it edits (the panel's stars,
// Ctrl+0..5): filled from the current item's PhotoSummary plus its lazily-fetched
// PhotoDetail. Part of the lightbox (lightbox.js passes in its `core`); returns
// the panel's API.
function initLightboxInfo(core) {
  var infoEl = document.getElementById('lb-info');
  var infoOpen = false; // image-info panel visible (then controls don't auto-hide)

  // Human-readable file size and a tidied modification date for the info panel.
  function fmtBytes(n) {
    if (n == null) return null;
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (i === 0 ? x : x.toFixed(1)) + ' ' + u[i];
  }
  function fmtDate(s) { return s ? s.replace('T', ' ').replace(/\.\d+$/, '') : null; }

  // A signed decimal coordinate as degrees/minutes/seconds, e.g. 45°52'36"N.
  function dms(value, posChar, negChar) {
    var hemi = value >= 0 ? posChar : negChar;
    var v = Math.abs(value);
    var deg = Math.floor(v);
    var min = Math.floor((v - deg) * 60);
    var sec = Math.round((v - deg - min / 60) * 3600);
    if (sec === 60) { sec = 0; min++; }   // carry rounding overflow
    if (min === 60) { min = 0; deg++; }
    return deg + '°' + min + "'" + sec + '"' + hemi;
  }

  // The PhotoDetail fields not in the PhotoSummary (creation_date, tags as absolute
  // paths, lat/long) come from /api/photos/:id — fetched lazily, only while the info
  // panel is open, and cached per id for the session. Only successes are cached:
  // a failed fetch (network error, non-2xx) rejects, and the next render retries
  // — caching a fallback would show the photo as untagged until a reload. A
  // request already in flight for the id is shared rather than repeated.
  var metaCache = {};
  var metaPending = {};
  function loadMeta(id) {
    if (metaCache[id] !== undefined) return Promise.resolve(metaCache[id]);
    if (metaPending[id]) return metaPending[id];
    var req = fetch('/api/photos/' + id)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (m) { metaCache[id] = m; return m; });
    metaPending[id] = req;
    function settle() { delete metaPending[id]; }
    req.then(settle, settle);
    return req;
  }

  // Fill the info panel from the current item's PhotoSummary (skipping any
  // missing field). Called when the panel is open, including while navigating.
  function renderInfo() {
    var p = core.photo();
    if (!p) { infoEl.replaceChildren(); return; }
    // The album is a link that jumps to that album (carrying the active filters).
    var album = null;
    if (p.album_path) {
      album = document.createElement('a');
      album.className = 'album-link';
      album.href = albumHref(p.album_path);
      album.textContent = p.album_path;
    }
    // Tags come from the lazily-fetched metadata; the row appears once it loads,
    // one tag (absolute path) per line. Each is a link that filters the current
    // album by just that tag (replacing any current tag filter, keeping the other
    // filters) — routed through jumpToAlbum like the album link.
    var meta = metaCache[p.id];
    var tags = null;
    if (meta && meta.tags && meta.tags.length) {
      tags = document.createDocumentFragment();
      meta.tags.forEach(function (name) {
        var line = document.createElement('a');
        line.className = 'tag-link';
        line.textContent = name;
        line.href = photosUrl(state.album, filters({ tags: [name] }));
        tags.appendChild(line);
      });
    }
    // Description: the image's ImageComments, concatenated (newlines preserved via
    // CSS). From the lazily-fetched metadata, so it appears once loaded.
    var desc = null;
    if (meta && meta.description) {
      desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = meta.description;
    }
    // Location: a link to the coordinates on Google Maps (opens in a new tab).
    var loc = null;
    if (meta && meta.latitude != null && meta.longitude != null) {
      loc = document.createElement('a');
      loc.target = '_blank';
      loc.rel = 'noopener';
      loc.href = 'https://www.google.com/maps/search/?api=1&query='
        + encodeURIComponent(meta.latitude + ',' + meta.longitude);
      loc.textContent = dms(meta.latitude, 'N', 'S') + ' ' + dms(meta.longitude, 'E', 'W');
    }
    // File name, plus — once the lazily-fetched metadata provides `file_path` — a
    // button that copies the absolute server path to the clipboard.
    var fileCell = document.createDocumentFragment();
    fileCell.append(p.name);
    if (meta && meta.file_path) {
      fileCell.append(' ');
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-path';
      copyBtn.title = 'Copy server path';
      copyBtn.setAttribute('aria-label', 'Copy file path to clipboard');
      copyBtn.textContent = '⧉';
      copyBtn.dataset.path = meta.file_path;
      fileCell.appendChild(copyBtn);
    }
    // Rating: five clickable stars. Clicking star K sets the rating to K;
    // clicking the currently-set star clears back to unrated (like the navbar
    // filter stars). Always shown, so an unrated item can be rated too.
    var stars = document.createElement('span');
    stars.className = 'rate';
    for (var s = 1; s <= 5; s++) {
      var st = document.createElement('button');
      st.type = 'button';
      var on = p.rating != null && s <= p.rating;
      st.className = 'rate-star' + (on ? ' on' : '');
      st.dataset.value = s;
      st.textContent = on ? '★' : '☆';
      st.title = p.rating === s ? 'Clear rating' : 'Rate ' + s + (s > 1 ? ' stars' : ' star');
      stars.appendChild(st);
    }
    // Format + MIME on one row, e.g. "jpg (image/jpeg)".
    var fmt = p.format ? p.format.toLowerCase() : null;
    var format = (fmt && p.mime) ? (fmt + ' (' + p.mime + ')') : (fmt || p.mime || null);
    var rows = [
      ['File', fileCell],
      ['Album', album],
      ['Rating', stars],
      ['Format', format],
      ['Size', fmtBytes(p.file_size)],
      ['Resolution', (p.width && p.height) ? (p.width + ' × ' + p.height) : null],
      ['Modified', fmtDate(p.modification_date)],
      ['Created', meta ? fmtDate(meta.creation_date) : null],
      ['Description', desc],
      ['Location', loc],
      ['Tags', tags]
    ];
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var val = r[1];
      if (val == null || val === '') return;
      var row = document.createElement('div'); row.className = 'row';
      var k = document.createElement('span'); k.className = 'k'; k.textContent = r[0];
      var v = document.createElement('span'); v.className = 'v';
      if (val instanceof Node) v.appendChild(val); else v.textContent = val;
      row.appendChild(k); row.appendChild(v);
      frag.appendChild(row);
    });
    infoEl.replaceChildren(frag);

    // First time we show this item's panel: fetch its metadata, then re-render to
    // add the Tags row — but only if it's still the item on screen with the panel open.
    // On failure the panel just keeps the summary fields (the next render retries).
    if (meta === undefined) {
      loadMeta(p.id).then(function () {
        renderIfShowing(p.id);
      }, function () {});
    }
  }

  function setInfo(on) {
    infoOpen = on;
    core.lb.classList.toggle('info-open', on);
    if (on) renderInfo();
    core.wake(); // re-arm or suspend the auto-hide, and reveal the controls
  }
  function toggleInfo() { setInfo(!infoOpen); }

  // Re-render the open panel if it is showing photo `id` (after its data changed).
  function renderIfShowing(id) {
    var p = core.photo();
    if (infoOpen && p && p.id === id) renderInfo();
  }

  // Human-readable stars for toasts/labels ("★★★☆☆", or "unrated").
  function fmtStars(k) {
    return k != null ? '★'.repeat(k) + '☆'.repeat(5 - k) : 'unrated';
  }
  // PATCH a photo's rating (k = 0..5, or null to clear) and sync the local
  // view; returns the fetch Promise (rejects on a non-2xx, e.g. the 403 of a
  // server without --allow-writes). Shared by user-initiated changes and undo,
  // so it looks the photo up by id rather than trusting a captured object: the
  // current tiles' `_photo`s (the same objects as `items[].photo`) may have
  // been rebuilt — or the photo may have left the view entirely, in which case
  // the server change alone is the whole job.
  function applyRating(id, k) {
    return fetch('/api/photos/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: k })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      core.items().forEach(function (it) {
        if (it.photo && it.photo.id === id) it.photo.rating = k;
      });
      renderIfShowing(id);
    });
  }
  // Set (k = 1..5) or clear (k = null) the current item's rating, recording the
  // change on the undo stack (`u` reverses it). Confirmation: the re-rendered
  // panel stars when the panel is open, a toast otherwise (Ctrl+digit);
  // failures always toast.
  function setRating(k) {
    var p = core.photo();
    if (!p) return;
    var from = p.rating != null ? p.rating : null;
    if (from === k) return;
    var id = p.id, name = p.name;
    applyRating(id, k).then(function () {
      pushUndo({
        label: 'rating of ' + name + ' (' + fmtStars(from) + ' → ' + fmtStars(k) + ')',
        undo: function () { return applyRating(id, from); }
      });
      if (!infoOpen) toast(fmtStars(k));
    }, function () {
      toast('rating not saved', true);
    });
  }
  // A click/tap on panel star K: set rating K, or clear if K is the current one.
  function starClicked(btn) {
    var p = core.photo();
    if (!p) return;
    var k = +btn.dataset.value;
    setRating(p.rating === k ? null : k);
  }

  // Panel clicks must not bubble to the letterbox-close handler; the album link
  // navigates in-page instead of doing a full document load. (`suppressClick`
  // swallows the synthetic click from a touch tap, which the touch handler
  // (lightbox-gestures.js) already acted on.)
  infoEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (core.tapConsumed()) return;
    // The rating stars set/clear the rating via the write API.
    var rs = e.target.closest('.rate-star');
    if (rs) { e.preventDefault(); starClicked(rs); return; }
    // The copy-path button copies the absolute server path to the clipboard.
    var cp = e.target.closest('.copy-path');
    if (cp) { e.preventDefault(); copyPath(cp); return; }
    // Internal panel links (album / tag) navigate in-page via jumpToAlbum; an
    // external link (the maps link, target=_blank) falls through to open normally.
    var a = e.target.closest('a');
    if (a && a.target !== '_blank') { e.preventDefault(); core.jumpToAlbum(a.getAttribute('href')); }
  });

  // The info panel's ⧉: copies the tile's absolute server path.
  function copyPath(btn) {
    if (btn.dataset.path) core.copyText(btn.dataset.path, btn);
  }

  return {
    isOpen: function () { return infoOpen; },
    render: renderInfo,
    renderIfShowing: renderIfShowing,
    toggle: toggleInfo,
    loadMeta: loadMeta,
    metaCache: metaCache,
    setRating: setRating,
    starClicked: starClicked,
    copyPath: copyPath
  };
}
