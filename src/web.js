// The /photos page is a client-side SPA. The server ships a static shell (an
// empty navbar + #subalbums/#photos containers + the lightbox); this script reads
// the album + filters from the URL into `state`, fetches /api/subalbums and
// /api/photos, and renders the navbar, sub-album tiles, and photo grid. Navigating
// to another album or changing the rating filter re-renders in place (no page
// load) and updates the URL via history.pushState, so bookmarking / Back / Forward
// all work. A single persistent runtime — the thumbnail worker pool, the lightbox
// listeners, and the nav/popstate handlers — is created once and reused across
// every in-page navigation; only the DOM is rebuilt.

// ===== State + URL ===========================================================
// The filter fields at their defaults (everything off / all media). The single
// source of truth for the initial `state`, the "clear all" reset (the ↺ button,
// see renderMenuFilters), and filtersActive()'s "is anything non-default?" check.
var DEFAULT_FILTERS = { minRating: 0, includeImages: true, includeVideo: true, recursive: false, aspect: 'all', tags: [] };
// The current view, initialized from the URL by readUrl() and updated on each
// navigation. `album` is the decoded display segments (e.g. ["Photos","Lego"];
// [] is the virtual root); `minRating` is 0 (no filter) or 1..=5; the media-type
// filter is two booleans, both true by default (include images / include video);
// `recursive` extends the grid to all sub-albums' items; `aspect` is the
// aspect-ratio filter ('all' | 'portrait' | 'landscape').
var state = Object.assign({ album: [] }, DEFAULT_FILTERS);
// Bumped on every render(); a fetch that resolves after a newer navigation
// compares against it and bails before touching the DOM (see render/buildGrid).
var renderToken = 0;

// The one place that reads `location`. Mirrors query::album_segments (split on
// '/', drop empties), clamps min_rating to 0..=5, and reads the media-type filter
// (a param present and equal to 'false' excludes that type).
function readUrl() {
  var path = location.pathname.replace(/^\/photos/, '');
  state.album = path.split('/').filter(Boolean).map(decodeURIComponent);
  var q = new URLSearchParams(location.search);
  var r = parseInt(q.get('min_rating'), 10);
  state.minRating = (r >= 1 && r <= 5) ? r : 0;
  state.includeImages = q.get('images') !== 'false';
  state.includeVideo = q.get('video') !== 'false';
  state.recursive = q.get('recursive') === 'true';
  var a = q.get('aspect');
  state.aspect = (a === 'portrait' || a === 'landscape') ? a : 'all';
  state.tags = (q.get('tags') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

// The current filters as a plain object, optionally with some keys overridden —
// so a link can target "the current view but with X changed".
function filters(over) {
  var f = {
    minRating: state.minRating,
    includeImages: state.includeImages,
    includeVideo: state.includeVideo,
    recursive: state.recursive,
    aspect: state.aspect,
    tags: state.tags
  };
  if (over) for (var k in over) f[k] = over[k];
  return f;
}

// Encode a filter object onto a URLSearchParams, each at its non-default value.
// The single source of truth for filter -> query, shared by the nav links
// (photosUrl) and the API fetches (apiParams) so the two can't drift.
function setFilterParams(qs, f) {
  if (f.minRating) qs.set('min_rating', f.minRating);
  if (!f.includeImages) qs.set('images', 'false');
  if (!f.includeVideo) qs.set('video', 'false');
  if (f.recursive) qs.set('recursive', 'true');
  if (f.aspect && f.aspect !== 'all') qs.set('aspect', f.aspect);
  if (f.tags && f.tags.length) qs.set('tags', f.tags.join(','));
}

// Build a frontend URL from album segments + a filter object, percent-encoding
// each segment and encoding each filter at its non-default value. The single
// source of truth for every nav link.
function photosUrl(segments, f) {
  var p = segments.map(encodeURIComponent);
  var qs = new URLSearchParams();
  setFilterParams(qs, f);
  var q = qs.toString();
  return '/photos' + (p.length ? '/' + p.join('/') : '') + (q ? '?' + q : '');
}

// The frontend URL for a sub-album's display path (e.g. "/Photos/Lego"), carrying
// the current filters.
function albumHref(displayPath) {
  return photosUrl(displayPath.split('/').filter(Boolean), filters());
}

// The target href for rating star K: set the threshold to K, or clear it when K
// is already the active threshold (toggle off). Keeps the media filter.
function ratingHref(k) {
  return photosUrl(state.album, filters({ minRating: state.minRating === k ? 0 : k }));
}

// Build a segmented control (horizontal radio) into `host`: each option is
// either the active, inert <span class="on"> or an <a> link to its target.
// Shared by the media / aspect / recursive filters. opts: [{label, title?,
// active, href}].
function segmented(host, opts) {
  var frag = document.createDocumentFragment();
  opts.forEach(function (o) {
    var el;
    if (o.active) {
      el = document.createElement('span');
      el.className = 'on';
    } else {
      el = document.createElement('a');
      el.href = o.href;
    }
    el.textContent = o.label;
    if (o.title) el.title = o.title;
    frag.appendChild(el);
  });
  host.replaceChildren(frag);
}

// The media-type filter as a 3-state horizontal radio (segmented control):
// "📷 🎥" (all media), "📷" (images only), "🎥" (videos only). The option matching
// the current {includeImages, includeVideo} pair is the active one (an inert
// <span>); the other two are links that switch to that pair. (The underlying
// filter stays two booleans — this only changes how they're presented.)
var MEDIA_OPTIONS = [
  { label: '📷 🎥', images: true, video: true, title: 'All media' },
  { label: '📷', images: true, video: false, title: 'Images only' },
  { label: '🎥', images: false, video: true, title: 'Videos only' }
];
function renderMedia(host) {
  segmented(host, MEDIA_OPTIONS.map(function (o) {
    return {
      label: o.label,
      title: o.title,
      active: state.includeImages === o.images && state.includeVideo === o.video,
      href: photosUrl(state.album, filters({ includeImages: o.images, includeVideo: o.video }))
    };
  }));
}

// The aspect-ratio filter as a 3-state radio (segmented control), same style as
// the media one: "▯ ▭" (all), "▯" (portrait), "▭" (landscape). The option whose
// value matches state.aspect is the active inert <span>; the others are links.
var ASPECT_OPTIONS = [
  { label: '▯ ▭', value: 'all', title: 'All aspect ratios' },
  { label: '▯', value: 'portrait', title: 'Portrait (height ≥ width)' },
  { label: '▭', value: 'landscape', title: 'Landscape (width ≥ height)' }
];
function renderAspect(host) {
  segmented(host, ASPECT_OPTIONS.map(function (o) {
    return {
      label: o.label,
      title: o.title,
      active: state.aspect === o.value,
      href: photosUrl(state.album, filters({ aspect: o.value }))
    };
  }));
}

function filtersActive() {
  return state.minRating || !state.includeImages || !state.includeVideo || state.recursive
    || state.aspect !== 'all' || state.tags.length;
}

// The shared query for both API fetches: the album display path (empty for the
// root) plus the active filters.
function apiParams() {
  var p = new URLSearchParams();
  p.set('album', state.album.length ? '/' + state.album.join('/') : '');
  // `state` carries the same field names as a filter object. `recursive` is
  // sent to /api/photos (extends the grid to all sub-albums); /api/subalbums
  // ignores it (its counts are already recursive).
  setFilterParams(p, state);
  return p;
}

// ===== Navbar (breadcrumb) ===================================================
// Synchronous + idempotent: rebuild the navbar shell's .crumb from `state`. Runs
// during initial parse (before first paint, so no flash) and on every navigation.
// The filter controls live in the hamburger menu now (see renderMenuFilters).
function renderNavbar() {
  var crumb = document.createDocumentFragment();
  var home = document.createElement('a');
  home.className = 'home';
  home.href = photosUrl([], filters());
  home.setAttribute('aria-label', 'Home');
  home.textContent = '⌂';
  crumb.appendChild(home);
  state.album.forEach(function (seg, i) {
    var sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    crumb.appendChild(sep);
    var a = document.createElement('a');
    // The cumulative path up to and including segment i.
    a.href = photosUrl(state.album.slice(0, i + 1), filters());
    a.textContent = seg;
    crumb.appendChild(a);
  });
  document.querySelector('.crumb').replaceChildren(crumb);

  document.title = state.album.length ? '/' + state.album.join('/') : 'Photos';
}

// Build one "label: control" row for the Filters panel.
function filterRow(label, control) {
  var row = document.createElement('div');
  row.className = 'filter-row';
  var l = document.createElement('span');
  l.className = 'filter-label';
  l.textContent = label;
  row.append(l, control);
  return row;
}

// Rebuild the Filters menu (the funnel dropdown) from `state`. Called from
// render() (so the active states track navigation), and also highlights the
// funnel button whenever any filter is active. The controls are the same
// state-reflecting /photos links as before — initNav navigates on click, and the
// menu deliberately stays open so several filters can be tweaked in a row.
function renderMenuFilters() {
  var active = filtersActive();
  // Highlight the funnel icon when filtering is in effect (visual feedback).
  var fbtn = document.querySelector('.filter-btn');
  if (fbtn) fbtn.classList.toggle('active', !!active);

  var host = document.querySelector('.menu-filters');
  if (!host) return;
  var frag = document.createDocumentFragment();

  // "Filters" section header with a ↺ clear-all action on the right.
  var title = document.createElement('div');
  title.className = 'menu-title';
  var titleText = document.createElement('span');
  titleText.textContent = 'Filters';
  var reset = document.createElement('a');
  reset.className = active ? 'reset' : 'reset disabled';
  reset.href = photosUrl(state.album, DEFAULT_FILTERS);
  reset.title = 'Clear all filters';
  reset.textContent = '↺';
  title.append(titleText, reset);
  frag.appendChild(title);

  // Recursive: a 2-option [On|Off] segmented control.
  var rec = document.createElement('span');
  rec.className = 'seg recursive-toggle';
  segmented(rec, [['On', true], ['Off', false]].map(function (o) {
    return {
      label: o[0],
      active: state.recursive === o[1],
      href: photosUrl(state.album, filters({ recursive: o[1] }))
    };
  }));
  frag.appendChild(filterRow('Recursive', rec));

  // Stars: the 5-star rating selector.
  var rating = document.createElement('span');
  rating.className = 'rating';
  for (var k = 1; k <= 5; k++) {
    var on = k <= state.minRating;
    var star = document.createElement('a');
    if (on) star.className = 'on';
    star.href = ratingHref(k);
    star.title = '≥' + k + ' stars';
    star.textContent = on ? '★' : '☆';
    rating.appendChild(star);
  }
  frag.appendChild(filterRow('Stars', rating));

  // Media-type: a 3-state radio (all media / images only / videos only).
  var media = document.createElement('span');
  media.className = 'media';
  renderMedia(media);
  frag.appendChild(filterRow('Media', media));

  // Aspect-ratio: a 3-state radio (all / portrait / landscape).
  var aspect = document.createElement('span');
  aspect.className = 'aspect';
  renderAspect(aspect);
  frag.appendChild(filterRow('Aspect ratio', aspect));

  // Tags: a free-text, comma-separated input. A bare token matches a tag (and its
  // subtree) by name; a "/path" token matches by absolute path. Commit on Enter or
  // blur — navigating only when the list actually changed.
  var tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.className = 'tags-input';
  tagsInput.value = state.tags.join(', ');
  tagsInput.placeholder = 'tag, /local/fashion';
  tagsInput.setAttribute('aria-label', 'Filter by tags');
  function commitTags() {
    var parsed = tagsInput.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (JSON.stringify(parsed) === JSON.stringify(state.tags)) return false; // unchanged
    navigateTo(photosUrl(state.album, filters({ tags: parsed })));
    return true;
  }
  tagsInput.addEventListener('keydown', function (e) {
    // stopPropagation: committing re-renders and detaches this input, so without it
    // the Enter would bubble to the grid-nav handler (activeElement no longer an
    // input by then) and open the selected tile in the lightbox.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (commitTags()) {
        // The re-render replaced this input — move focus to the fresh one (caret at end).
        var ni = document.querySelector('.tags-input');
        if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
      }
    }
  });
  tagsInput.addEventListener('blur', commitTags);
  frag.appendChild(filterRow('Tags', tagsInput));

  host.replaceChildren(frag);
}

// ===== Lightbox ==============================================================
// Wired up ONCE at startup; its listeners persist across navigations. The tile
// list (`tiles`/`items`) is recomputed by refresh() after each render, and the
// per-tile open is delegated, so nothing is re-bound per navigation. Exposed via
// the module-level `LB` so the nav controller can query/dismiss it.
var LB = null;
function initLightbox() {
  // Recomputed per render(); the persistent handlers close over these vars.
  var tiles = [];
  var items = [];
  var lb = document.getElementById('lightbox');
  var img = document.getElementById('lb-img');
  var vid = document.getElementById('lb-video');
  var prev = lb.querySelector('.prev');
  var next = lb.querySelector('.next');
  var idx = -1;
  var closing = false; // guards against issuing history.back() twice per open
  var suppressClick = false; // swallow the synthetic click a touch tap produces
  var infoEl = document.getElementById('lb-info');
  var infoOpen = false; // image-info panel visible (then controls don't auto-hide)
  var slideBtn = lb.querySelector('.slideshow-btn');
  var slideshowOn = false; // auto-advancing to a random item
  var slideTimer = 0;      // pending image advance (videos advance on 'ended')
  var bag = [];            // remaining indices of the current random permutation
                           // (popped from the end; reshuffled once exhausted)

  function isOpen() { return lb.classList.contains('open'); }
  function activeEl() { return vid.classList.contains('active') ? vid : img; }

  // A touch tap fires a synthetic click after the touchend handler already
  // acted on it; that handler sets `suppressClick` so these click handlers
  // swallow the stray click. Returns true (and clears the flag) when consumed.
  function tapConsumed() {
    if (!suppressClick) return false;
    suppressClick = false;
    return true;
  }

  // Recompute the item list from the (just-rebuilt) grid. Direct grid children
  // only: a video tile's inner poster <img> is not its own item.
  function refresh() {
    tiles = Array.prototype.slice.call(document.querySelectorAll('.grid > img, .grid > .vtile'));
    items = tiles.map(function (el) {
      var video = el.classList.contains('vtile');
      // Photos display a decoded thumbnail in the grid; the lightbox always shows
      // the full-size original from `data-full`. `photo` is the PhotoSummary for
      // the info panel.
      return {
        src: video ? el.dataset.src : (el.dataset.full || el.src),
        alt: el.getAttribute('alt') || '',
        video: video,
        photo: el._photo
      };
    });
    idx = -1;
    bag = []; // indices changed -> drop the stale permutation
  }

  // The close/nav controls start hidden (open() adds `.idle`); a mouse/pen move
  // or a tap reveals them, after which they auto-hide again after 2s of
  // inactivity. Keyboard navigation and swipes deliberately do NOT reveal them.
  var idleTimer = 0;
  function wake() {
    lb.classList.remove('idle');
    clearTimeout(idleTimer);
    // While the info panel is open the controls stay pinned (no auto-hide).
    if (isOpen() && !infoOpen) idleTimer = setTimeout(function () {
      if (isOpen() && !infoOpen) lb.classList.add('idle');
    }, 2000);
  }

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
  // panel is open, and cached per id for the session.
  var metaCache = {};
  function loadMeta(id) {
    if (metaCache[id] !== undefined) return Promise.resolve(metaCache[id]);
    return fetch('/api/photos/' + id)
      .then(function (r) { return r.json(); })
      .then(function (m) { metaCache[id] = m; return m; })
      .catch(function () { metaCache[id] = { tags: [] }; return metaCache[id]; });
  }

  // Fill the info panel from the current item's PhotoSummary (skipping any
  // missing field). Called when the panel is open, including while navigating.
  function renderInfo() {
    var p = items[idx] && items[idx].photo;
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
    // Format + MIME on one row, e.g. "jpg (image/jpeg)".
    var fmt = p.format ? p.format.toLowerCase() : null;
    var format = (fmt && p.mime) ? (fmt + ' (' + p.mime + ')') : (fmt || p.mime || null);
    var rows = [
      ['File', p.name],
      ['Album', album],
      ['Rating', p.rating != null ? '★'.repeat(p.rating) + '☆'.repeat(5 - p.rating) : null],
      ['Format', format],
      ['Size', fmtBytes(p.file_size)],
      ['Resolution', (p.width && p.height) ? (p.width + ' × ' + p.height) : null],
      ['Modified', fmtDate(p.modification_date)],
      ['Created', meta ? fmtDate(meta.creation_date) : null],
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
    if (meta === undefined) {
      loadMeta(p.id).then(function () {
        if (infoOpen && items[idx] && items[idx].photo && items[idx].photo.id === p.id) renderInfo();
      });
    }
  }

  function setInfo(on) {
    infoOpen = on;
    lb.classList.toggle('info-open', on);
    if (on) renderInfo();
    wake(); // re-arm or suspend the auto-hide, and reveal the controls
  }
  function toggleInfo() { setInfo(!infoOpen); }

  // Slideshow: auto-advance to a random item. Images advance after 5s; a video
  // plays in full and advances when it ends (the 'ended' listener below) — so its
  // loop is turned off while a slideshow runs.
  function clearSlide() { clearTimeout(slideTimer); slideTimer = 0; }
  function scheduleSlide() {
    clearSlide();
    if (!slideshowOn) return;
    var it = items[idx];
    if (it && !it.video) slideTimer = setTimeout(goRandom, 5000);
  }
  function setSlideshow(on) {
    slideshowOn = on;
    lb.classList.toggle('slideshow', on);
    slideBtn.textContent = on ? '⏸' : '▶';
    slideBtn.title = (on ? 'Stop slideshow' : 'Slideshow') + ' (s)';
    if (activeEl() === vid) vid.loop = !on;
    scheduleSlide();
  }
  function toggleSlideshow() { setSlideshow(!slideshowOn); }
  vid.addEventListener('ended', function () { if (slideshowOn) goRandom(); });

  // Jump from the info panel's album link to that album. The lightbox pushed a
  // URL-less history entry on open; repurpose it (replaceState) as the target so
  // Back still returns to where we were, then close the lightbox and re-render.
  function jumpToAlbum(url) {
    if (!url) return;
    history.replaceState({}, '', url);
    dismiss();
    readUrl();
    window.scrollTo(0, 0);
    render();
  }

  // Panel clicks must not bubble to the letterbox-close handler; the album link
  // navigates in-page instead of doing a full document load. (`suppressClick`
  // swallows the synthetic click from a touch tap, which the touch handler below
  // already acted on.)
  infoEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (tapConsumed()) return;
    // Internal panel links (album / tag) navigate in-page via jumpToAlbum; an
    // external link (the maps link, target=_blank) falls through to open normally.
    var a = e.target.closest('a');
    if (a && a.target !== '_blank') { e.preventDefault(); jumpToAlbum(a.getAttribute('href')); }
  });
  // Mouse/pen movement reveals the controls; touch is handled by the gestures
  // below (a tap reveals; a swipe doesn't).
  lb.addEventListener('pointermove', function (e) { if (e.pointerType !== 'touch') wake(); });

  // Decode image neighbours ahead of time so tapping prev/next paints instantly
  // (originals are full-size, so the decode is the slow part — worst on Firefox).
  // Videos are skipped: we don't want to prefetch multi-MB media.
  function preload(i) {
    if (i >= 0 && i < items.length && !items[i].video) {
      var im = new Image();
      im.src = items[i].src;
    }
  }

  function show(i, play) {
    if (i < 0 || i >= items.length) return;
    idx = i;
    var it = items[i];
    resetZoom(); // start each item un-zoomed
    vid.pause(); // stop any previously-playing video before switching
    if (it.video) {
      vid.src = it.src;
      vid.loop = !slideshowOn; // in a slideshow, play once then advance on 'ended'
      vid.classList.add('active');
      img.classList.remove('active');
      img.removeAttribute('src');
      if (play) {
        var p = vid.play();
        if (p && p.catch) p.catch(function () {
          // Couldn't play (e.g. an unsupported codec) — don't stall the slideshow.
          if (slideshowOn) { clearSlide(); slideTimer = setTimeout(goRandom, 1500); }
        });
      }
    } else {
      img.src = it.src;
      img.alt = it.alt;
      img.classList.add('active');
      vid.classList.remove('active');
      vid.removeAttribute('src');
      vid.load();
    }
    prev.disabled = (i === 0);
    next.disabled = (i === items.length - 1);
    lb.classList.add('open');
    document.body.classList.add('modal-open');
    if (infoOpen) renderInfo(); // keep the panel in sync while navigating
    setSelected(tiles[i]);      // track the grid selection (revealed on dismiss)
    scheduleSlide();            // (re)arm the slideshow advance for this item
    preload(i + 1);
    preload(i - 1);
  }

  // Open via a pushed history entry so the device Back button (and gesture)
  // pops it and dismisses, instead of navigating off the album page. The entry
  // carries no URL, so the album URL is preserved while the lightbox is open (the
  // nav controller's popstate relies on this). Opening a video plays it (the tap
  // is the user gesture, so audio is allowed), and we enter fullscreen.
  function open(i) {
    if (!isOpen()) history.pushState({ lightbox: true }, '');
    bag = []; // each lightbox session gets a fresh random permutation
    show(i, true);
    // Controls start hidden — unless the info panel is open, which pins them.
    if (!infoOpen) lb.classList.add('idle');
    // Must be requested inside the click gesture. Unsupported on iPhone Safari
    // (guarded), where the full-viewport overlay alone is used.
    if (!document.fullscreenElement && lb.requestFullscreen) {
      lb.requestFullscreen().catch(function () {});
    }
  }

  // UI dismiss (X / Esc / tapping outside): step back in history so the Back
  // button and these all funnel through popstate -> dismiss(), keeping the
  // history stack consistent. The `closing` guard keeps repeated calls (e.g. Esc
  // firing both keydown and fullscreenchange) from popping history twice.
  function close() {
    if (isOpen() && !closing) {
      closing = true;
      history.back();
    }
  }

  function dismiss() {
    closing = false;
    clearTimeout(idleTimer);
    // Stop any running slideshow and restore the default video looping.
    clearSlide();
    slideshowOn = false;
    lb.classList.remove('slideshow');
    slideBtn.textContent = '▶';
    vid.loop = true;
    lb.classList.remove('idle');
    lb.classList.remove('open');
    document.body.classList.remove('modal-open');
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    img.removeAttribute('src');
    img.classList.remove('active');
    vid.classList.remove('active');
    // Reveal the last-viewed tile in the grid (it may have scrolled out of view
    // while browsing); `nearest` is a no-op when it's already visible. Defer past
    // a fullscreen exit so the scroll applies to the restored page layout.
    var tile = idx >= 0 ? tiles[idx] : null;
    idx = -1;
    // Carry the last-viewed item to the grid selection + URL fragment (we've
    // popped back to the album entry, so this writes the album's fragment).
    if (tile) { setSelected(tile); syncSelectionHash(); }
    function reveal() {
      // Reserve room for the sticky navbar plus a gap top and bottom, so the
      // tile lands fully visible — not tucked under the navbar or flush against
      // the bottom edge.
      if (tile) scrollTileIntoView(tile, 96, 96);
    }
    if (document.fullscreenElement) {
      // X / letterbox / Back: we trigger the exit, then scroll once it's done.
      document.exitFullscreen().then(reveal, reveal);
    } else {
      // Escape: the browser already exited fullscreen before we got here; wait
      // for the exit reflow to settle so our scroll isn't immediately clobbered.
      requestAnimationFrame(function () { requestAnimationFrame(reveal); });
    }
  }

  // Exiting fullscreen (Esc, or the browser's own control) closes the lightbox.
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && isOpen()) close();
  });

  // Navigation (arrows / chevrons / swipe) auto-plays a video it lands on
  // (the click/key/swipe is a user gesture, so playback with audio is allowed).
  function go(d) {
    var n = idx + d;
    if (n >= 0 && n < items.length) show(n, true);
  }

  // Advance to the next item of a random permutation of all items (the `r` key, a
  // swipe-up, and the slideshow). A shuffled bag of indices is popped one at a
  // time and only reshuffled once exhausted, so every item is shown once before
  // any repeats — no more re-seeing items mid-shuffle. Guards against re-showing
  // the current item (e.g. when manual nav landed on a still-queued index).
  function goRandom() {
    if (items.length <= 1) return;
    if (!bag.length) {
      bag = items.map(function (_, n) { return n; });
      for (var k = bag.length - 1; k > 0; k--) { // Fisher-Yates
        var j = Math.floor(Math.random() * (k + 1));
        var t = bag[k]; bag[k] = bag[j]; bag[j] = t;
      }
    }
    var n = bag.pop();
    if (n === idx && bag.length) { bag.unshift(n); n = bag.pop(); }
    show(n, true);
  }

  // Open the lightbox on a clicked grid tile. Delegated (not per-tile) so it keeps
  // working against the `tiles` rebuilt on each render with no re-binding. Grid
  // tiles are <img>/<button>, never <a>, so the nav controller's link handler
  // ignores them.
  document.addEventListener('click', function (e) {
    var t = e.target.closest('.grid > img.thumb, .grid > .vtile');
    if (!t) return;
    var i = tiles.indexOf(t);
    if (i >= 0) open(i);
  });

  // Middle-click a grid tile -> open the original file in a new tab (tiles aren't
  // <a>, so the browser won't do this on its own). Middle-click fires `auxclick`,
  // not `click`, so it doesn't also open the lightbox.
  document.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return; // middle button only (leave right-click alone)
    var t = e.target.closest('.grid > img.thumb, .grid > .vtile');
    if (!t || !t._photo) return;
    e.preventDefault();
    window.open('/api/photos/' + t._photo.id + '/file', '_blank', 'noopener');
  });
  // Suppress the middle-button autoscroll so the above opens a clean new tab.
  document.addEventListener('mousedown', function (e) {
    if (e.button === 1 && e.target.closest('.grid > img.thumb, .grid > .vtile')) e.preventDefault();
  });

  // Is (cx, cy) over the displayed media (vs the letterbox)? The media fills the
  // viewport letterboxed via object-fit: contain.
  function onMedia(cx, cy) {
    var el = activeEl();
    var r = el.getBoundingClientRect();
    var nw = el.naturalWidth || el.videoWidth, nh = el.naturalHeight || el.videoHeight;
    if (!nw || !nh) return true; // not loaded yet: treat as on-media
    var s = Math.min(r.width / nw, r.height / nh);
    var w = nw * s, h = nh * s;
    var x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
    return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
  }
  function togglePlay() {
    if (vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
    else vid.pause();
  }
  // Mouse click: reveal the controls, and on the letterbox dismiss (unless the
  // click only revealed the hidden controls). Video play/pause on desktop is the
  // native controls' job. Touch taps are handled in the touch gestures below;
  // their synthetic click is swallowed here so this doesn't re-fire.
  lb.addEventListener('click', function (e) {
    if (tapConsumed()) return;
    var hidden = lb.classList.contains('idle');
    wake();
    if (!onMedia(e.clientX, e.clientY) && !hidden) close();
  });
  lb.querySelector('.close').addEventListener('click', function (e) { e.stopPropagation(); close(); });
  lb.querySelector('.info').addEventListener('click', function (e) {
    e.stopPropagation();
    if (tapConsumed()) return;
    toggleInfo();
  });
  slideBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (tapConsumed()) return;
    toggleSlideshow();
  });
  prev.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
  next.addEventListener('click', function (e) { e.stopPropagation(); go(1); });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') { close(); return; }
    // Arrows/Home/End navigate between items as usual. preventDefault keeps a
    // focused <video> (it has controls) from also consuming them to seek.
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'Home') { e.preventDefault(); show(0, true); }
    else if (e.key === 'End') { e.preventDefault(); show(items.length - 1, true); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); goRandom(); }
    else if (e.key === ' ' && activeEl() === vid) {
      // Toggle the video (it isn't focused, so the native space-to-play won't fire).
      e.preventDefault();
      togglePlay();
    }
    else if ((e.key === 'm' || e.key === 'M') && activeEl() === vid) {
      e.preventDefault();
      vid.muted = !vid.muted;
    }
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); toggleInfo(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleSlideshow(); }
  });

  // ----- Touch gestures -----
  // Over the whole lightbox: one-finger swipe up -> random, left/right -> prev/next,
  // tap -> reveal controls / pause a video / close on the letterbox. Two-finger
  // pinch zooms the image (1×–4×); while zoomed, one finger pans and double-tap
  // toggles zoom. A swipe/pinch fires no click, so taps and gestures don't collide;
  // on touch these take over from the native video seek bar (mouse-usable on desktop).
  var scale = 1, tx = 0, ty = 0, ZMAX = 4;
  var sx = 0, sy = 0;     // one-finger gesture start (swipe / pan)
  var gesture = null;     // active touch sequence: {mode:'swipe'|'pan'|'pinch', …}
  var multiTouch = false; // a 2nd finger joined this sequence (suppresses swipe)
  var lastTapTime = 0;    // for double-tap detection

  // Pinch-zoom applies only to images (videos keep their native controls).
  function zoomable() { return activeEl() === img; }
  function applyZoom() {
    img.style.transform = scale === 1 ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    // Hide all controls (incl. the ‹ › chevrons) while zoomed — see web.css.
    lb.classList.toggle('zoomed', scale > 1);
  }
  function resetZoom() { scale = 1; tx = 0; ty = 0; applyZoom(); }
  function clampPan() {
    // Keep the scaled image box covering the viewport (don't drift into the void).
    var W = lb.clientWidth, H = lb.clientHeight;
    tx = Math.max(W * (1 - scale), Math.min(0, tx));
    ty = Math.max(H * (1 - scale), Math.min(0, ty));
  }
  // Zoom to `s` (clamped 1..ZMAX) keeping the point (fx, fy) fixed on screen.
  function zoomTo(s, fx, fy) {
    s = Math.max(1, Math.min(ZMAX, s));
    var k = s / scale;
    tx = fx - (fx - tx) * k;
    ty = fy - (fy - ty) * k;
    scale = s;
    clampPan();
    applyZoom();
  }
  function touchDist(ts) { return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY); }
  function touchMid(ts) { return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 }; }

  lb.addEventListener('touchstart', function (e) {
    suppressClick = false;
    if (e.touches.length === 2 && zoomable()) {
      multiTouch = true;
      gesture = { mode: 'pinch', d0: touchDist(e.touches), s0: scale, tx0: tx, ty0: ty, m0: touchMid(e.touches) };
    } else if (e.touches.length === 1) {
      multiTouch = false;
      var t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      gesture = (scale > 1 && zoomable())
        ? { mode: 'pan', x0: t.clientX, y0: t.clientY, tx0: tx, ty0: ty }
        : { mode: 'swipe' };
    }
  }, { passive: true });

  // Live pinch / pan. Non-passive so it can preventDefault; touch-action:none on
  // the lightbox already stops the browser's own pan/zoom.
  lb.addEventListener('touchmove', function (e) {
    if (!gesture) return;
    if (gesture.mode === 'pinch' && e.touches.length >= 2) {
      e.preventDefault();
      var d = touchDist(e.touches), m = touchMid(e.touches);
      var s = Math.max(1, Math.min(ZMAX, gesture.s0 * d / gesture.d0));
      // Pin the content point under the start midpoint to the current midpoint,
      // so two fingers also pan while pinching.
      var cx = (gesture.m0.x - gesture.tx0) / gesture.s0;
      var cy = (gesture.m0.y - gesture.ty0) / gesture.s0;
      scale = s; tx = m.x - cx * s; ty = m.y - cy * s;
      clampPan(); applyZoom();
    } else if (gesture.mode === 'pan' && e.touches.length === 1) {
      e.preventDefault();
      var t = e.touches[0];
      tx = gesture.tx0 + (t.clientX - gesture.x0);
      ty = gesture.ty0 + (t.clientY - gesture.y0);
      clampPan(); applyZoom();
    }
  }, { passive: false });

  lb.addEventListener('touchend', function (e) {
    // A finger lifted but others remain: if a pinch dropped to one finger and
    // we're still zoomed, continue as a pan from that finger.
    if (e.touches.length > 0) {
      if (gesture && gesture.mode === 'pinch' && e.touches.length === 1 && scale > 1) {
        var pt = e.touches[0];
        gesture = { mode: 'pan', x0: pt.clientX, y0: pt.clientY, tx0: tx, ty0: ty };
      }
      return;
    }
    // All fingers up: end the sequence.
    var wasMulti = multiTouch, mode = gesture ? gesture.mode : 'swipe';
    gesture = null; multiTouch = false;
    if (scale <= 1.001) resetZoom();

    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    var adx = Math.abs(dx), ady = Math.abs(dy);
    var moved = adx > 10 || ady > 10;

    // Double-tap an image (directly on it — not an overlaid control like the
    // ‹ › chevrons) toggles zoom: to 2× at the tap point, or back to fit.
    // Detected before the zoom guard below so it works while zoomed.
    if (!moved && !wasMulti && zoomable() && e.target === img && onMedia(t.clientX, t.clientY)) {
      if (e.timeStamp - lastTapTime < 300) {
        lastTapTime = 0;
        if (scale > 1) resetZoom(); else zoomTo(2, t.clientX, t.clientY);
        suppressClick = true;
        return;
      }
      lastTapTime = e.timeStamp;
    }

    // A pinch/pan gesture, or still zoomed (one finger pans, doesn't navigate):
    // don't swipe-navigate, close, or reveal controls (they stay hidden while zoomed).
    if (wasMulti || mode === 'pan' || scale > 1) { suppressClick = true; return; }

    if (ady > 50 && ady > adx) {
      // Swipe up -> random, unless it starts in the bottom ~100px, where it
      // collides with the Android "swipe up from the bottom" system gesture.
      if (dy < 0 && sy < window.innerHeight - 100) goRandom();
      return;
    }
    if (adx > 50 && adx > ady) { go(dx < 0 ? 1 : -1); return; }     // swipe left/right
    // A tap on the info button toggles the panel; a tap on its album link jumps to
    // that album; a tap on the panel itself just keeps it (none count as an
    // off-media letterbox close). The synthetic click is swallowed below.
    if (e.target.closest('.slideshow-btn')) { toggleSlideshow(); suppressClick = true; return; }
    if (e.target.closest('.info')) { toggleInfo(); suppressClick = true; return; }
    if (e.target.closest('#lb-info')) {
      var link = e.target.closest('a');
      if (link && link.target === '_blank') return; // let the tap open the external link
      if (link) jumpToAlbum(link.getAttribute('href')); else wake();
      suppressClick = true; return;
    }
    // Tap: reveal the controls, then pause a video / close on the letterbox.
    // Handled here (not via click) because the native video controls swallow the
    // click on a video; swallow the synthetic click so the mouse handler doesn't
    // re-fire (which would close on a reveal-tap).
    var hidden = lb.classList.contains('idle');
    wake();
    if (onMedia(t.clientX, t.clientY)) {
      if (activeEl() === vid) togglePlay();
    } else if (!hidden) {
      close();
    }
    suppressClick = true;
  }, { passive: true });

  // Mouse wheel: scroll down -> next, scroll up -> previous. Throttled so one
  // notch (or a trackpad flick of several events) advances a single item.
  var lastWheel = 0;
  lb.addEventListener('wheel', function (e) {
    if (!e.deltaY) return; // ignore purely-horizontal scroll
    e.preventDefault();
    if (e.timeStamp - lastWheel < 50) return;
    lastWheel = e.timeStamp;
    go(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  LB = { isOpen: isOpen, dismiss: dismiss, refresh: refresh };
}

// ===== Thumbnail decoder (persistent worker pool) ============================
// Each `img.thumb` tile fetches /api/photos/:id/thumbnail (a raw PGF blob) when it
// nears the viewport, decodes it off the main thread in a webpgf (wasm) Web Worker,
// and paints the result — rotated per the X-Orientation header — into the <img>.
// Missing thumbnails (404) or any failure fall back to the full-size /file
// original. The decoder (worker pool) is created ONCE and reused across every
// navigation; only the per-render loader (observer + fetch limiter, below) is
// rebuilt for each new set of tiles.
var DEC = null;          // the persistent decoder, once ensureDecoder() runs
var DEC_UNAVAIL = false; // no Worker/IntersectionObserver: load originals directly

function ensureDecoder() {
  if (DEC || DEC_UNAVAIL) return;
  if (!('IntersectionObserver' in window) || typeof Worker === 'undefined') {
    DEC_UNAVAIL = true;
    return;
  }
  DEC = createDecoder();
}

// Build the Blob-worker pool. To make the FIRST paint snappy, the decoder assets
// are fetched once here (not once per worker) and the pool is pre-warmed: webpgf.js
// is inlined into the worker body (so workers don't each re-fetch it), and the wasm
// module is instantiated right away via an init message — overlapping with the
// thumbnail fetches — so blobs decode the instant they arrive instead of waiting on
// a cold module. Fetch (network) and decode (CPU) stay separate stages so the wide
// prefetch window keeps up. Returns { enqueue, fallback }.
function createDecoder() {
  var base = location.origin;
  var POOL = Math.min(navigator.hardwareConcurrency || 4, 6);
  var idleWorkers = [];
  var live = 0;        // workers still alive
  var queue = [];      // {img, buf, o}: fetched blobs waiting for a free worker
  var pending = {};    // token -> {img, o}: currently decoding
  var seq = 0;         // monotonic per-job token (NOT the photo id; see drain)
  var ditched = false; // pool unavailable -> tiles fall back to /file

  // Worker body, appended after webpgf.js (which defines `WebPGF`): the init
  // message (`wasm`) instantiates the module from the shared bytes; each later
  // message decodes a blob and transfers the pixel buffer back.
  var glue = `
    var mod;
    onmessage = function (e) {
      var d = e.data;
      if (d.wasm) { mod = WebPGF({ wasmBinary: d.wasm }); return; }
      mod.then(function (m) {
        var im = m.decode(new Uint8Array(d.buf));
        var o = im.data;
        postMessage({ id: d.id, w: im.width, h: im.height, buf: o.buffer }, [o.buffer]);
      }).catch(function (err) {
        postMessage({ id: d.id, error: String((err && err.message) || err) });
      });
    };
  `;

  // High priority: these gate the whole decode pipeline, so they shouldn't wait
  // behind the thumbnail fetches.
  Promise.all([
    fetch(base + '/webpgf.js', { priority: 'high' }).then(function (r) { return r.text(); }),
    fetch(base + '/webpgf.wasm', { priority: 'high' }).then(function (r) { return r.arrayBuffer(); })
  ]).then(function (parts) {
    var url = URL.createObjectURL(new Blob([parts[0] + '\n;' + glue], { type: 'application/javascript' }));
    for (var i = 0; i < POOL; i++) {
      var w = buildWorker(url);
      w.postMessage({ wasm: parts[1] }); // pre-warm now; bytes are copied per worker
      idleWorkers.push(w);
    }
    drain();
  }).catch(ditch);

  // Pool gone (assets failed to load, or every worker died): everything queued,
  // decoding, or arriving later falls back to its original.
  function ditch() {
    ditched = true;
    queue.forEach(function (j) { fallback(j.img); }); queue = [];
    for (var id in pending) fallback(pending[id].img);
    pending = {};
  }

  function buildWorker(url) {
    var w = new Worker(url);
    w.onmessage = function (e) {
      var d = e.data, job = pending[d.id];
      if (job) {
        delete pending[d.id];
        if (d.error) fallback(job.img);
        else paint(job.img, d.w, d.h, d.buf, job.o);
      }
      w.job = null;
      idleWorkers.push(w);
      drain();
    };
    // A worker that dies (e.g. webpgf failed to instantiate) falls back its
    // in-flight tile; once the whole pool is gone, ditch the rest.
    w.onerror = function () {
      live--;
      idleWorkers = idleWorkers.filter(function (x) { return x !== w; }); // never dispatch to it
      if (w.job && pending[w.job]) { fallback(pending[w.job].img); delete pending[w.job]; }
      if (live <= 0) ditch();
    };
    live++;
    return w;
  }

  function drain() {
    while (idleWorkers.length && queue.length) {
      var w = idleWorkers.pop();
      var job = queue.shift();
      // A fresh token per job, not job.img.dataset.id: two tiles can share a
      // photo id (a sub-album cover that also appears in the recursive grid),
      // and keying `pending` by id would let the second clobber the first —
      // leaving one tile permanently unpainted (a mysterious black tile).
      var id = ++seq;
      pending[id] = { img: job.img, o: job.o };
      w.job = id;
      w.postMessage({ id: id, buf: job.buf }, [job.buf]);
    }
  }

  function fallback(img) {
    // The tile may have been detached by a navigation before its decode/fetch
    // resolved — nothing to paint into.
    if (!img.isConnected) return;
    // Video posters carry no `data-full`: a missing/failed thumbnail just leaves
    // the empty tile showing the ▶ placeholder, rather than loading the video.
    var full = img.dataset.full;
    if (!full) return;
    img.addEventListener('load', function () { img.style.width = ''; }, { once: true });
    img.src = full;
  }

  function paint(img, w, h, buf, o) {
    if (!img.isConnected) return; // tile replaced by a navigation; drop the result
    var canvas = oriented(new ImageData(new Uint8ClampedArray(buf), w, h), o);
    canvas.toBlob(function (blob) {
      if (!blob) { fallback(img); return; }
      var url = URL.createObjectURL(blob);
      img.addEventListener('load', function () {
        URL.revokeObjectURL(url);
        img.style.width = ''; // drop the reservation; use the natural aspect
      }, { once: true });
      img.src = url;
    });
  }

  // Draw the decoded ImageData through the matching EXIF-orientation transform.
  // Values outside 2..8 (0 = unset, 1 = normal, or junk) are left unrotated;
  // 5..8 also swap the canvas dimensions.
  function oriented(im, o) {
    var w = im.width, h = im.height;
    var src = document.createElement('canvas');
    src.width = w; src.height = h;
    src.getContext('2d').putImageData(im, 0, 0);
    if (!(o >= 2 && o <= 8)) return src;
    var swap = o >= 5;
    var out = document.createElement('canvas');
    out.width = swap ? h : w; out.height = swap ? w : h;
    var ctx = out.getContext('2d');
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    }
    ctx.drawImage(src, 0, 0);
    return out;
  }

  return {
    // Queue a fetched PGF blob for decoding (or fall back if the pool is dead).
    enqueue: function (img, buf, o) {
      if (ditched) { fallback(img); return; }
      queue.push({ img: img, buf: buf, o: o });
      drain();
    },
    fallback: fallback
  };
}

// ===== Thumbnail loader (per render) =========================================
// Observe a set of `img.thumb` tiles and fetch each one's thumbnail as it nears
// the viewport, handing the blob to the persistent decoder. Rebuilt for each new
// grid; the previous loader is disposed (observer disconnected, pending fetches
// for the now-detached old tiles dropped) so we never fetch for a stale grid.
var currentLoader = null;

function collectThumbs() {
  return document.querySelectorAll('img.thumb'); // sub-album covers + grid posters
}

function observeTiles(thumbs) {
  if (currentLoader) { currentLoader.dispose(); currentLoader = null; }
  if (!thumbs.length) return;
  if (DEC_UNAVAIL) {
    thumbs.forEach(function (img) { if (img.dataset.full) img.src = img.dataset.full; });
    return;
  }
  currentLoader = createLoader(thumbs, DEC);
}

function createLoader(thumbs, dec) {
  // Cap concurrent thumbnail fetches. Firing a whole screenful of fetches at once
  // makes Firefox's request pacer hold the burst (~hundreds of ms before any is
  // even dispatched); a small cap matching the ~6-connection limit keeps the pacer
  // out of the way, and — since the observer queues tiles top-to-bottom — fetches
  // the visible rows first.
  var MAXFETCH = 6;
  var inflight = 0;
  var waiting = []; // imgs observed, awaiting a fetch slot (FIFO ~ visual order)
  var disposed = false;

  function schedule(img) { waiting.push(img); pumpFetch(); }
  function pumpFetch() {
    while (inflight < MAXFETCH && waiting.length) { inflight++; load(waiting.shift()); }
  }

  function load(img) {
    var id = img.dataset.id;
    function done() { inflight--; pumpFetch(); } // free the fetch slot
    // High priority: Firefox otherwise holds default-priority fetch() requests
    // for ~150ms during/after page load before dispatching them.
    fetch('/api/photos/' + id + '/thumbnail', { priority: 'high' }).then(function (res) {
      if (!res.ok) { dec.fallback(img); done(); return; }
      var o = parseInt(res.headers.get('X-Orientation'), 10) || 1;
      return res.arrayBuffer().then(function (buf) {
        done();
        dec.enqueue(img, buf, o);
      });
    }).catch(function () { dec.fallback(img); done(); });
  }

  // Kick off the first rows' fetches synchronously, during initial parse, when
  // Firefox dispatches promptly — requests issued later (from the async observer
  // callback) get held ~150ms during page load. The observer handles the rest.
  var EAGER = 24;
  for (var ei = 0; ei < thumbs.length && ei < EAGER; ei++) { thumbs[ei].__sched = 1; schedule(thumbs[ei]); }

  // Decode well ahead of the viewport so paging down lands on already-decoded
  // images: trigger ~1 screen above and ~2.5 screens below the viewport, and only
  // once per tile.
  var vh = window.innerHeight || 800;
  var io = new IntersectionObserver(function (entries) {
    if (disposed) return;
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        io.unobserve(en.target);
        if (!en.target.__sched) { en.target.__sched = 1; schedule(en.target); }
      }
    });
  }, { rootMargin: Math.round(vh) + 'px 0px ' + Math.round(vh * 2.5) + 'px 0px' });
  thumbs.forEach(function (img) { if (!img.__sched) io.observe(img); });

  return {
    dispose: function () {
      disposed = true;
      io.disconnect();
      waiting = []; // drop queued fetches for the now-detached old tiles
    }
  };
}

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
      // Group into contiguous runs by day (the API already orders newest-first).
      var curDay = null, grid = null;
      page.items.forEach(function (p) {
        var d = p.modification_date;
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
    })
    .catch(function () { if (token === renderToken) host.textContent = ''; });
}

// ===== Render orchestrator ===================================================
// Re-derive the whole page from `state`: rebuild the navbar synchronously, then
// refetch + rebuild the sub-album tiles and photo grid, and finally re-point the
// thumbnail pipeline and lightbox at the new tiles. Called on initial load, on
// nav clicks, and on Back/Forward.
function render() {
  renderNavbar();
  renderMenuFilters();
  var token = ++renderToken;
  var subsHost = document.getElementById('subalbums');
  var photosHost = document.getElementById('photos');
  return Promise.all([
    buildSubalbums(subsHost, token),
    buildGrid(photosHost, token)
  ]).then(function () {
    if (token !== renderToken) return; // superseded by a newer navigation
    ensureDecoder();
    observeTiles(collectThumbs());
    LB.refresh();
    restoreSelection();
  });
}

// ===== Navigation controller =================================================
// In-page navigation: update the URL, re-read state, scroll to top, re-render.
function navigateTo(target) {
  history.pushState({}, '', target);
  readUrl();
  window.scrollTo(0, 0);
  render();
}

function initNav() {
  // Intercept internal nav links (breadcrumb / rating / sub-album tiles — all
  // /photos hrefs). Grid tiles are <img>/<button>, not <a>, so they fall through
  // to the lightbox. Modified / non-primary clicks fall through to the browser
  // (open-in-new-tab etc.).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var url;
    try { url = new URL(a.href, location.origin); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname !== '/photos' && url.pathname.indexOf('/photos/') !== 0) return;
    e.preventDefault();
    navigateTo(url.pathname + url.search);
  });

  // Back/Forward. While the lightbox is open, the popped entry is its (URL-less)
  // history entry, so just dismiss it — the album URL is unchanged, no re-render.
  // Otherwise the URL changed to another album: re-read state and re-render.
  window.addEventListener('popstate', function () {
    if (LB && LB.isOpen()) { LB.dismiss(); return; }
    readUrl();
    window.scrollTo(0, 0);
    render();
  });

  // Alt+Up navigates to the parent album (in-page). A no-op at the root and while
  // the lightbox is open.
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.key === 'ArrowUp' && !(LB && LB.isOpen()) && state.album.length) {
      e.preventDefault();
      navigateTo(photosUrl(state.album.slice(0, -1), filters()));
    }
  });
}

// ===== Grid keyboard navigation ==============================================
// Arrow keys move a highlighted selection across both grids (sub-album tiles and
// the photo/video grid); Enter activates the selected tile (open the lightbox, or
// enter the sub-album); the selection is mirrored to the URL fragment (#item-<id>)
// and restored after each render.
var GRID_SEL = '.albums > a.album, .grid > img.thumb, .grid > .vtile';
var selected = null;

function navItems() {
  return Array.prototype.slice.call(document.querySelectorAll(GRID_SEL));
}

// Move the `.selected` highlight to `el` (no scroll, no URL change). The lightbox
// uses this so its navigation tracks the grid selection.
function setSelected(el) {
  if (selected) selected.classList.remove('selected');
  selected = el || null;
  if (selected) selected.classList.add('selected');
}

// Scroll `el` into view (a no-op if already visible), reserving room for the
// sticky navbar (its live height) plus `top` px so it doesn't land tucked
// underneath; `bottom`, when given, reserves a matching gap at the bottom edge.
// Shared by the grid selection (scrollToSelected) and the lightbox dismiss.
function scrollTileIntoView(el, top, bottom) {
  var nav = document.querySelector('.navbar');
  el.style.scrollMarginTop = ((nav ? nav.offsetHeight : 0) + top) + 'px';
  if (bottom != null) el.style.scrollMarginBottom = bottom + 'px';
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Scroll the selection into view, reserving room for the sticky navbar so it
// isn't tucked underneath.
function scrollToSelected() {
  if (!selected) return;
  scrollTileIntoView(selected, 8);
}

// Mirror the selection to the URL fragment (no history entry).
function syncSelectionHash() {
  if (selected) history.replaceState(history.state, '', location.pathname + location.search + '#' + selected.id);
}

// Select `el` from a grid arrow keypress: highlight, update the fragment, scroll.
function selectTile(el) {
  if (!el) return;
  setSelected(el);
  syncSelectionHash();
  scrollToSelected();
}

// The tile to move to from `cur` in the arrow direction. Left/Right step in DOM
// (reading) order; Up/Down are geometric — the nearest row above/below, then the
// closest column — because the grids wrap with a variable number of columns.
function neighbor(items, cur, key) {
  var i = items.indexOf(cur);
  if (key === 'ArrowLeft') return i > 0 ? items[i - 1] : null;
  if (key === 'ArrowRight') return i < items.length - 1 ? items[i + 1] : null;
  var down = key === 'ArrowDown';
  var r = cur.getBoundingClientRect();
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  var cands = [];
  for (var j = 0; j < items.length; j++) {
    if (items[j] === cur) continue;
    var rr = items[j].getBoundingClientRect();
    var yy = rr.top + rr.height / 2, xx = rr.left + rr.width / 2;
    if (down ? yy > cy + 1 : yy < cy - 1) cands.push({ el: items[j], x: xx, y: yy });
  }
  if (!cands.length) return null;
  // The nearest row in that direction (closest center-Y), then the closest column.
  var rowY = cands.reduce(function (a, b) { return Math.abs(b.y - cy) < Math.abs(a.y - cy) ? b : a; }).y;
  var inRow = cands.filter(function (c) { return Math.abs(c.y - rowY) <= 30; });
  return inRow.reduce(function (a, b) { return Math.abs(b.x - cx) < Math.abs(a.x - cx) ? b : a; }).el;
}

// PageUp/PageDown: step row by row (keeping the column) until we've moved about a
// viewport, or hit the top/bottom. Returns null if already at the edge.
function pageNeighbor(items, cur, down) {
  var startY = cur.getBoundingClientRect().top;
  var page = (window.innerHeight || 800) * 0.85;
  var at = cur, next;
  while ((next = neighbor(items, at, down ? 'ArrowDown' : 'ArrowUp'))) {
    at = next;
    if (Math.abs(at.getBoundingClientRect().top - startY) >= page) break;
  }
  return at === cur ? null : at;
}

// Re-apply the selection named by the URL fragment after a render (so it survives
// reload / Back/Forward); a hash-less URL (a normal navigation) clears it.
function restoreSelection() {
  var id = location.hash.slice(1);
  var el = id ? document.getElementById(id) : null;
  if (el && el.matches && el.matches(GRID_SEL)) { setSelected(el); scrollToSelected(); }
  else setSelected(null);
}

function initGridNav() {
  document.addEventListener('keydown', function (e) {
    if (LB && LB.isOpen()) return;                 // the lightbox owns keys then
    if (e.altKey || e.ctrlKey || e.metaKey) return; // leave Alt+Up etc. alone
    var ae = document.activeElement;
    var tag = ae && ae.tagName;
    if (/^(input|textarea|select)$/i.test(tag)) return;
    if (e.key === 'Enter') {
      // Let a focused link/button handle its own Enter; otherwise activate the tile.
      if (/^(a|button)$/i.test(tag)) return;
      if (selected) { e.preventDefault(); selected.click(); }
      return;
    }
    var k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' &&
        k !== 'Home' && k !== 'End' && k !== 'PageUp' && k !== 'PageDown') return;
    var items = navItems();
    if (!items.length) return;
    e.preventDefault();
    if (selected && !selected.isConnected) selected = null;
    var target;
    if (k === 'Home') target = items[0];
    else if (k === 'End') target = items[items.length - 1];
    else if (!selected) target = items[0];
    else if (k === 'PageUp' || k === 'PageDown') target = pageNeighbor(items, selected, k === 'PageDown');
    else target = neighbor(items, selected, k);
    selectTile(target);
  });
}

// ===== Menus (bookmarks + filters) ===========================================
// Wire a dropdown: toggle on its button, dismiss on Esc or an outside click.
// Uses composedPath() (the path captured at dispatch) rather than
// host.contains(e.target): a click inside that navigates re-renders the panel
// synchronously in initNav's handler (which runs first), detaching e.target, so
// host.contains would read an in-menu click as "outside" and wrongly close it.
// `onOpen` (optional) runs each time the panel opens.
function wireDropdown(host, dd, btn, onOpen) {
  function close() { dd.classList.remove('open'); }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (dd.classList.contains('open')) { close(); }
    else { dd.classList.add('open'); if (onOpen) onOpen(); }
  });
  document.addEventListener('click', function (e) {
    if (dd.classList.contains('open') && e.composedPath().indexOf(host) === -1) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
}

// The Filters menu: a funnel icon at the navbar's far right (the static
// `.filter-menu` span). Its dropdown's `.menu-filters` is (re)built by
// renderMenuFilters on every render; the funnel is highlighted while any filter
// is active (see renderMenuFilters). A panel — changing a filter keeps it open.
var FUNNEL_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
  '<path fill="currentColor" d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6' +
  's3.72-4.8 5.74-7.39c.51-.66.04-1.61-.79-1.61H5.04c-.83 0-1.3.95-.79 1.61z"/></svg>';
function initFilterMenu() {
  var host = document.querySelector('.filter-menu');
  if (!host) return;

  var btn = document.createElement('button');
  btn.className = 'filter-btn';
  btn.type = 'button';
  btn.title = 'Filters';
  btn.setAttribute('aria-label', 'Filters');
  btn.innerHTML = FUNNEL_SVG;

  var dd = document.createElement('div');
  dd.className = 'menu-dropdown';
  var filtersHost = document.createElement('div');
  filtersHost.className = 'menu-filters';
  dd.appendChild(filtersHost);

  host.append(btn, dd);
  wireDropdown(host, dd, btn);
}

// The Bookmarks menu: a hamburger (☰) at the navbar's far left (the static
// `.menu` span, so it survives re-renders). Lists saved bookmarks and lets you
// snapshot the current view as a new one. Bookmark links are plain /photos hrefs
// (initNav navigates); the menu stays open (a panel) so you can keep browsing.
function initMenu() {
  var host = document.querySelector('.menu');
  if (!host) return;

  var btn = document.createElement('button');
  btn.className = 'menu-btn';
  btn.type = 'button';
  btn.title = 'Bookmarks';
  btn.setAttribute('aria-label', 'Bookmarks');
  btn.textContent = '☰';

  var dd = document.createElement('div');
  dd.className = 'menu-dropdown';

  var bmTitle = document.createElement('div');
  bmTitle.className = 'menu-title';
  var bmTitleText = document.createElement('span');
  bmTitleText.textContent = 'Bookmarks';
  var addBtn = document.createElement('button');
  addBtn.className = 'menu-add';
  addBtn.type = 'button';
  addBtn.title = 'New bookmark';
  addBtn.setAttribute('aria-label', 'New bookmark');
  addBtn.textContent = '+';
  addBtn.addEventListener('click', function (e) { e.stopPropagation(); createBookmark(); });
  bmTitle.append(bmTitleText, addBtn);

  var bookmarksHost = document.createElement('div');
  bookmarksHost.className = 'menu-bookmarks';

  dd.append(bmTitle, bookmarksHost);
  host.append(btn, dd);

  var bookmarks = [];
  wireDropdown(host, dd, btn, load);

  function load() {
    fetch('/api/bookmarks')
      .then(function (r) { return r.json(); })
      .then(function (list) { bookmarks = Array.isArray(list) ? list : []; build(); })
      .catch(function () { bookmarks = []; build(); });
  }

  function build() {
    var frag = document.createDocumentFragment();

    bookmarks.forEach(function (bm) {
      var row = document.createElement('div');
      row.className = 'menu-item';

      var link = document.createElement('a');
      link.className = 'bm-link';
      link.textContent = bm.name;
      var segs = bm.album.split('/').filter(Boolean);
      link.href = photosUrl(segs, {
        minRating: bm.min_rating,
        includeImages: bm.include_images,
        includeVideo: bm.include_video,
        recursive: bm.recursive,
        aspect: bm.aspect,
        tags: bm.tags || []
      });
      // Navigation is handled by initNav's delegated handler; the menu stays open
      // (a panel, like the filters) so you can keep browsing bookmarks.
      row.appendChild(link);

      var del = document.createElement('button');
      del.className = 'bm-del';
      del.type = 'button';
      del.title = 'Delete bookmark';
      del.setAttribute('aria-label', 'Delete bookmark');
      del.textContent = '✕';
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        deleteBookmark(bm.name);
      });
      row.appendChild(del);

      frag.appendChild(row);
    });

    bookmarksHost.replaceChildren(frag);
  }

  function createBookmark() {
    var name = prompt('Bookmark name:');
    if (name === null) return;
    name = name.trim();
    if (!name) return;

    var overwrite = bookmarks.some(function (b) { return b.name.toLowerCase() === name.toLowerCase(); });
    if (overwrite && !confirm('A bookmark named "' + name + '" already exists. Overwrite?')) return;

    var body = {
      name: name,
      album: state.album.length ? '/' + state.album.join('/') : '',
      recursive: state.recursive,
      min_rating: state.minRating,
      include_images: state.includeImages,
      include_video: state.includeVideo,
      aspect: state.aspect,
      tags: state.tags,
      overwrite: overwrite
    };
    fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) { alert('Could not save bookmark.'); return; }
      load();
    }).catch(function () { alert('Could not save bookmark.'); });
  }

  function deleteBookmark(name) {
    if (!confirm('Delete bookmark "' + name + '"?')) return;
    fetch('/api/bookmarks/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function () { load(); })
      .catch(function () {});
  }
}

// ===== Bootstrap =============================================================
(function () {
  // We rebuild the grid asynchronously on Back/Forward, so the browser's own
  // scroll restoration would race our refetch — manage scroll ourselves.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  readUrl();
  initLightbox();
  initNav();
  initMenu();
  initFilterMenu();
  initGridNav();
  render();
})();

// Register the service worker (makes the app installable as a PWA). Deferred to
// `load` so it doesn't compete with the initial thumbnail fetches. Needs a secure
// context — HTTPS, or localhost during development.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
