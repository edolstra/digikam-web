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
  function curItem() { return idx >= 0 ? items[idx] : null; }
  function activeEl() { return vid.classList.contains('active') ? vid : img; }

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

  function togglePlay() {
    if (vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
    else vid.pause();
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
    if (!onMedia(e)) { close(); return; }
    var it = curItem();
    if (it && it.video) togglePlay();
  });
  lb.querySelector('.close').addEventListener('click', function (e) { e.stopPropagation(); close(); });
  prev.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
  next.addEventListener('click', function (e) { e.stopPropagation(); go(1); });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'Home') show(0, true);
    else if (e.key === 'End') show(items.length - 1, true);
    else if (e.key === ' ') { var it = curItem(); if (it && it.video) { e.preventDefault(); togglePlay(); } }
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

  // Horizontal swipe: left -> next, right -> prev.
  var sx = 0, sy = 0;
  lb.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  lb.addEventListener('touchend', function (e) {
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

  // The decoder runs in a Blob worker (no extra endpoint): it loads webpgf.js,
  // instantiates the module once with the wasm bytes, and decodes each blob to
  // an ImageData, transferring the pixel buffer back. The webpgf URLs are made
  // absolute (origin baked in): inside a blob: worker, importScripts/fetch
  // resolve relative paths against the opaque blob base, not the page origin.
  var base = location.origin;
  var workerSrc =
    "importScripts('" + base + "/webpgf.js');" +
    "var mp;" +
    "function gm(){if(!mp){mp=fetch('" + base + "/webpgf.wasm').then(function(r){return r.arrayBuffer();})" +
    ".then(function(b){return WebPGF({wasmBinary:b});});}return mp;}" +
    "onmessage=function(e){var id=e.data.id,buf=e.data.buf;" +
    "gm().then(function(m){var im=m.decode(new Uint8Array(buf));var o=im.data;" +
    "postMessage({id:id,w:im.width,h:im.height,buf:o.buffer},[o.buffer]);})" +
    ".catch(function(err){postMessage({id:id,error:String((err&&err.message)||err)});});};";
  var worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' })));

  var pending = {}; // id -> <img> awaiting its decode
  var orient = {};  // id -> EXIF orientation from the response header

  worker.onmessage = function (e) {
    var d = e.data, img = pending[d.id];
    if (!img) return;
    delete pending[d.id];
    var o = orient[d.id] || 1; delete orient[d.id];
    if (d.error) fallback(img);
    else paint(img, d.w, d.h, d.buf, o);
  };
  // If the worker itself dies (e.g. the wasm fails to load), give every pending
  // tile its original so the page still shows images.
  worker.onerror = function () {
    for (var id in pending) fallback(pending[id]);
    pending = {};
  };

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

  function load(img) {
    var id = img.dataset.id;
    fetch('/api/photos/' + id + '/thumbnail').then(function (res) {
      if (!res.ok) { fallback(img); return; }
      orient[id] = parseInt(res.headers.get('X-Orientation'), 10) || 1;
      return res.arrayBuffer().then(function (buf) {
        pending[id] = img;
        worker.postMessage({ id: id, buf: buf }, [buf]);
      });
    }).catch(function () { fallback(img); });
  }

  // Start decoding a little before a tile scrolls in, and only once per tile.
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { io.unobserve(en.target); load(en.target); }
    });
  }, { rootMargin: '300px' });
  thumbs.forEach(function (img) { io.observe(img); });
})();
