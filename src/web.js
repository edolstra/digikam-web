// Wire up the lightbox over the (now client-built) grid. Called after the grid
// is populated (see the bootstrap at the bottom).
function initLightbox() {
  // Direct children only: a video tile's inner poster <img> is not its own item.
  var tiles = Array.prototype.slice.call(document.querySelectorAll('.grid > img, .grid > .vtile'));
  var items = tiles.map(function (el) {
    var video = el.classList.contains('vtile');
    // Photos display a decoded thumbnail in the grid; the lightbox always shows
    // the full-size original from `data-full`.
    return { src: video ? el.dataset.src : (el.dataset.full || el.src), alt: el.getAttribute('alt') || '', video: video };
  });
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
  // pops it and dismisses, instead of navigating off the album page. Opening a
  // video plays it (the tap is the user gesture, so audio is allowed), and we
  // enter fullscreen to hide the browser chrome.
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

  window.addEventListener('popstate', function () {
    if (isOpen()) dismiss();
  });

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

  tiles.forEach(function (el, i) {
    el.addEventListener('click', function () { open(i); });
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

  // Alt+Up navigates to the parent album (the second-to-last breadcrumb link,
  // which already carries the active filters). Only in the album view, not the
  // lightbox; a no-op at the root, where there's no parent.
  document.addEventListener('keydown', function (e) {
    if (isOpen() || !e.altKey || e.key !== 'ArrowUp') return;
    e.preventDefault();
    var crumbs = document.querySelectorAll('.crumb a');
    if (crumbs.length >= 2) {
      location.href = crumbs[crumbs.length - 2].href;
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
}

// --- Lazy PGF thumbnail decoding ---------------------------------------------
// Each `img.thumb` tile fetches /api/photos/:id/thumbnail (a raw PGF blob) when
// it nears the viewport, decodes it off the main thread in a webpgf (wasm) Web
// Worker, and paints the result — rotated per the X-Orientation header — into
// the <img>. Missing thumbnails (404) or any failure fall back to the full-size
// /file original. Called after the grid is built (bootstrap at the bottom).
function initThumbnails() {
  var thumbs = document.querySelectorAll('img.thumb');
  if (!thumbs.length) return;

  // Without IntersectionObserver/Worker support, just load the originals.
  if (!('IntersectionObserver' in window) || typeof Worker === 'undefined') {
    thumbs.forEach(function (img) { img.src = img.dataset.full; });
    return;
  }

  // Decoding happens in a Blob-worker pool. To make the FIRST paint snappy, the
  // decoder assets are fetched once here (not once per worker) and the pool is
  // pre-warmed: webpgf.js is inlined into the worker body (so workers don't each
  // re-fetch it), and the wasm module is instantiated right away via an init
  // message — overlapping with the thumbnail fetches — so blobs decode the instant
  // they arrive instead of waiting on a cold module. Fetch (network) and decode
  // (CPU) stay separate stages so the wide prefetch window keeps up.
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
    // Video posters carry no `data-full`: a missing/failed thumbnail just leaves
    // the empty tile showing the ▶ placeholder, rather than loading the video.
    var full = img.dataset.full;
    if (!full) return;
    img.addEventListener('load', function () { img.style.width = ''; }, { once: true });
    img.src = full;
  }

  function paint(img, w, h, buf, o) {
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

  // Cap concurrent thumbnail fetches. Firing a whole screenful of fetches at once
  // makes Firefox's request pacer hold the burst (~hundreds of ms before any is
  // even dispatched); a small cap matching the ~6-connection limit keeps the pacer
  // out of the way, and — since the observer queues tiles top-to-bottom — fetches
  // the visible rows first.
  var MAXFETCH = 6;
  var inflight = 0;
  var waiting = []; // imgs observed, awaiting a fetch slot (FIFO ~ visual order)

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
      if (!res.ok) { fallback(img); done(); return; }
      var o = parseInt(res.headers.get('X-Orientation'), 10) || 1;
      return res.arrayBuffer().then(function (buf) {
        done();
        if (ditched) { fallback(img); return; } // no decoders left
        queue.push({ img: img, buf: buf, o: o });
        drain();
      });
    }).catch(function () { fallback(img); done(); });
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
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        io.unobserve(en.target);
        if (!en.target.__sched) { en.target.__sched = 1; schedule(en.target); }
      }
    });
  }, { rootMargin: Math.round(vh) + 'px 0px ' + Math.round(vh * 2.5) + 'px 0px' });
  thumbs.forEach(function (img) { if (!img.__sched) io.observe(img); });
}

// --- Client-rendered photo grid ----------------------------------------------
// The page ships a static shell with an empty `#photos` container (real albums
// only). We fetch /api/photos for the current album + filters (read from the
// URL) and build the day-grouped grid, then wire up thumbnails + the lightbox.
// (A later step will re-run this on in-page album/filter navigation.)
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

function buildGrid(host) {
  // album is the display path after `/photos` (decoded); filters come from the
  // query string. e.g. /photos/Photos/Lego?min_rating=3 -> album=/Photos/Lego.
  var album = decodeURIComponent(location.pathname.replace(/^\/photos/, ''));
  var params = new URLSearchParams(location.search); // min_rating, …
  params.set('album', album);
  return fetch('/api/photos?' + params.toString())
    .then(function (r) { return r.json(); })
    .then(function (page) {
      host.textContent = '';
      var count = document.createElement('p');
      count.className = 'count';
      count.textContent = page.items.length + (page.incomplete ? '+' : '') + ' photo(s)';
      host.appendChild(count);
      if (!page.items.length) {
        var none = document.createElement('p');
        none.textContent = 'No photos in this album.';
        host.appendChild(none);
        return;
      }
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
      host.textContent = '';
      var err = document.createElement('p');
      err.textContent = 'Failed to load photos.';
      host.appendChild(err);
    });
}

// Bootstrap: build the grid (if this is a real album) before wiring the
// thumbnail pipeline and lightbox, which both scan the now-populated DOM.
(function () {
  var host = document.getElementById('photos');
  function start() { initThumbnails(); initLightbox(); }
  if (host) buildGrid(host).then(start);
  else start();
})();

// Register the service worker (makes the app installable as a PWA). Deferred to
// `load` so it doesn't compete with the initial thumbnail fetches. Needs a secure
// context — HTTPS, or localhost during development.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
