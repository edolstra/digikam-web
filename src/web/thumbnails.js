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

