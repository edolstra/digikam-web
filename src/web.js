(function () {
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
  // Mouse/pen movement reveals; touch movement (a swipe) does not.
  lb.addEventListener('pointermove', function (e) { if (e.pointerType !== 'touch') wake(); });
  // A tap/click reveals the controls; a swipe fires no click, so it doesn't. A
  // click while they're hidden only reveals (consumed, so it doesn't also
  // dismiss/navigate). Capture phase runs before the other click handlers.
  lb.addEventListener('click', function (e) {
    var hidden = lb.classList.contains('idle');
    wake();
    if (hidden) { e.stopPropagation(); e.preventDefault(); }
  }, true);

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
    idx = -1;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
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

  tiles.forEach(function (el, i) {
    el.addEventListener('click', function () { open(i); });
  });

  // The media fills the viewport (so small items scale up too), letterboxed via
  // object-fit: contain. Clicking that letterbox (outside the media) dismisses;
  // clicking a video toggles play/pause; clicking a photo does nothing.
  function onMedia(e) {
    var el = activeEl();
    var r = el.getBoundingClientRect();
    var nw = el.naturalWidth || el.videoWidth, nh = el.naturalHeight || el.videoHeight;
    if (!nw || !nh) return true; // not loaded yet: treat as on-media
    var s = Math.min(r.width / nw, r.height / nh);
    var w = nw * s, h = nh * s;
    var x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
    return e.clientX >= x && e.clientX <= x + w && e.clientY >= y && e.clientY <= y + h;
  }
  lb.addEventListener('click', function (e) {
    // Click outside the media (the letterbox) closes; clicks on the media itself
    // are left to the native video controls (and do nothing for images).
    if (!onMedia(e)) close();
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
    else if (e.key === ' ' && activeEl() === vid) {
      // Toggle the video (it isn't focused, so the native space-to-play won't fire).
      e.preventDefault();
      if (vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
      else vid.pause();
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

  // Horizontal swipe: left -> next, right -> prev. Skip drags that begin on the
  // video so dragging its seek bar (also a horizontal gesture) seeks, not navigates.
  var sx = 0, sy = 0, fromVideo = false;
  lb.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
    fromVideo = (e.target === vid);
  }, { passive: true });
  lb.addEventListener('touchend', function (e) {
    if (fromVideo) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// --- Lazy PGF thumbnail decoding ---------------------------------------------
// Each `img.thumb` tile fetches /api/photos/:id/thumbnail (a raw PGF blob) when
// it nears the viewport, decodes it off the main thread in a webpgf (wasm) Web
// Worker, and paints the result — rotated per the X-Orientation header — into
// the <img>. Missing thumbnails (404) or any failure fall back to the full-size
// /file original.
(function () {
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
})();

// Register the service worker (makes the app installable as a PWA). Deferred to
// `load` so it doesn't compete with the initial thumbnail fetches. Needs a secure
// context — HTTPS, or localhost during development.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
