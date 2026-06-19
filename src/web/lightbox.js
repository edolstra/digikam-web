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
    // Format + MIME on one row, e.g. "jpg (image/jpeg)".
    var fmt = p.format ? p.format.toLowerCase() : null;
    var format = (fmt && p.mime) ? (fmt + ' (' + p.mime + ')') : (fmt || p.mime || null);
    var rows = [
      ['File', fileCell],
      ['Album', album],
      ['Rating', p.rating != null ? '★'.repeat(p.rating) + '☆'.repeat(5 - p.rating) : null],
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
    // The copy-path button copies the absolute server path to the clipboard.
    var cp = e.target.closest('.copy-path');
    if (cp) { e.preventDefault(); copyPath(cp); return; }
    // Internal panel links (album / tag) navigate in-page via jumpToAlbum; an
    // external link (the maps link, target=_blank) falls through to open normally.
    var a = e.target.closest('a');
    if (a && a.target !== '_blank') { e.preventDefault(); jumpToAlbum(a.getAttribute('href')); }
  });

  // Reverse-image-search the current photo on Yandex (the lightbox 🔍 button). The
  // browser can't reach Yandex's results directly (its upload endpoint sends no CORS
  // headers and only a transitional page), so the server endpoint uploads the image
  // bytes, reads the CBIR id, and 302-redirects to the results — opening it in a new
  // tab is enough. Confirms first, since it uploads the image to a third party.
  function yandexSearch() {
    var it = items[idx];
    if (!it || it.video || !it.photo) return;
    if (!confirm('Reverse image search this photo on Yandex?\nThe image will be uploaded to Yandex.')) return;
    window.open('/api/photos/' + it.photo.id + '/reverse-search?engine=yandex', '_blank', 'noopener');
  }

  // Copy a tile's absolute server path to the clipboard, with a brief ✓ flash.
  // Falls back to a hidden-textarea execCommand where the async clipboard API is
  // unavailable (e.g. a non-secure context).
  function copyPath(btn) {
    var path = btn.dataset.path;
    if (!path) return;
    var flash = function () {
      btn.classList.add('copied');
      btn.textContent = '✓';
      setTimeout(function () { btn.textContent = '⧉'; btn.classList.remove('copied'); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path).then(flash, function () {});
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = path;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flash(); } catch (err) { /* ignore */ }
    document.body.removeChild(ta);
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
    resetZoom(); // start each item un-zoomed
    lb.classList.toggle('is-video', it.video); // hides the reverse-search button
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
  lb.querySelector('.search-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    if (tapConsumed()) return;
    yandexSearch();
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
    // +/- zoom the image toward the viewport center (like Ctrl+wheel toward the
    // pointer). `=` is `+` unshifted; `_` is `-` shifted.
    else if ((e.key === '+' || e.key === '=') && zoomable()) {
      e.preventDefault();
      zoomTo(scale * 1.3, window.innerWidth / 2, window.innerHeight / 2);
    }
    else if ((e.key === '-' || e.key === '_') && zoomable()) {
      e.preventDefault();
      zoomTo(scale / 1.3, window.innerWidth / 2, window.innerHeight / 2);
    }
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
    // Hide all controls (incl. the ‹ › chevrons) while zoomed — see assets/style.css.
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
    if (e.target.closest('.search-btn')) { yandexSearch(); suppressClick = true; return; }
    if (e.target.closest('.info')) { toggleInfo(); suppressClick = true; return; }
    if (e.target.closest('#lb-info')) {
      var cpath = e.target.closest('.copy-path');
      if (cpath) { copyPath(cpath); suppressClick = true; return; }
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

  // Mouse wheel: Ctrl+wheel zooms the image toward the pointer (preventing the
  // browser's own page zoom); a plain wheel navigates (scroll down -> next, up ->
  // previous), throttled so one notch advances a single item. While zoomed, a plain
  // wheel does nothing (pan by dragging instead).
  var lastWheel = 0;
  lb.addEventListener('wheel', function (e) {
    if (!e.deltaY) return; // ignore purely-horizontal scroll
    e.preventDefault();
    if (e.ctrlKey) {
      if (zoomable()) zoomTo(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
      return;
    }
    if (scale > 1) return; // zoomed: the wheel neither navigates nor zooms
    if (e.timeStamp - lastWheel < 50) return;
    lastWheel = e.timeStamp;
    go(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // Mouse drag pans a zoomed image (mirrors the one-finger touch pan). A drag that
  // moved suppresses the trailing click so it doesn't close on the letterbox.
  var panning = null;
  img.addEventListener('dragstart', function (e) { e.preventDefault(); }); // no ghost drag
  img.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || scale <= 1 || !zoomable()) return;
    e.preventDefault();
    panning = { x0: e.clientX, y0: e.clientY, tx0: tx, ty0: ty, moved: false };
    lb.classList.add('panning');
  });
  document.addEventListener('mousemove', function (e) {
    if (!panning) return;
    var dx = e.clientX - panning.x0, dy = e.clientY - panning.y0;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panning.moved = true;
    tx = panning.tx0 + dx; ty = panning.ty0 + dy;
    clampPan(); applyZoom();
  });
  document.addEventListener('mouseup', function () {
    if (!panning) return;
    if (panning.moved) suppressClick = true; // swallow the click that would close
    panning = null;
    lb.classList.remove('panning');
  });
  // Double-click an image toggles zoom: to 2× at the click point, or back to fit
  // (mirrors the touch double-tap).
  img.addEventListener('dblclick', function (e) {
    if (!zoomable() || !onMedia(e.clientX, e.clientY)) return;
    e.preventDefault();
    if (scale > 1) resetZoom(); else zoomTo(2, e.clientX, e.clientY);
  });

  LB = { isOpen: isOpen, dismiss: dismiss, refresh: refresh };
}

