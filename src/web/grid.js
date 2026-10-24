// ===== Grid + sub-album tiles ================================================
function buildTile(p) {
  var full = '/api/photos/' + p.id + '/file';
  // Reserve the tile's width from its aspect ratio (grid row height is 200px) so
  // the layout doesn't reflow as thumbnails decode in.
  var reserve = (p.width && p.height) ? ('width:' + Math.round(200 * p.width / p.height) + 'px') : '';
  if (p.is_video) {
    // Video tile: a ▶-badged button with an inner poster fed by the thumbnail
    // pipeline (no data-full, so a missing thumbnail just leaves the ▶). The
    // button (a direct grid child) carries the media URL for the lightbox.
    var btn = document.createElement('button');
    btn.className = 'vtile';
    btn.id = 'item-' + p.id; // keyboard-nav selection target + URL fragment
    btn.dataset.src = full;
    btn.title = p.name || '';
    if (reserve) btn.style.cssText = reserve;
    var poster = document.createElement('img');
    poster.className = 'thumb';
    poster.dataset.id = p.id;
    poster.alt = '';
    btn.appendChild(poster);
    btn._photo = p; // the PhotoSummary, for the lightbox info panel
    return btn;
  }
  // Photo tile: src-less <img>; the pipeline paints the decoded thumbnail, and
  // `data-full` is the original (lightbox + decode fallback).
  var img = document.createElement('img');
  img.className = 'thumb';
  img.id = 'item-' + p.id; // keyboard-nav selection target + URL fragment
  img.dataset.id = p.id;
  img.dataset.full = full;
  img.alt = '';
  img.title = p.name || '';
  if (reserve) img.style.cssText = reserve;
  img._photo = p; // the PhotoSummary, for the lightbox info panel
  return img;
}

// Fetch /api/photos for the current album + filters and build the day-grouped
// grid. `token` is the render() generation: if a newer navigation has started by
// the time this resolves, bail before touching the DOM.
function buildGrid(host, token) {
  return fetch('/api/photos?' + apiParams().toString())
    .then(function (r) { return r.json(); })
    .then(function (page) {
      if (token !== renderToken) return;
      host.textContent = '';
      if (!page.items.length) {
        // A real album with no direct photos gets a note; the virtual root just
        // shows its sub-albums, with no message.
        if (state.album.length) {
          var none = document.createElement('p');
          none.textContent = 'No photos or videos in this album.';
          host.appendChild(none);
        }
        return;
      }
      var count = document.createElement('p');
      count.className = 'count';
      count.textContent = page.items.length + (page.incomplete ? '+' : '') + ' photo(s) or video(s)';
      host.appendChild(count);
      if (state.sort === 'name') {
        // Name sort: a single flat A–Z grid, no day grouping.
        var flat = document.createElement('div');
        flat.className = 'grid';
        host.appendChild(flat);
        page.items.forEach(function (p) { flat.appendChild(buildTile(p)); });
        return;
      }
      // Group into contiguous runs by day (the API already orders newest-first).
      // The grouping date follows the sort: creation date for `created`, else the
      // modification date.
      var dateField = state.sort === 'created' ? 'creation_date' : 'modification_date';
      var curDay = null, grid = null;
      page.items.forEach(function (p) {
        var d = p[dateField];
        var day = (d && d.length >= 10) ? d.slice(0, 10) : 'Unknown date';
        if (day !== curDay) {
          curDay = day;
          var h2 = document.createElement('h2');
          h2.textContent = day;
          host.appendChild(h2);
          grid = document.createElement('div');
          grid.className = 'grid';
          host.appendChild(grid);
        }
        grid.appendChild(buildTile(p));
      });
    })
    .catch(function () {
      if (token !== renderToken) return;
      host.textContent = '';
      var err = document.createElement('p');
      err.textContent = 'Failed to load photos or videos.';
      host.appendChild(err);
    });
}

// Fill `#subalbums` from /api/subalbums for the current album + filters (an empty
// album lists the roots). Each tile is the cover image (lazy thumbnail pipeline)
// with the bold name + count overlaid, linking to that sub-album.
function buildSubalbums(host, token) {
  return fetch('/api/subalbums?' + apiParams().toString())
    .then(function (r) { return r.json(); })
    .then(function (subs) {
      if (token !== renderToken) return;
      host.textContent = '';
      if (!subs.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'albums';
      subs.forEach(function (s) {
        var a = document.createElement('a');
        a.className = 'album';
        a.id = 'item-' + encodeURIComponent(s.name); // keyboard-nav target + fragment
        a.href = albumHref(s.path);
        if (s.cover) {
          var img = document.createElement('img');
          img.className = 'thumb';
          img.dataset.id = s.cover.id;
          // A video cover has a stored thumbnail but no still to fall back to, so
          // (like grid video posters) we don't set data-full on it.
          if (!s.cover.is_video) img.dataset.full = '/api/photos/' + s.cover.id + '/file';
          img.alt = '';
          a.appendChild(img);
        }
        var cap = document.createElement('span');
        cap.className = 'caption';
        var title = document.createElement('span');
        title.className = 'title';
        title.textContent = s.name;
        var cnt = document.createElement('span');
        cnt.className = 'cnt';
        cnt.textContent = '(' + s.photo_count + ')';
        cap.appendChild(title);
        cap.appendChild(document.createTextNode(' '));
        cap.appendChild(cnt);
        a.appendChild(cap);
        wrap.appendChild(a);
      });
      host.appendChild(wrap);
      initSubalbumCollapse(wrap, subs.length);
    })
    .catch(function () { if (token === renderToken) host.textContent = ''; });
}

// ===== Collapsible sub-album grid ============================================
// A long sub-album list pushes the album's photos a screen (or ten) down, so the
// tiles start collapsed to the first SUBALBUM_ROWS rows (`.albums.collapsed`, an
// inline max-height clip) with a "Show all N sub-albums" toggle underneath —
// unless the album has no photos of its own (render() then calls
// uncollapseSubalbums: there's nothing below to get to). Clipped tiles stay in
// the DOM: the thumbnail observer leaves their covers alone (IntersectionObserver
// honors the clip) and keyboard nav skips them (navItems). Each render starts
// collapsed again.
var SUBALBUM_ROWS = 2;
var subsResize = null;

// Set up the collapse on a freshly built (and attached) sub-album grid.
function initSubalbumCollapse(wrap, total) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'albums-toggle';
  wrap.after(btn);
  var expanded = false, collapsible = true;
  // (Re)measure: the rows wrap with the width, so whether anything overflows —
  // and where the clip goes — is decided from the live layout.
  function layout() {
    var rows = [], right = 0;
    for (var c = wrap.firstElementChild; c; c = c.nextElementSibling) {
      if (!rows.length || c.offsetTop > rows[rows.length - 1] + 1) rows.push(c.offsetTop);
      if (rows.length === 1) right = c.offsetLeft + c.offsetWidth; // first row's right edge
    }
    var clips = collapsible && rows.length > SUBALBUM_ROWS;
    var clipped = clips && !expanded;
    btn.hidden = !clips;
    // Span the tiles (the first, fullest row), not the container: the packed
    // tiles leave a ragged gap at the right.
    btn.style.width = (right - wrap.firstElementChild.offsetLeft) + 'px';
    btn.textContent = expanded ? 'Show fewer ▴' : 'Show all ' + total + ' sub-albums ▾';
    wrap.classList.toggle('collapsed', clipped);
    wrap.style.maxHeight = clipped
      ? (rows[SUBALBUM_ROWS - 1] - rows[0] + wrap.firstElementChild.offsetHeight) + 'px'
      : '';
  }
  wrap.__setExpanded = function (on) { expanded = on; layout(); };
  wrap.__uncollapse = function () { collapsible = false; layout(); };
  btn.addEventListener('click', function () {
    wrap.__setExpanded(!expanded);
    if (expanded) return;
    // Collapsing: drop a selection that's now clipped away, and keep the toggle
    // in view (it jumped up by the height of the hidden rows).
    if (selected && isClippedTile(selected)) {
      setSelected(null);
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    scrollTileIntoView(btn, 8);
  });
  if (subsResize) subsResize.disconnect();
  subsResize = new ResizeObserver(layout);
  subsResize.observe(wrap);
  layout();
}

function uncollapseSubalbums() {
  var wrap = document.querySelector('#subalbums .albums');
  if (wrap && wrap.__uncollapse) wrap.__uncollapse();
}

// Is `el` a sub-album tile hidden below a collapsed grid's clip?
function isClippedTile(el) {
  var wrap = el && el.parentNode;
  if (!wrap || !wrap.classList || !wrap.classList.contains('collapsed')) return false;
  return el.offsetTop - wrap.firstElementChild.offsetTop >= wrap.clientHeight;
}

