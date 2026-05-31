(function () {
  var tiles = Array.prototype.slice.call(document.querySelectorAll('.grid img, .grid .vtile'));
  var items = tiles.map(function (el) {
    var video = el.classList.contains('vtile');
    return { src: video ? el.dataset.src : el.src, alt: el.getAttribute('alt') || '', video: video };
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
