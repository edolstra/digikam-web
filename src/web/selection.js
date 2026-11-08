// ===== Selection mode (multi-selection in the grid) ==========================
// Long-pressing a grid item (or `x`) enters selection mode: every grid item
// shows a checkbox, and the navbar's breadcrumb gives way to the selection bar
// (✕, "N selected", All, None, Tag, Move — the last two open the shared picker,
// picker.js, on all checked items). Clicking an item still opens the lightbox;
// closing it comes back to the grid, still in selection mode. Leaving the mode
// (Esc / ✕ / `x`) keeps the checks, so re-entering shows them again; a
// navigation (render()) clears them.
//
// Naming: the keyboard cursor in the grid is `selected` / `.selected`
// (gridnav.js); the multi-selection here is `checked` / `.checked`.
var SELECTION = null;

function initSelection() {
  var on = false;      // selection mode active
  var checked = {};    // photo id -> true
  var count = 0;
  var anchor = null;   // id of the last toggled item (where a Shift range starts)

  // ----- The navbar's selection bar -----
  var bar = document.querySelector('.select-bar');
  function barButton(cls, icon, label, title, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = title;
    b.setAttribute('aria-label', label || title);
    b.append(icon);
    if (label) {
      var l = document.createElement('span');
      l.className = 'lbl'; // dropped on narrow screens, leaving the icon
      l.textContent = ' ' + label;
      b.appendChild(l);
    }
    b.addEventListener('click', onClick);
    // A mouse click doesn't focus it, so Space / Enter keep working on the
    // grid afterwards (on a focused button they'd click it again).
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    return b;
  }
  var exitBtn = barButton('sel-exit', '✕', '', 'Leave selection mode (Esc)', function () { setMode(false); });
  var countEl = document.createElement('span');
  countEl.className = 'sel-count';
  var allBtn = barButton('sel-all', 'All', '', 'Select all (Ctrl+A)', selectAll);
  var noneBtn = barButton('sel-none', 'None', '', 'Select none', selectNone);
  var tagBtn = barButton('sel-tags', '🏷', 'Tag', 'Tag the selected items (t)', function () { openPicker('tags'); });
  var moveBtn = barButton('sel-move', '📂', 'Move', 'Move the selected items (v)', function () { openPicker('move'); });
  bar.append(exitBtn, countEl, allBtn, noneBtn, tagBtn, moveBtn);

  function update() {
    countEl.textContent = count + ' selected';
    noneBtn.disabled = tagBtn.disabled = moveBtn.disabled = !count;
  }
  function setMode(v) {
    on = v;
    document.body.classList.toggle('select-mode', v);
    update();
  }

  // ----- The checks -----
  function tiles() { return Array.prototype.slice.call(document.querySelectorAll(TILE_SEL)); }
  function setChecked(tile, v) {
    var id = tile._photo.id;
    if (!!checked[id] === v) return;
    if (v) { checked[id] = true; count++; } else { delete checked[id]; count--; }
    tile.classList.toggle('checked', v);
  }
  // Toggle `tile`; with `range`, give everything from the previously toggled
  // item to this one this one's new state.
  function toggle(tile, range) {
    var v = !checked[tile._photo.id];
    var ts = range && anchor != null ? tiles() : null;
    var a = ts ? ts.findIndex(function (t) { return t._photo.id === anchor; }) : -1;
    if (a !== -1) {
      var b = ts.indexOf(tile);
      for (var i = Math.min(a, b); i <= Math.max(a, b); i++) setChecked(ts[i], v);
    } else {
      setChecked(tile, v);
    }
    anchor = tile._photo.id;
    update();
  }
  function selectAll() {
    tiles().forEach(function (t) { setChecked(t, true); });
    update();
  }
  function selectNone() {
    tiles().forEach(function (t) { setChecked(t, false); });
    checked = {}; count = 0; anchor = null;
    update();
  }
  // The checked items' PhotoSummaries, in grid order.
  function checkedPhotos() {
    return tiles().filter(function (t) { return checked[t._photo.id]; })
      .map(function (t) { return t._photo; });
  }
  function openPicker(mode) {
    var photos = checkedPhotos();
    if (!photos.length) { toast('Nothing selected'); return; }
    PICKER.open(mode, photos);
  }

  // ----- Long press -----
  // A primary-button / touch press held still on a grid item for LONG_MS:
  // enters selection mode checking the item (it stays checked if it already
  // was), or toggles it when already in the mode. Moving (or a scroll, which
  // cancels the touch's pointer) aborts it. The click that ends a long press
  // is swallowed (no lightbox), as is the touch context menu; the image
  // callout and text selection are off on tiles in CSS.
  var LONG_MS = 500;
  var press = null;          // {tile, x, y, timer} while a press is pending
  var swallowClick = false;  // the press fired: eat its click
  function cancelPress() {
    if (press) { clearTimeout(press.timer); press = null; }
  }
  function firePress() {
    var tile = press.tile;
    cancelPress();
    if (!tile.isConnected) return;
    swallowClick = true;
    try { if (navigator.vibrate) navigator.vibrate(20); } catch (e) { /* not allowed */ }
    if (on) { toggle(tile, false); return; }
    setMode(true);
    if (!checked[tile._photo.id]) toggle(tile, false);
    else { anchor = tile._photo.id; update(); }
  }
  document.addEventListener('pointerdown', function (e) {
    swallowClick = false; // a long press that produced no click doesn't eat the next one
    cancelPress();
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var tile = e.target.closest(TILE_SEL);
    if (!tile || e.target.closest('.check')) return; // the checkbox is a plain click
    press = { tile: tile, x: e.clientX, y: e.clientY, timer: setTimeout(firePress, LONG_MS) };
  });
  document.addEventListener('pointermove', function (e) {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  window.addEventListener('scroll', cancelPress, { passive: true });
  // Android shows its context menu for a long press (about when ours fires):
  // suppress it, and take it as the long press if ours hasn't fired yet.
  document.addEventListener('contextmenu', function (e) {
    if (!e.target.closest || !e.target.closest(TILE_SEL)) return;
    if (press) { e.preventDefault(); firePress(); }
    else if (swallowClick) e.preventDefault();
  });
  // Capture phase on window, so it runs before the lightbox's delegated
  // open-on-click: a click on a checkbox toggles it (Shift: a range) and
  // nothing else; the click ending a long press does nothing at all.
  window.addEventListener('click', function (e) {
    var tile = e.target.closest && e.target.closest(TILE_SEL);
    if (!tile) return;
    if (swallowClick) {
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (on && e.target.closest('.check')) {
      e.stopPropagation();
      e.preventDefault();
      toggle(tile, e.shiftKey);
    }
  }, true);

  // ----- Keyboard -----
  // In the grid (not with the lightbox or the picker open, not while typing):
  // `x` toggles the mode; Space toggles the keyboard-cursor item (entering the
  // mode; Shift+Space: a range); in the mode, Ctrl+A checks all, `t` / `v` open
  // Tag / Move, Esc leaves. Capture phase, so it sees an Esc before the navbar
  // dropdowns' own handler closes them — an Esc that closes a menu doesn't
  // also leave the mode.
  document.addEventListener('keydown', function (e) {
    if ((LB && LB.isOpen()) || PICKER.isOpen()) return;
    var ae = document.activeElement;
    var tag = ae && ae.tagName;
    if (/^(input|textarea|select)$/i.test(tag)) return;
    if (e.altKey || e.metaKey) return;
    var k = e.key;
    if (e.ctrlKey) {
      if (on && (k === 'a' || k === 'A')) { e.preventDefault(); selectAll(); }
      return;
    }
    if (k === 'x' || k === 'X') { e.preventDefault(); setMode(!on); }
    else if (k === ' ') {
      if (/^(a|button)$/i.test(tag)) return; // Space activates a focused control
      if (!selected || !selected.isConnected || !selected.matches(TILE_SEL)) return;
      e.preventDefault();
      if (!on) setMode(true);
      toggle(selected, e.shiftKey);
    }
    else if (on && (k === 't' || k === 'T')) { e.preventDefault(); openPicker('tags'); }
    else if (on && (k === 'v' || k === 'V')) { e.preventDefault(); openPicker('move'); }
    else if (on && k === 'Escape' && !document.querySelector('.menu-dropdown.open')) {
      e.preventDefault();
      setMode(false);
    }
  }, true);

  update();
  SELECTION = {
    // A navigation: forget the checks and leave the mode.
    clear: function () {
      cancelPress();
      checked = {}; count = 0; anchor = null;
      setMode(false);
    }
  };
}
