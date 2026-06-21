// ===== Navbar (breadcrumb) ===================================================
// Synchronous + idempotent: rebuild the navbar shell's .crumb from `state`. Runs
// during initial parse (before first paint, so no flash) and on every navigation.
// The filter controls live in the hamburger menu now (see renderMenuFilters).
function renderNavbar() {
  var crumb = document.createDocumentFragment();
  var home = document.createElement('a');
  home.className = 'home';
  home.href = photosUrl([], filters());
  home.setAttribute('aria-label', 'Home');
  home.textContent = '⌂';
  crumb.appendChild(home);
  state.album.forEach(function (seg, i) {
    var sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    crumb.appendChild(sep);
    var a = document.createElement('a');
    // The cumulative path up to and including segment i.
    a.href = photosUrl(state.album.slice(0, i + 1), filters());
    a.textContent = seg;
    crumb.appendChild(a);
  });
  document.querySelector('.crumb').replaceChildren(crumb);

  document.title = state.album.length ? '/' + state.album.join('/') : 'Photos';
}

// Build one "label: control" row for the Filters panel.
function filterRow(label, control) {
  var row = document.createElement('div');
  row.className = 'filter-row';
  var l = document.createElement('span');
  l.className = 'filter-label';
  l.textContent = label;
  row.append(l, control);
  return row;
}

// Rebuild the Filters menu (the funnel dropdown) from `state`. Called from
// render() (so the active states track navigation), and also highlights the
// funnel button whenever any filter is active. The controls are the same
// state-reflecting /photos links as before — initNav navigates on click, and the
// menu deliberately stays open so several filters can be tweaked in a row.
function renderMenuFilters() {
  var active = filtersActive();
  // Highlight the funnel icon when filtering is in effect (visual feedback).
  var fbtn = document.querySelector('.filter-btn');
  if (fbtn) fbtn.classList.toggle('active', !!active);

  var host = document.querySelector('.menu-filters');
  if (!host) return;
  var frag = document.createDocumentFragment();

  // "Filters" section header with a ↺ clear-all action on the right.
  var title = document.createElement('div');
  title.className = 'menu-title';
  var titleText = document.createElement('span');
  titleText.textContent = 'Filters';
  var reset = document.createElement('a');
  reset.className = active ? 'reset' : 'reset disabled';
  reset.href = photosUrl(state.album, DEFAULT_FILTERS);
  reset.title = 'Clear all filters';
  reset.textContent = '↺';
  title.append(titleText, reset);
  frag.appendChild(title);

  // Recursive: a 2-option [On|Off] segmented control.
  var rec = document.createElement('span');
  rec.className = 'seg recursive-toggle';
  segmented(rec, [['On', true], ['Off', false]].map(function (o) {
    return {
      label: o[0],
      active: state.recursive === o[1],
      href: photosUrl(state.album, filters({ recursive: o[1] }))
    };
  }));
  frag.appendChild(filterRow('Recursive', rec));

  // Stars: the 5-star rating selector.
  var rating = document.createElement('span');
  rating.className = 'rating';
  for (var k = 1; k <= 5; k++) {
    var on = k <= state.minRating;
    var star = document.createElement('a');
    if (on) star.className = 'on';
    star.href = ratingHref(k);
    star.title = '≥' + k + ' stars';
    star.textContent = on ? '★' : '☆';
    rating.appendChild(star);
  }
  frag.appendChild(filterRow('Stars', rating));

  // Media-type: a 3-state radio (all media / images only / videos only).
  var media = document.createElement('span');
  media.className = 'media';
  renderMedia(media);
  frag.appendChild(filterRow('Media', media));

  // Aspect-ratio: a 3-state radio (all / portrait / landscape).
  var aspect = document.createElement('span');
  aspect.className = 'aspect';
  renderAspect(aspect);
  frag.appendChild(filterRow('Aspect ratio', aspect));

  // Tags: a free-text, comma-separated input. A bare token matches a tag (and its
  // subtree) by name; a "/path" token matches by absolute path. Commit on Enter or
  // blur — navigating only when the list actually changed.
  var tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.className = 'tags-input';
  tagsInput.value = state.tags.join(', ');
  tagsInput.placeholder = 'tag, /animals/cats';
  tagsInput.setAttribute('aria-label', 'Filter by tags');
  function commitTags() {
    var parsed = tagsInput.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (JSON.stringify(parsed) === JSON.stringify(state.tags)) return false; // unchanged
    navigateTo(photosUrl(state.album, filters({ tags: parsed })));
    return true;
  }
  tagsInput.addEventListener('keydown', function (e) {
    // stopPropagation: committing re-renders and detaches this input, so without it
    // the Enter would bubble to the grid-nav handler (activeElement no longer an
    // input by then) and open the selected tile in the lightbox.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (commitTags()) {
        // The re-render replaced this input — move focus to the fresh one (caret at end).
        var ni = document.querySelector('.tags-input');
        if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
      }
    }
  });
  tagsInput.addEventListener('blur', commitTags);
  frag.appendChild(filterRow('Tags', tagsInput));

  host.replaceChildren(frag);
}

// ===== Menus (bookmarks + filters) ===========================================
// Wire a dropdown: toggle on its button, dismiss on Esc or an outside click.
// Uses composedPath() (the path captured at dispatch) rather than
// host.contains(e.target): a click inside that navigates re-renders the panel
// synchronously in initNav's handler (which runs first), detaching e.target, so
// host.contains would read an in-menu click as "outside" and wrongly close it.
// `onOpen` (optional) runs each time the panel opens.
function wireDropdown(host, dd, btn, onOpen) {
  function close() { dd.classList.remove('open'); }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (dd.classList.contains('open')) { close(); }
    else { dd.classList.add('open'); if (onOpen) onOpen(); }
  });
  document.addEventListener('click', function (e) {
    if (dd.classList.contains('open') && e.composedPath().indexOf(host) === -1) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
}

// The Filters menu: a funnel icon at the navbar's far right (the static
// `.filter-menu` span). Its dropdown's `.menu-filters` is (re)built by
// renderMenuFilters on every render; the funnel is highlighted while any filter
// is active (see renderMenuFilters). A panel — changing a filter keeps it open.
var FUNNEL_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
  '<path fill="currentColor" d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6' +
  's3.72-4.8 5.74-7.39c.51-.66.04-1.61-.79-1.61H5.04c-.83 0-1.3.95-.79 1.61z"/></svg>';
function initFilterMenu() {
  var host = document.querySelector('.filter-menu');
  if (!host) return;

  var btn = document.createElement('button');
  btn.className = 'filter-btn';
  btn.type = 'button';
  btn.title = 'Filters';
  btn.setAttribute('aria-label', 'Filters');
  btn.innerHTML = FUNNEL_SVG;

  var dd = document.createElement('div');
  dd.className = 'menu-dropdown';
  var filtersHost = document.createElement('div');
  filtersHost.className = 'menu-filters';
  dd.appendChild(filtersHost);

  host.append(btn, dd);
  wireDropdown(host, dd, btn);
}

// The Bookmarks menu: a hamburger (☰) at the navbar's far left (the static
// `.menu` span, so it survives re-renders). Lists saved bookmarks and lets you
// snapshot the current view as a new one. Bookmark links are plain /photos hrefs
// (initNav navigates); the menu stays open (a panel) so you can keep browsing.
function initMenu() {
  var host = document.querySelector('.menu');
  if (!host) return;

  var btn = document.createElement('button');
  btn.className = 'menu-btn';
  btn.type = 'button';
  btn.title = 'Bookmarks';
  btn.setAttribute('aria-label', 'Bookmarks');
  btn.textContent = '☰';

  var dd = document.createElement('div');
  dd.className = 'menu-dropdown';

  var bmTitle = document.createElement('div');
  bmTitle.className = 'menu-title';
  var bmTitleText = document.createElement('span');
  bmTitleText.textContent = 'Bookmarks';
  var addBtn = document.createElement('button');
  addBtn.className = 'menu-add';
  addBtn.type = 'button';
  addBtn.title = 'New bookmark';
  addBtn.setAttribute('aria-label', 'New bookmark');
  addBtn.textContent = '+';
  addBtn.addEventListener('click', function (e) { e.stopPropagation(); createBookmark(); });
  bmTitle.append(bmTitleText, addBtn);

  var bookmarksHost = document.createElement('div');
  bookmarksHost.className = 'menu-bookmarks';

  dd.append(bmTitle, bookmarksHost);
  host.append(btn, dd);

  var bookmarks = [];
  wireDropdown(host, dd, btn, load);

  function load() {
    fetch('/api/bookmarks')
      .then(function (r) { return r.json(); })
      .then(function (list) { bookmarks = Array.isArray(list) ? list : []; build(); })
      .catch(function () { bookmarks = []; build(); });
  }

  function build() {
    var frag = document.createDocumentFragment();

    bookmarks.forEach(function (bm) {
      var row = document.createElement('div');
      row.className = 'menu-item';

      var link = document.createElement('a');
      link.className = 'bm-link';
      link.textContent = bm.name;
      var segs = bm.album.split('/').filter(Boolean);
      link.href = photosUrl(segs, {
        minRating: bm.min_rating,
        includeImages: bm.include_images,
        includeVideo: bm.include_video,
        recursive: bm.recursive,
        aspect: bm.aspect,
        tags: bm.tags || []
      });
      // Navigation is handled by initNav's delegated handler; the menu stays open
      // (a panel, like the filters) so you can keep browsing bookmarks.
      row.appendChild(link);

      var del = document.createElement('button');
      del.className = 'bm-del';
      del.type = 'button';
      del.title = 'Delete bookmark';
      del.setAttribute('aria-label', 'Delete bookmark');
      del.textContent = '✕';
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        deleteBookmark(bm.name);
      });
      row.appendChild(del);

      frag.appendChild(row);
    });

    bookmarksHost.replaceChildren(frag);
  }

  function createBookmark() {
    var name = prompt('Bookmark name:');
    if (name === null) return;
    name = name.trim();
    if (!name) return;

    var overwrite = bookmarks.some(function (b) { return b.name.toLowerCase() === name.toLowerCase(); });
    if (overwrite && !confirm('A bookmark named "' + name + '" already exists. Overwrite?')) return;

    var body = {
      name: name,
      album: state.album.length ? '/' + state.album.join('/') : '',
      recursive: state.recursive,
      min_rating: state.minRating,
      include_images: state.includeImages,
      include_video: state.includeVideo,
      aspect: state.aspect,
      tags: state.tags,
      overwrite: overwrite
    };
    fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) { alert('Could not save bookmark.'); return; }
      load();
    }).catch(function () { alert('Could not save bookmark.'); });
  }

  function deleteBookmark(name) {
    if (!confirm('Delete bookmark "' + name + '"?')) return;
    fetch('/api/bookmarks/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function () { load(); })
      .catch(function () {});
  }
}

