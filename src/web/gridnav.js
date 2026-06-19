// ===== Grid keyboard navigation ==============================================
// Arrow keys move a highlighted selection across both grids (sub-album tiles and
// the photo/video grid); Enter activates the selected tile (open the lightbox, or
// enter the sub-album); the selection is mirrored to the URL fragment (#item-<id>)
// and restored after each render.
var GRID_SEL = '.albums > a.album, .grid > img.thumb, .grid > .vtile';
var selected = null;

function navItems() {
  return Array.prototype.slice.call(document.querySelectorAll(GRID_SEL));
}

// Move the `.selected` highlight to `el` (no scroll, no URL change). The lightbox
// uses this so its navigation tracks the grid selection.
function setSelected(el) {
  if (selected) selected.classList.remove('selected');
  selected = el || null;
  if (selected) selected.classList.add('selected');
}

// Scroll `el` into view (a no-op if already visible), reserving room for the
// sticky navbar (its live height) plus `top` px so it doesn't land tucked
// underneath; `bottom`, when given, reserves a matching gap at the bottom edge.
// Shared by the grid selection (scrollToSelected) and the lightbox dismiss.
function scrollTileIntoView(el, top, bottom) {
  var nav = document.querySelector('.navbar');
  el.style.scrollMarginTop = ((nav ? nav.offsetHeight : 0) + top) + 'px';
  if (bottom != null) el.style.scrollMarginBottom = bottom + 'px';
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Scroll the selection into view, reserving room for the sticky navbar so it
// isn't tucked underneath.
function scrollToSelected() {
  if (!selected) return;
  scrollTileIntoView(selected, 8);
}

// Mirror the selection to the URL fragment (no history entry).
function syncSelectionHash() {
  if (selected) history.replaceState(history.state, '', location.pathname + location.search + '#' + selected.id);
}

// Select `el` from a grid arrow keypress: highlight, update the fragment, scroll.
function selectTile(el) {
  if (!el) return;
  setSelected(el);
  syncSelectionHash();
  scrollToSelected();
}

// The tile to move to from `cur` in the arrow direction. Left/Right step in DOM
// (reading) order; Up/Down are geometric — the nearest row above/below, then the
// closest column — because the grids wrap with a variable number of columns.
function neighbor(items, cur, key) {
  var i = items.indexOf(cur);
  if (key === 'ArrowLeft') return i > 0 ? items[i - 1] : null;
  if (key === 'ArrowRight') return i < items.length - 1 ? items[i + 1] : null;
  var down = key === 'ArrowDown';
  var r = cur.getBoundingClientRect();
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  var cands = [];
  for (var j = 0; j < items.length; j++) {
    if (items[j] === cur) continue;
    var rr = items[j].getBoundingClientRect();
    var yy = rr.top + rr.height / 2, xx = rr.left + rr.width / 2;
    if (down ? yy > cy + 1 : yy < cy - 1) cands.push({ el: items[j], x: xx, y: yy });
  }
  if (!cands.length) return null;
  // The nearest row in that direction (closest center-Y), then the closest column.
  var rowY = cands.reduce(function (a, b) { return Math.abs(b.y - cy) < Math.abs(a.y - cy) ? b : a; }).y;
  var inRow = cands.filter(function (c) { return Math.abs(c.y - rowY) <= 30; });
  return inRow.reduce(function (a, b) { return Math.abs(b.x - cx) < Math.abs(a.x - cx) ? b : a; }).el;
}

// PageUp/PageDown: step row by row (keeping the column) until we've moved about a
// viewport, or hit the top/bottom. Returns null if already at the edge.
function pageNeighbor(items, cur, down) {
  var startY = cur.getBoundingClientRect().top;
  var page = (window.innerHeight || 800) * 0.85;
  var at = cur, next;
  while ((next = neighbor(items, at, down ? 'ArrowDown' : 'ArrowUp'))) {
    at = next;
    if (Math.abs(at.getBoundingClientRect().top - startY) >= page) break;
  }
  return at === cur ? null : at;
}

// Re-apply the selection named by the URL fragment after a render (so it survives
// reload / Back/Forward); a hash-less URL (a normal navigation) clears it.
function restoreSelection() {
  var id = location.hash.slice(1);
  var el = id ? document.getElementById(id) : null;
  if (el && el.matches && el.matches(GRID_SEL)) { setSelected(el); scrollToSelected(); }
  else setSelected(null);
}

function initGridNav() {
  document.addEventListener('keydown', function (e) {
    if (LB && LB.isOpen()) return;                 // the lightbox owns keys then
    if (e.altKey || e.ctrlKey || e.metaKey) return; // leave Alt+Up etc. alone
    var ae = document.activeElement;
    var tag = ae && ae.tagName;
    if (/^(input|textarea|select)$/i.test(tag)) return;
    if (e.key === 'Enter') {
      // Let a focused link/button handle its own Enter; otherwise activate the tile.
      if (/^(a|button)$/i.test(tag)) return;
      if (selected) { e.preventDefault(); selected.click(); }
      return;
    }
    var k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' &&
        k !== 'Home' && k !== 'End' && k !== 'PageUp' && k !== 'PageDown') return;
    var items = navItems();
    if (!items.length) return;
    e.preventDefault();
    if (selected && !selected.isConnected) selected = null;
    var target;
    if (k === 'Home') target = items[0];
    else if (k === 'End') target = items[items.length - 1];
    else if (!selected) target = items[0];
    else if (k === 'PageUp' || k === 'PageDown') target = pageNeighbor(items, selected, k === 'PageDown');
    else target = neighbor(items, selected, k);
    selectTile(target);
  });
}

