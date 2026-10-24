// ===== Lightbox: slideshow ===================================================
// Auto-advance (shuffled or grid order), the screen wake lock while it runs, the
// ▶ settings modal (#lb-slideshow), and the image → image crossfade. Part of the
// lightbox (lightbox.js passes in its `core`); returns the slideshow's API.
function initLightboxSlideshow(core) {
  var lb = core.lb, img = core.img, vid = core.vid;
  var slideBtn = lb.querySelector('.slideshow-btn');
  var slideshowOn = false; // auto-advancing to a random item
  var slideTimer = 0;      // pending image advance (videos advance on 'ended')
  // The slideshow settings panel (#lb-slideshow): a small modal hanging from the
  // ▶ button. Its values are state.interval / state.shuffle (in memory only —
  // never the URL or storage; "Copy slideshow link" is the one thing that turns
  // them into a URL). While open the controls stay pinned like the info panel.
  var ssPanel = document.getElementById('lb-slideshow');
  var ssInput = ssPanel.querySelector('.ss-interval');
  var ssShuffle = ssPanel.querySelector('.ss-shuffle');
  var ssStart = ssPanel.querySelector('.ss-start');
  var ssOpen = false;

  // Slideshow: auto-advance — to a random item (state.shuffle, the default) or
  // the next one in grid order, wrapping at the end. Images advance after
  // `state.interval` seconds (5 by default; the settings panel or the
  // `interval=` URL parameter); a video plays in full and advances when it ends
  // (the 'ended' listener below) — so its loop is turned off while a slideshow
  // runs.
  function clearSlide() { clearTimeout(slideTimer); slideTimer = 0; }
  function slideAdvance() {
    var n = core.items().length;
    if (state.shuffle) core.goRandom(true);
    else if (n) core.show((core.idx() + 1) % n, true, true);
  }
  // The item the next slideshow advance will land on (for preloading; -1 if
  // none). Under shuffle this normalizes the bag so its top is that item.
  function peekNext() {
    var n = core.items().length;
    if (n <= 1) return -1;
    if (!state.shuffle) return (core.idx() + 1) % n;
    return core.peekRandom();
  }
  function scheduleSlide() {
    clearSlide();
    if (!slideshowOn) return;
    var it = core.current();
    if (it && !it.video) slideTimer = setTimeout(slideAdvance, state.interval * 1000);
    core.preload(peekNext()); // so the crossfade (which waits for the load) starts on time
  }
  function setSlideshow(on) {
    slideshowOn = on;
    lb.classList.toggle('slideshow', on);
    slideBtn.textContent = on ? '⏸' : '▶';
    slideBtn.title = (on ? 'Slideshow running — settings' : 'Slideshow settings') + ' (s starts/stops)';
    ssStart.textContent = on ? '⏸ Stop slideshow' : '▶ Start slideshow';
    if (core.activeEl() === vid) vid.loop = !on;
    if (ssOpen) setSlideshowPanel(false); // Start/Stop (from any path) dismisses the modal
    if (on) acquireWakeLock(); else releaseWakeLock();
    scheduleSlide();
  }
  function toggleSlideshow() { setSlideshow(!slideshowOn); }
  vid.addEventListener('ended', function () { if (slideshowOn) slideAdvance(); });

  // ----- Screen wake lock -----
  // Keep the screen on while a slideshow runs: no screensaver, dimming or idle
  // lock — and on Linux desktops no idle suspend either, since browsers map the
  // lock to the freedesktop ScreenSaver inhibit. Needs a secure context (HTTPS /
  // localhost) and browser support; a no-op otherwise. The browser releases
  // the lock whenever the page is hidden (tab switch, minimize), so it's
  // re-acquired on becoming visible while the slideshow still runs.
  var wakeLock = null, wakeLockPending = false;
  function acquireWakeLock() {
    if (!navigator.wakeLock || wakeLock || wakeLockPending || document.hidden) return;
    wakeLockPending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLockPending = false;
      wakeLock = lock;
      lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; });
      if (!slideshowOn) releaseWakeLock(); // stopped while the request was pending
    }, function () { wakeLockPending = false; }); // denied (e.g. low battery) / unsupported
  }
  function releaseWakeLock() {
    if (!wakeLock) return;
    var lock = wakeLock;
    wakeLock = null;
    lock.release().catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && slideshowOn) acquireWakeLock();
  });

  // ----- Slideshow settings panel -----
  // Open/close the modal under the ▶ button. Opening seeds the controls from
  // `state` (the panel is the only writer, so nothing else can be stale) and,
  // with a real keyboard, focuses the interval box with its value selected (not
  // on touch: that would pop the on-screen keyboard). core.wake() at the end: on open
  // it reveals the controls and — since pinned() now holds — arms no idle
  // timer; on close it re-arms the usual 2s auto-hide.
  function setSlideshowPanel(on) {
    ssOpen = on;
    lb.classList.toggle('slideshow-open', on);
    slideBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) {
      ssInput.value = state.interval;
      renderShuffle();
      if (window.matchMedia && matchMedia('(hover: hover)').matches) { ssInput.focus(); ssInput.select(); }
    } else if (ssPanel.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    core.wake();
  }
  function renderShuffle() {
    Array.prototype.forEach.call(ssShuffle.children, function (b) {
      b.classList.toggle('on', b.dataset.shuffle === String(state.shuffle));
    });
  }
  // Apply the typed interval. Only in-memory state; a running slideshow re-arms
  // with the new value (the countdown restarts). Invalid/empty input changes
  // nothing (the box shows :invalid via its min). A showing video is left alone:
  // its advance comes from 'ended', and re-arming would cancel the 1.5s
  // unplayable-video fallback.
  function applyInterval() {
    var s = parseFloat(ssInput.value);
    if (!(s > 0)) return;
    state.interval = s;
    var it = core.current();
    if (!(it && it.video)) scheduleSlide();
  }
  // The current view (album + filters — what every nav link carries) plus the
  // slideshow launch settings. Deliberately NOT part of setFilterParams, so no
  // nav link ever picks them up: this is the one place they're written to a
  // URL. Built from `state`, not `location`, so a page loaded with them doesn't
  // duplicate them (and the #item-… fragment is dropped).
  function slideshowLink() {
    var u = new URL(photosUrl(state.album, filters()), location.origin);
    u.searchParams.set('autoplay', 'true');
    if (state.interval !== 5) u.searchParams.set('interval', String(state.interval));
    if (!state.shuffle) u.searchParams.set('shuffle', 'false');
    return u.href;
  }
  function copySlideshowLink(btn) {
    core.copyText(slideshowLink(), btn, '✓ Copied').then(function (ok) {
      toast(ok ? 'Link copied' : 'copy failed', !ok);
    });
  }

  // The current item couldn't play (e.g. a video with an unsupported codec):
  // don't stall a running slideshow on it — advance after 1.5s.
  function stalled() {
    if (slideshowOn) { clearSlide(); slideTimer = setTimeout(slideAdvance, 1500); }
  }

  // ----- Slideshow crossfade -----
  // A slideshow advance from one image to another dissolves instead of cutting:
  // the incoming image loads in an overlay (#lb-fade) above the current one,
  // invisible, and only once fully decoded fades in (a CSS transition); then
  // it's committed to the real #lb-img (a cache hit, so no flicker) and the
  // overlay is hidden instantly. Videos never fade, on either side. The timer
  // for the following advance is armed at commit, so loading + fading don't
  // eat into the interval. Any navigation, dismiss, or a newer fade cancels an
  // in-flight one (the token).
  var fadeEl = document.getElementById('lb-fade');
  var fadeToken = 0;
  var FADE_MS = 400; // keep in sync with #lb-fade's transition
  function whenLoaded(el) {
    if (el.decode) return el.decode();
    return new Promise(function (res) { el.onload = res; el.onerror = res; });
  }
  function cancelFade() {
    fadeToken++;
    fadeEl.classList.add('snap');
    fadeEl.classList.remove('show');
    fadeEl.removeAttribute('src');
    void fadeEl.offsetWidth; // flush, so the .show removal doesn't animate later
    fadeEl.classList.remove('snap');
  }
  function startFade(it) {
    var token = ++fadeToken;
    fadeEl.src = it.src;
    fadeEl.alt = it.alt;
    function commit() {
      if (token !== fadeToken) return;
      img.src = it.src;
      img.alt = it.alt;
      // Keep the overlay up until the real element shows the (cached) image.
      var done = function () { if (token === fadeToken) { cancelFade(); scheduleSlide(); } };
      whenLoaded(img).then(done, done);
    }
    whenLoaded(fadeEl).then(function () {
      if (token !== fadeToken) return;
      fadeEl.classList.add('show');
      setTimeout(commit, FADE_MS);
    }, commit); // a broken image: just cut to it (the alt text), as without a fade
  }

  // ▶ opens the slideshow settings modal (the `s` key starts/stops directly).
  // With the modal already open, the click never gets here: the capture-phase
  // outside-click listener below consumes it (closing the modal).
  slideBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (core.tapConsumed()) return;
    setSlideshowPanel(true);
  });
  // Any click outside the open modal closes it and does nothing else — the
  // picker's click-outside rule. Capture phase, so it runs before the control
  // handlers (X, ⓘ, Tag/Move, ‹ ›, ▶ itself), which stop propagation. Touch
  // taps outside reach here via their synthetic click (the touchend handler
  // leaves them alone while the modal is open).
  lb.addEventListener('click', function (e) {
    if (!ssOpen || e.target.closest('#lb-slideshow')) return;
    e.stopPropagation();
    setSlideshowPanel(false);
  }, true);
  // Clicks inside the modal stay inside it (never the letterbox-close handler).
  ssPanel.addEventListener('click', function (e) {
    e.stopPropagation();
    if (core.tapConsumed()) return;
    core.wake();
    var seg = e.target.closest('.ss-shuffle button');
    if (seg) { state.shuffle = seg.dataset.shuffle === 'true'; renderShuffle(); return; }
    if (e.target.closest('.ss-start')) toggleSlideshow();
    else if (e.target.closest('.ss-copy')) copySlideshowLink(e.target.closest('.ss-copy'));
  });
  ssInput.addEventListener('input', applyInterval);
  ssInput.addEventListener('change', applyInterval);
  // The modal owns the keyboard while focus is inside it: the document-level
  // lightbox bindings (i/t/v/s/f/r/…) must not fire on typed digits or letters.
  // Enter in the number box starts the slideshow with the typed interval (on a
  // focused button it stays the native click); Esc just closes.
  ssPanel.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter' && e.target === ssInput) { e.preventDefault(); applyInterval(); setSlideshow(true); }
    else if (e.key === 'Escape') { e.preventDefault(); setSlideshowPanel(false); }
  });

  return {
    isOn: function () { return slideshowOn; },
    set: setSlideshow,
    toggle: toggleSlideshow,
    schedule: scheduleSlide,
    stalled: stalled,
    panelOpen: function () { return ssOpen; },
    setPanel: setSlideshowPanel,
    startFade: startFade,
    cancelFade: cancelFade
  };
}
