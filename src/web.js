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
// The current view, initialized from the URL by readUrl() and updated on each
// navigation. `album` is the decoded display segments (e.g. ["Photos","Lego"];
// [] is the virtual root); `minRating` is 0 (no filter) or 1..=5; the media-type
// filter is two booleans, both true by default (include images / include video);
// `recursive` extends the grid to all sub-albums' items.
var state = { album: [], minRating: 0, includeImages: true, includeVideo: true, recursive: false };
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
}

// The current filters as a plain object, optionally with some keys overridden —
// so a link can target "the current view but with X changed".
function filters(over) {
  var f = {
    minRating: state.minRating,
    includeImages: state.includeImages,
    includeVideo: state.includeVideo,
    recursive: state.recursive
  };
  if (over) for (var k in over) f[k] = over[k];
  return f;
}

// Build a frontend URL from album segments + a filter object, percent-encoding
// each segment and encoding each filter at its non-default value. The single
// source of truth for every nav link.
function photosUrl(segments, f) {
  var p = segments.map(encodeURIComponent);
  var qs = new URLSearchParams();
  if (f.minRating) qs.set('min_rating', f.minRating);
  if (!f.includeImages) qs.set('images', 'false');
  if (!f.includeVideo) qs.set('video', 'false');
  if (f.recursive) qs.set('recursive', 'true');
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
  var frag = document.createDocumentFragment();
  MEDIA_OPTIONS.forEach(function (o) {
    var active = state.includeImages === o.images && state.includeVideo === o.video;
    var el;
    if (active) {
      el = document.createElement('span');
      el.className = 'on';
    } else {
      el = document.createElement('a');
      el.href = photosUrl(state.album, filters({ includeImages: o.images, includeVideo: o.video }));
    }
    el.textContent = o.label;
    el.title = o.title;
    frag.appendChild(el);
  });
  host.replaceChildren(frag);
}

// The shared query for both API fetches: the album display path (empty for the
// root) plus the active filters.
function apiParams() {
  var p = new URLSearchParams();
  p.set('album', state.album.length ? '/' + state.album.join('/') : '');
  if (state.minRating) p.set('min_rating', state.minRating);
  if (!state.includeImages) p.set('images', 'false');
  if (!state.includeVideo) p.set('video', 'false');
  // Sent to /api/photos (extends the grid to all sub-albums); /api/subalbums
  // ignores it (its counts are already recursive).
  if (state.recursive) p.set('recursive', 'true');
  return p;
}

// ===== Navbar (breadcrumb + recursive/media/rating filters) =================
// Synchronous + idempotent: rebuild the navbar shell's .crumb, .recursive, .media
// and .rating from `state`. Runs during initial parse (before first paint, so no
// flash) and on every navigation.
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

  // Recursive toggle: a single glyph, gold when on, that extends the grid to all
  // sub-albums' items. Clicking flips it (keeping the other filters).
  var rec = document.createElement('a');
  if (state.recursive) rec.className = 'on';
  rec.href = photosUrl(state.album, filters({ recursive: !state.recursive }));
  rec.title = (state.recursive ? 'Showing' : 'Show') + ' items from all sub-albums';
  rec.textContent = '⊞';
  document.querySelector('.recursive').replaceChildren(rec);

  // Media-type filter: a 3-state radio (all media / images only / videos only).
  renderMedia(document.querySelector('.media'));

  var rating = document.createDocumentFragment();
  for (var k = 1; k <= 5; k++) {
    var on = k <= state.minRating;
    var star = document.createElement('a');
    if (on) star.className = 'on';
    star.href = ratingHref(k);
    star.title = '≥' + k + ' stars';
    star.textContent = on ? '★' : '☆';
    rating.appendChild(star);
  }
  document.querySelector('.rating').replaceChildren(rating);

  document.title = state.album.length ? '/' + state.album.join('/') : 'Photos';
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

  function isOpen() { return lb.classList.contains('open'); }
  function activeEl() { return vid.classList.contains('active') ? vid : img; }

  // Recompute the item list from the (just-rebuilt) grid. Direct grid children
  // only: a video tile's inner poster <img> is not its own item.
  function refresh() {
    tiles = Array.prototype.slice.call(document.querySelectorAll('.grid > img, .grid > .vtile'));
    items = tiles.map(function (el) {
      var video = el.classList.contains('vtile');
      // Photos display a decoded thumbnail in the grid; the lightbox always shows
      // the full-size original from `data-full`.
      return { src: video ? el.dataset.src : (el.dataset.full || el.src), alt: el.getAttribute('alt') || '', video: video };
    });
    idx = -1;
  }

  // The close/nav controls start hidden (open() adds `.idle`); a mouse/pen move
  // or a tap reveals them, after which they auto-hide again after 2s of
  // inactivity. Keyboard navigation and swipes deliberately do NOT reveal them.
  var idleTimer = 0;
  function wake() {
    lb.classList.remove('idle');
    clearTimeout(idleTimer);
    if (isOpen()) idleTimer = setTimeout(function () {
      if (isOpen()) lb.classList.add('idle');
    }, 2000);
  }
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
    vid.pause(); // stop any previously-playing video before switching
    if (it.video) {
      vid.src = it.src;
      vid.classList.add('active');
      img.classList.remove('active');
      img.removeAttribute('src');
      if (play) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
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
    show(i, true);
    lb.classList.add('idle'); // controls start hidden until a mouse move / tap
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
    function reveal() {
      if (!tile) return;
      // Reserve room for the sticky navbar (its actual height) plus a small gap,
      // so the tile lands fully visible — not tucked under the navbar or flush
      // against the bottom edge. scrollIntoView honors scroll-margin.
      var nav = document.querySelector('.navbar');
      tile.style.scrollMarginTop = ((nav ? nav.offsetHeight : 0) + 96) + 'px';
      tile.style.scrollMarginBottom = '96px';
      tile.scrollIntoView({ block: 'nearest' });
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

  // Jump to a random other item (the `r` key and a swipe-up both call this).
  function goRandom() {
    if (items.length <= 1) return;
    var n;
    do { n = Math.floor(Math.random() * items.length); } while (n === idx);
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
    if (suppressClick) { suppressClick = false; return; }
    var hidden = lb.classList.contains('idle');
    wake();
    if (!onMedia(e.clientX, e.clientY) && !hidden) close();
  });
  lb.querySelector('.close').addEventListener('click', function (e) { e.stopPropagation(); close(); });
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
  });

  // Swipe (over the whole lightbox, including videos): up -> random item,
  // left/right -> prev/next. A swipe fires no click, so taps (handled above) and
  // swipes don't collide. On touch these gestures take over from the native video
  // seek bar (which stays usable with a mouse on desktop).
  var sx = 0, sy = 0;
  lb.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
    suppressClick = false;
  }, { passive: true });
  lb.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    var adx = Math.abs(dx), ady = Math.abs(dy);
    if (ady > 50 && ady > adx) {
      // Swipe up -> random, unless it starts in the bottom ~100px, where it
      // collides with the Android "swipe up from the bottom" system gesture.
      if (dy < 0 && sy < window.innerHeight - 100) goRandom();
      return;
    }
    if (adx > 50 && adx > ady) { go(dx < 0 ? 1 : -1); return; }     // swipe left/right
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
  var pending = {};    // id -> {img, o}: currently decoding
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
      var id = job.img.dataset.id;
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
    btn.dataset.src = full;
    btn.title = p.name || '';
    if (reserve) btn.style.cssText = reserve;
    var poster = document.createElement('img');
    poster.className = 'thumb';
    poster.dataset.id = p.id;
    poster.alt = '';
    btn.appendChild(poster);
    return btn;
  }
  // Photo tile: src-less <img>; the pipeline paints the decoded thumbnail, and
  // `data-full` is the original (lightbox + decode fallback).
  var img = document.createElement('img');
  img.className = 'thumb';
  img.dataset.id = p.id;
  img.dataset.full = full;
  img.alt = '';
  img.title = p.name || '';
  if (reserve) img.style.cssText = reserve;
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
      navigateTo(photosUrl(state.album.slice(0, -1), state.minRating));
    }
  });
}

// ===== Bootstrap =============================================================
(function () {
  // We rebuild the grid asynchronously on Back/Forward, so the browser's own
  // scroll restoration would race our refetch — manage scroll ourselves.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  readUrl();
  initLightbox();
  initNav();
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
