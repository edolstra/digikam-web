// ===== Lightbox: zoom + gestures =============================================
// Image zoom (pinch, Ctrl+wheel, +/-, double-click/tap) and pan, plus the touch
// / wheel navigation gestures. Part of the lightbox (lightbox.js passes in its
// `core`); returns the zoom API.
function initLightboxGestures(core) {
  var lb = core.lb, img = core.img;
  // ----- Touch gestures -----
  // Over the whole lightbox: one-finger swipe up -> random, left/right -> prev/next,
  // tap -> reveal controls / close on the letterbox (a tap on a video is the
  // browser's: it shows the native control overlay). Two-finger
  // pinch zooms the image (1×–4×); while zoomed, one finger pans and double-tap
  // toggles zoom. A swipe/pinch fires no click, so taps and gestures don't collide;
  // on touch these take over from the native video seek bar (mouse-usable on desktop).
  var scale = 1, tx = 0, ty = 0, ZMAX = 4;
  var sx = 0, sy = 0;     // one-finger gesture start (swipe / pan)
  var gesture = null;     // active touch sequence: {mode:'swipe'|'pan'|'pinch', …}
  var multiTouch = false; // a 2nd finger joined this sequence (suppresses swipe)
  var lastTapTime = 0;    // for double-tap detection
  var lastTouch = 0;      // last touchend time, to ignore the ghost mouse events
                          // (mousedown/dblclick) the browser synthesizes after a tap

  // Pinch-zoom applies only to images (videos keep their native controls).
  function zoomable() { return core.activeEl() === img; }
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
    // `.zoomed` hides the action row, which hosts the slideshow settings modal:
    // zooming past an open modal dismisses it.
    if (core.slideshow.panelOpen()) core.slideshow.setPanel(false);
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
    core.suppressClick = false;
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
    // Touches ending on the picker / the slideshow settings modal are left
    // entirely to native behavior: taps click checkboxes/rows/buttons/inputs,
    // drags scroll the list (touch-action: pan-y).
    if (e.target.closest('#lb-picker') || e.target.closest('#lb-slideshow')) return;
    lastTouch = e.timeStamp; // suppress the ghost mouse events that follow a tap
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

    // Any touch outside the open picker discards it (the touch counterpart
    // of the click-outside rule above); swipes don't navigate past it either.
    if (core.picker.isOpen()) { core.picker.close(); core.suppressClick = true; return; }
    // A tap outside the open slideshow settings modal: leave it to its synthetic
    // click, which the capture-phase listener consumes to close the modal (one
    // code path for mouse and touch; and no suppressClick, which would outlive
    // this tap). Swipes still navigate with the modal open.
    if (core.slideshow.panelOpen() && !moved && !wasMulti) return;

    // Double-tap an image (directly on it — not an overlaid control like the
    // ‹ › chevrons) toggles zoom: to 2× at the tap point, or back to fit.
    // Detected before the zoom guard below so it works while zoomed.
    if (!moved && !wasMulti && zoomable() && e.target === img && core.onMedia(t.clientX, t.clientY)) {
      if (e.timeStamp - lastTapTime < 300) {
        lastTapTime = 0;
        if (scale > 1) resetZoom(); else zoomTo(2, t.clientX, t.clientY);
        core.suppressClick = true;
        return;
      }
      lastTapTime = e.timeStamp;
    }

    // A pinch/pan gesture, or still zoomed (one finger pans, doesn't navigate):
    // don't swipe-navigate, close, or reveal controls (they stay hidden while zoomed).
    if (wasMulti || mode === 'pan' || scale > 1) { core.suppressClick = true; return; }

    if (ady > 50 && ady > adx) {
      // Swipe up -> random, unless it starts in the bottom ~100px, where it
      // collides with the Android "swipe up from the bottom" system gesture.
      if (dy < 0 && sy < window.innerHeight - 100) core.goRandom();
      return;
    }
    if (adx > 50 && adx > ady) { core.go(dx < 0 ? 1 : -1); return; }     // swipe left/right
    // A tap on the info button toggles the panel; a tap on its album link jumps to
    // that album; a tap on the panel itself just keeps it (none count as an
    // off-media letterbox close). The synthetic click is swallowed below.
    if (e.target.closest('.slideshow-btn')) { core.slideshow.setPanel(true); core.suppressClick = true; return; }
    var act = e.target.closest('.lb-act');
    if (act) { core.infoAction(act.dataset.act); core.suppressClick = true; return; }
    if (e.target.closest('.info')) { core.info.toggle(); core.suppressClick = true; return; }
    if (e.target.closest('#lb-info')) {
      var star = e.target.closest('.rate-star');
      if (star) { core.info.starClicked(star); core.suppressClick = true; return; }
      var cpath = e.target.closest('.copy-path');
      if (cpath) { core.info.copyPath(cpath); core.suppressClick = true; return; }
      var link = e.target.closest('a');
      if (link && link.target === '_blank') return; // let the tap open the external link
      if (link) core.jumpToAlbum(link.getAttribute('href')); else core.wake();
      core.suppressClick = true; return;
    }
    // Tap: reveal the controls / close on the letterbox. A tap on a video is
    // left to the browser: showing/hiding the native control overlay (and
    // play/pause) is its job — we deliberately don't toggle playback here.
    // Swallow the synthetic click so the mouse handler doesn't re-fire (which
    // would close on a reveal-tap); the UA's own tap handling is unaffected.
    var hidden = lb.classList.contains('idle');
    core.wake();
    if (!core.onMedia(t.clientX, t.clientY) && !hidden) core.close();
    else core.gestureFullscreen(); // an autoplay's first gesture (never on a closing tap)
    core.suppressClick = true;
  }, { passive: true });

  // Mouse wheel: Ctrl+wheel zooms the image toward the pointer (preventing the
  // browser's own page zoom); a plain wheel navigates (scroll down -> next, up ->
  // previous), throttled so one notch advances a single item. While zoomed, a plain
  // wheel does nothing (pan by dragging instead).
  var lastWheel = 0;
  lb.addEventListener('wheel', function (e) {
    // Let the picker's list scroll natively (and a wheel over the slideshow
    // settings' number box adjust it) instead of flipping photos.
    if (e.target.closest('#lb-picker') || e.target.closest('#lb-slideshow')) return;
    if (!e.deltaY) return; // ignore purely-horizontal scroll
    e.preventDefault();
    if (e.ctrlKey) {
      if (zoomable()) zoomTo(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
      return;
    }
    if (scale > 1) return; // zoomed: the wheel neither navigates nor zooms
    if (e.timeStamp - lastWheel < 50) return;
    lastWheel = e.timeStamp;
    core.go(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // Mouse drag pans a zoomed image (mirrors the one-finger touch pan). A drag that
  // moved suppresses the trailing click so it doesn't close on the letterbox.
  var panning = null;
  img.addEventListener('dragstart', function (e) { e.preventDefault(); }); // no ghost drag
  img.addEventListener('mousedown', function (e) {
    if (e.timeStamp - lastTouch < 700) return; // ghost mouse event from a touch
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
    if (panning.moved) core.suppressClick = true; // swallow the click that would close
    panning = null;
    lb.classList.remove('panning');
  });
  // Double-click an image toggles zoom: to 2× at the click point, or back to fit
  // (mirrors the touch double-tap).
  img.addEventListener('dblclick', function (e) {
    // Ignore the dblclick a browser synthesizes from a touch double-tap — the
    // touchend handler already toggled zoom; letting this fire would undo it.
    if (e.timeStamp - lastTouch < 700) return;
    if (!zoomable() || !core.onMedia(e.clientX, e.clientY)) return;
    e.preventDefault();
    if (scale > 1) resetZoom(); else zoomTo(2, e.clientX, e.clientY);
  });

  return {
    reset: resetZoom,
    zoomTo: zoomTo,
    zoomable: zoomable,
    scale: function () { return scale; }
  };
}
