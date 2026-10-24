// ===== Lightbox ==============================================================
// Wired up ONCE at startup; its listeners persist across navigations. The tile
// list (`tiles`/`items`) is recomputed by refresh() after each render, and the
// per-tile open is delegated, so nothing is re-bound per navigation. Exposed via
// the module-level `LB` so the nav controller can query/dismiss it.
//
// This file is the core: the item list, show/open/dismiss, navigation (incl. the
// shuffle bag), fullscreen, the controls' auto-hide, and the click / keyboard
// dispatch. The features live in lightbox-*.js, each an initLightbox*(core)
// factory: the info panel + rating (info), the slideshow (slideshow), the tags /
// move picker (picker), and zoom + touch/wheel gestures (zoom). `core` is what
// they share; they reach each other through it (core.info, core.slideshow, …).
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
  var bag = [];            // remaining indices of the current random permutation
                           // (popped from the end; reshuffled once exhausted)
  var trail = [];          // indices already shown by random navigation, oldest
                           // first — what "previous" walks back through under shuffle
  var autoplayed = false;  // opened by autoplay() and still waiting for a user
                           // gesture to enter fullscreen (see gestureFullscreen)

  // What the feature modules see of the core (accessors, since `items`/`idx`
  // change), plus the modules themselves once built, for cross-module calls.
  var core = {
    lb: lb, img: img, vid: vid,
    items: function () { return items; },
    idx: function () { return idx; },
    current: function () { return items[idx]; },
    photo: function () { return items[idx] && items[idx].photo; },
    suppressClick: false, // swallow the synthetic click a touch tap produces
    activeEl: activeEl, tapConsumed: tapConsumed, wake: wake,
    show: show, go: go, goRandom: goRandom, peekRandom: peekRandom, preload: preload,
    close: close, onMedia: onMedia, gestureFullscreen: gestureFullscreen,
    jumpToAlbum: jumpToAlbum, infoAction: infoAction, copyText: copyText
  };
  var info = core.info = initLightboxInfo(core);
  var slideshow = core.slideshow = initLightboxSlideshow(core);
  var picker = core.picker = initLightboxPicker(core);
  var zoom = core.zoom = initLightboxGestures(core);

  function isOpen() { return lb.classList.contains('open'); }
  function activeEl() { return vid.classList.contains('active') ? vid : img; }

  // A touch tap fires a synthetic click after the touchend handler already
  // acted on it; that handler (lightbox-gestures.js) sets `core.suppressClick`
  // so the click handlers swallow the stray click. Returns true (and clears the
  // flag) when consumed.
  function tapConsumed() {
    if (!core.suppressClick) return false;
    core.suppressClick = false;
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
    bag = []; trail = []; // indices changed -> drop the stale permutation + trail
  }

  // The close/nav controls start hidden (open() adds `.idle`); a mouse/pen move
  // or a tap reveals them, after which they auto-hide again after 2s of
  // inactivity. Keyboard navigation and swipes deliberately do NOT reveal them.
  var idleTimer = 0;
  function wake() {
    lb.classList.remove('idle');
    clearTimeout(idleTimer);
    // While the info panel or the slideshow settings modal is open the controls
    // stay pinned (no auto-hide).
    if (isOpen() && !pinned()) idleTimer = setTimeout(function () {
      if (isOpen() && !pinned()) lb.classList.add('idle');
    }, 2000);
  }
  function pinned() { return info.isOpen() || slideshow.panelOpen(); }

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

  // The top-left action buttons (Tag / Move / Yandex), dispatched by data-act.
  function infoAction(act) {
    if (act === 'tags' || act === 'move') picker.toggle(act);
    else if (act === 'yandex') yandexSearch();
  }

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

  // Copy `text` to the clipboard, flashing `btn` (`.copied` + `flashLabel`,
  // default ✓) for 1.2s on success before restoring its label. Resolves to
  // true/false, never rejects. Falls back to a hidden-textarea execCommand where
  // the async clipboard API is unavailable (e.g. a non-secure context).
  function copyText(text, btn, flashLabel) {
    function flash() {
      // Capture the label once: a re-click mid-flash must not capture "✓".
      if (btn._label == null) btn._label = btn.textContent;
      clearTimeout(btn._flashTimer);
      btn.classList.add('copied');
      btn.textContent = flashLabel || '✓';
      btn._flashTimer = setTimeout(function () {
        btn.textContent = btn._label;
        btn._label = null;
        btn.classList.remove('copied');
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { flash(); return true; },
        function () { return false; });
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { /* ignore */ }
    document.body.removeChild(ta);
    if (ok) flash();
    return Promise.resolve(ok);
  }

  // Mouse/pen movement reveals the controls; touch is handled by the gestures
  // (lightbox-gestures.js: a tap reveals; a swipe doesn't).
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

  function show(i, play, fade) {
    if (i < 0 || i >= items.length) return;
    idx = i;
    var it = items[i];
    if (picker.isOpen()) picker.close(); // pending picker edits don't survive navigation
    zoom.reset(); // start each item un-zoomed
    lb.classList.toggle('is-video', it.video); // hides the reverse-search button
    vid.pause(); // stop any previously-playing video before switching
    // Crossfade only image -> image (the outgoing #lb-img must be showing an image).
    var fading = fade && !it.video && activeEl() === img && !!img.getAttribute('src');
    slideshow.cancelFade(); // an in-flight fade is superseded either way
    if (it.video) {
      vid.src = it.src;
      vid.loop = !slideshow.isOn(); // in a slideshow, play once then advance on 'ended'
      vid.classList.add('active');
      img.classList.remove('active');
      img.removeAttribute('src');
      if (play) {
        var p = vid.play();
        if (p && p.catch) p.catch(function () {
          // Couldn't play (e.g. an unsupported codec) — don't stall the slideshow.
          slideshow.stalled();
        });
      }
    } else {
      if (fading) slideshow.startFade(it); // #lb-img keeps the outgoing image until the commit
      else { img.src = it.src; img.alt = it.alt; }
      img.classList.add('active');
      vid.classList.remove('active');
      vid.removeAttribute('src');
      vid.load();
    }
    prev.disabled = (i === 0);
    next.disabled = (i === items.length - 1);
    lb.classList.add('open');
    document.body.classList.add('modal-open');
    if (info.isOpen()) info.render(); // keep the panel in sync while navigating
    setSelected(tiles[i]);      // track the grid selection (revealed on dismiss)
    if (!fading) slideshow.schedule(); // (re)arm the slideshow advance for this item (a fade arms it at commit)
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
    bag = []; trail = []; // each lightbox session gets a fresh random permutation
    show(i, true);
    // Controls start hidden — unless the info panel is open, which pins them.
    if (!info.isOpen()) lb.classList.add('idle');
    // Must be requested inside the click gesture.
    enterFullscreen();
  }

  // Request browser fullscreen on the lightbox unless already in it. Needs a
  // user gesture (click / key / tap) or the browser rejects it — silently, as
  // it's caught; the full-viewport overlay then serves on its own. Unsupported
  // on iPhone Safari (guarded).
  function enterFullscreen() {
    if (!document.fullscreenElement && lb.requestFullscreen) {
      lb.requestFullscreen().catch(function () {});
    }
  }

  // Start a slideshow unprompted — the `autoplay=true` URL parameter: open the
  // lightbox on a random item (the first one with `shuffle=false`) with the
  // slideshow running. Returns false when the grid has nothing to show. The page load carries no user gesture, so the
  // fullscreen request in open() is refused unless the browser is set up to
  // allow it (kiosk mode, Chrome's "automatic fullscreen" site setting); the
  // `autoplayed` flag then makes the first key press or tap on the media enter
  // fullscreen instead of leaving that to the `f` key.
  function autoplay() {
    if (!items.length) return false;
    open(state.shuffle ? Math.floor(Math.random() * items.length) : 0);
    slideshow.set(true);
    autoplayed = true; // (harmless if open()'s own request did succeed)
    return true;
  }
  // The first user gesture after an autoplay doubles as the fullscreen request
  // (one shot, so a later deliberate `f` exit isn't undone by the next key).
  function gestureFullscreen() {
    if (!autoplayed) return;
    autoplayed = false;
    enterFullscreen();
  }

  // UI dismiss (X / Esc / tapping outside): step back in history so the Back
  // button and these all funnel through popstate -> dismiss(), keeping the
  // history stack consistent. The `closing` guard keeps repeated calls (e.g. a
  // double Esc/click before popstate lands) from popping history twice.
  function close() {
    if (isOpen() && !closing) {
      closing = true;
      history.back();
    }
  }

  function dismiss() {
    closing = false;
    autoplayed = false;
    // The settings modal doesn't outlive the session. Closed before the idle
    // timer is cleared: closing it re-arms that timer (wake), which must not
    // survive into the closed state.
    if (slideshow.panelOpen()) slideshow.setPanel(false);
    clearTimeout(idleTimer);
    slideshow.cancelFade(); // an in-flight crossfade must not commit into a closed lightbox
    if (picker.isOpen()) picker.close(); // discard pending picker edits
    // Stop any running slideshow (resets ▶ + the panel's Start/Stop label) and
    // restore the default video looping.
    slideshow.set(false);
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

  // The `f` key toggles browser-fullscreen. `requestFullscreen` needs a user
  // gesture (a keydown qualifies); no-ops where unsupported (e.g. iPhone Safari).
  // `fsToggling` marks our own exit so the handler below doesn't treat it as a
  // dismiss.
  var fsToggling = false;
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) {
        fsToggling = true;
        document.exitFullscreen().catch(function () { fsToggling = false; });
      }
    } else {
      enterFullscreen();
    }
  }

  // Fullscreen is decoupled from the lightbox's open/closed state, but pressing Esc
  // in fullscreen is our main dismiss gesture and the browser swallows its keydown
  // (it consumes Esc to exit fullscreen), so we detect that dismiss *here*. When
  // fullscreen is lost while the lightbox is open, we dismiss ONLY if it was a
  // deliberate exit while viewing — the tab still has focus and is visible. A **tab
  // switch** also drops fullscreen but sends the tab to the background (loses focus
  // / becomes hidden), so it keeps the lightbox open; likewise our own `f` toggle.
  // Deferred one tick because the focus/visibility change can land just after
  // `fullscreenchange`. (Esc while merely windowed has no fullscreen to exit, so the
  // keydown handler dismisses it; the `closing` guard de-dupes if both fire.)
  document.addEventListener('fullscreenchange', function () {
    if (document.fullscreenElement || !isOpen()) return;
    if (fsToggling) { fsToggling = false; return; }
    setTimeout(function () {
      if (isOpen() && !document.fullscreenElement && !document.hidden && document.hasFocus()) {
        // In fullscreen the browser swallows the Esc keydown to exit; that Esc
        // lands here. With the picker / slideshow settings open it means
        // "close that", not "dismiss the lightbox".
        if (picker.isOpen()) { picker.close(); return; }
        if (slideshow.panelOpen()) { slideshow.setPanel(false); return; }
        close();
      }
    }, 0);
  });

  // Navigation (arrows / chevrons / wheel / swipe / remote ⏪⏩) auto-plays a
  // video it lands on (the click/key/swipe is a user gesture, so playback with
  // audio is allowed). While a slideshow runs with Shuffle on, next/previous
  // follow the shuffle instead of grid order: next is the slideshow's own
  // advance (the bag's top), previous walks back along the trail of items the
  // random navigation showed — so back then next returns to the same item.
  function go(d) {
    if (slideshow.isOn() && state.shuffle) {
      if (d > 0) goRandom(); else goBack();
      return;
    }
    var n = idx + d;
    if (n >= 0 && n < items.length) show(n, true);
  }
  function goBack() {
    if (!trail.length) return;
    bag.push(idx); // so a subsequent next returns here
    show(trail.pop(), true);
  }

  // Advance to the next item of a random permutation of all items (the `r` key, a
  // swipe-up, and the slideshow). A shuffled bag of indices is popped one at a
  // time and only reshuffled once exhausted, so every item is shown once before
  // any repeats — no more re-seeing items mid-shuffle. Guards against re-showing
  // the current item (e.g. when manual nav landed on a still-queued index).
  function ensureBag() {
    if (!bag.length) {
      bag = items.map(function (_, n) { return n; });
      for (var k = bag.length - 1; k > 0; k--) { // Fisher-Yates
        var j = Math.floor(Math.random() * (k + 1));
        var t = bag[k]; bag[k] = bag[j]; bag[j] = t;
      }
    }
    // The top is next; don't let it be the current item (e.g. manual nav
    // landed on a still-queued index) — rotate it to the bottom.
    if (bag[bag.length - 1] === idx && bag.length > 1) bag.unshift(bag.pop());
  }
  // The index goRandom() will show next (normalizing the bag), so the slideshow
  // can preload it.
  function peekRandom() {
    ensureBag();
    return bag[bag.length - 1];
  }
  function goRandom(fade) {
    if (items.length <= 1) return;
    ensureBag();
    trail.push(idx);
    if (trail.length > 1000) trail.shift(); // a frame running for days: bound it
    show(bag.pop(), true, fade);
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
  // native controls' job. Touch taps are handled by the touch gestures
  // (lightbox-gestures.js); their synthetic click is swallowed here so this
  // doesn't re-fire.
  lb.addEventListener('click', function (e) {
    if (tapConsumed()) return;
    // With the picker open, any click outside it (its own handler stops
    // propagation) discards the pending changes — never dismisses the lightbox.
    if (picker.isOpen()) { picker.close(); return; }
    var hidden = lb.classList.contains('idle');
    wake();
    if (!onMedia(e.clientX, e.clientY) && !hidden) close();
    else gestureFullscreen(); // an autoplay's first gesture (never on a closing click)
  });
  lb.querySelector('.close').addEventListener('click', function (e) { e.stopPropagation(); close(); });
  lb.querySelector('.info').addEventListener('click', function (e) {
    e.stopPropagation();
    if (tapConsumed()) return;
    info.toggle();
  });
  Array.prototype.forEach.call(lb.querySelectorAll('.lb-act'), function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (tapConsumed()) return;
      infoAction(b.dataset.act);
    });
  });
  prev.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
  next.addEventListener('click', function (e) { e.stopPropagation(); go(1); });

  // Classify a keydown as a media-transport key, or null. Desktop keyboards
  // report a named `key`; a TV remote (LG webOS, and other CE-HTML remotes)
  // delivers its transport buttons with `key` "Unidentified" and only the
  // legacy keyCode — 413 Stop, 412 Rewind, 417 Fast forward. Deliberately no
  // Play/Pause: on webOS those two never reach the page as key events (verified
  // on an LG C5 — the platform routes them to the active media session
  // instead), and faking a media session just for them isn't worth it.
  var MEDIA_KEYS = { MediaStop: 'stop', MediaRewind: 'prev', MediaFastForward: 'next',
                     MediaTrackPrevious: 'prev', MediaTrackNext: 'next' };
  var MEDIA_KEYCODES = { 413: 'stop', 412: 'prev', 417: 'next' };
  function mediaKey(e) {
    return MEDIA_KEYS[e.key] || MEDIA_KEYCODES[e.keyCode] || null;
  }

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    // The picker owns the keyboard while open. Its own listeners handle (and
    // stopPropagation) keys typed inside it; this catches the rest — e.g. focus
    // on the picker background — so lightbox bindings (r, i, arrows, …) stay off.
    if (picker.isOpen()) {
      if (e.key === 'Escape') picker.close();
      else if (e.key === 'Enter') picker.apply();
      return;
    }
    // Ctrl+1..5 rate the current item; Ctrl+0 clears back to unrated. (Ctrl to
    // make accidental presses unlikely; note some browsers reserve Ctrl+digit
    // for tab switching / zoom reset and may not let preventDefault win.)
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key >= '0' && e.key <= '5') {
      e.preventDefault();
      info.setRating(e.key === '0' ? null : +e.key);
      return;
    }
    // Leave other modifier combos (reload, tab switching, …) to the browser.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Escape') { if (slideshow.panelOpen()) slideshow.setPanel(false); else close(); return; }
    // After an autoplay, this key press is the first user gesture: use it to
    // enter fullscreen (as well as doing whatever the key does). `f` toggles
    // fullscreen itself below, so it takes the plain path.
    if (e.key !== 'f' && e.key !== 'F') gestureFullscreen();
    // Media keys — a TV remote's Stop/⏪/⏩ or a keyboard's — stop the slideshow
    // and step items (see mediaKey). The remote's Back button is left to the
    // browser: it becomes history navigation, i.e. popstate → dismiss.
    var media = mediaKey(e);
    if (media) {
      e.preventDefault();
      if (media === 'stop') slideshow.set(false);
      else if (media === 'prev') go(-1);
      else if (media === 'next') go(1);
      return;
    }
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
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); info.toggle(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); picker.toggle('tags'); }
    // `v` as in `mv` — `m` is taken by video mute (the convention everywhere).
    else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); picker.toggle('move'); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); slideshow.toggle(); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    // +/- zoom the image toward the viewport center (like Ctrl+wheel toward the
    // pointer). `=` is `+` unshifted; `_` is `-` shifted.
    else if ((e.key === '+' || e.key === '=') && zoom.zoomable()) {
      e.preventDefault();
      zoom.zoomTo(zoom.scale() * 1.3, window.innerWidth / 2, window.innerHeight / 2);
    }
    else if ((e.key === '-' || e.key === '_') && zoom.zoomable()) {
      e.preventDefault();
      zoom.zoomTo(zoom.scale() / 1.3, window.innerWidth / 2, window.innerHeight / 2);
    }
  });

  LB = { isOpen: isOpen, dismiss: dismiss, refresh: refresh, autoplay: autoplay };
}
