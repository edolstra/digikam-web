// The /photos page is a client-side SPA. The server ships a static shell (an
// empty navbar + #subalbums/#photos containers + the lightbox); this script reads
// the album + filters from the URL into `state`, fetches /api/subalbums and
// /api/photos, and renders the navbar, sub-album tiles, and photo grid. Navigating
// to another album or changing the rating filter re-renders in place (no page
// load) and updates the URL via history.pushState, so bookmarking / Back / Forward
// all work. A single persistent runtime — the thumbnail worker pool, the lightbox
// listeners, and the nav/popstate handlers — is created once and reused across
// every in-page navigation; only the DOM is rebuilt.

// ===== State + URL ===========================================================
// The filter fields at their defaults (everything off / all media). The single
// source of truth for the initial `state`, the "clear all" reset (the ↺ button,
// see renderMenuFilters), and filtersActive()'s "is anything non-default?" check.
var DEFAULT_FILTERS = { minRating: 0, includeImages: true, includeVideo: true, recursive: false, aspect: 'all', tags: [], sort: 'modified' };
// The current view, initialized from the URL by readUrl() and updated on each
// navigation. `album` is the decoded display segments (e.g. ["Photos","Lego"];
// [] is the virtual root); `minRating` is 0 (no filter) or 1..=5; the media-type
// filter is two booleans, both true by default (include images / include video);
// `recursive` extends the grid to all sub-albums' items; `aspect` is the
// aspect-ratio filter ('all' | 'portrait' | 'landscape').
var state = Object.assign({ album: [] }, DEFAULT_FILTERS);
// Bumped on every render(); a fetch that resolves after a newer navigation
// compares against it and bails before touching the DOM (see render/buildGrid).
var renderToken = 0;

// The one place that reads `location`. Mirrors query::album_segments (split on
// '/', drop empties), clamps min_rating to 0..=5, and reads the media-type filter
// (a param present and equal to 'false' excludes that type).
function readUrl() {
  var path = location.pathname.replace(/^\/photos/, '');
  state.album = path.split('/').filter(Boolean).map(decodeURIComponent);
  var q = new URLSearchParams(location.search);
  var r = parseInt(q.get('min_rating'), 10);
  state.minRating = (r >= 1 && r <= 5) ? r : 0;
  state.includeImages = q.get('images') !== 'false';
  state.includeVideo = q.get('video') !== 'false';
  state.recursive = q.get('recursive') === 'true';
  var a = q.get('aspect');
  state.aspect = (a === 'portrait' || a === 'landscape') ? a : 'all';
  state.tags = (q.get('tags') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var s = q.get('sort');
  state.sort = (s === 'created' || s === 'name') ? s : 'modified';
}

// The current filters as a plain object, optionally with some keys overridden —
// so a link can target "the current view but with X changed".
function filters(over) {
  var f = {
    minRating: state.minRating,
    includeImages: state.includeImages,
    includeVideo: state.includeVideo,
    recursive: state.recursive,
    aspect: state.aspect,
    tags: state.tags,
    sort: state.sort
  };
  if (over) for (var k in over) f[k] = over[k];
  return f;
}

// Encode a filter object onto a URLSearchParams, each at its non-default value.
// The single source of truth for filter -> query, shared by the nav links
// (photosUrl) and the API fetches (apiParams) so the two can't drift.
function setFilterParams(qs, f) {
  if (f.minRating) qs.set('min_rating', f.minRating);
  if (!f.includeImages) qs.set('images', 'false');
  if (!f.includeVideo) qs.set('video', 'false');
  if (f.recursive) qs.set('recursive', 'true');
  if (f.aspect && f.aspect !== 'all') qs.set('aspect', f.aspect);
  if (f.tags && f.tags.length) qs.set('tags', f.tags.join(','));
  if (f.sort && f.sort !== 'modified') qs.set('sort', f.sort);
}

// Build a frontend URL from album segments + a filter object, percent-encoding
// each segment and encoding each filter at its non-default value. The single
// source of truth for every nav link.
function photosUrl(segments, f) {
  var p = segments.map(encodeURIComponent);
  var qs = new URLSearchParams();
  setFilterParams(qs, f);
  var q = qs.toString();
  return '/photos' + (p.length ? '/' + p.join('/') : '') + (q ? '?' + q : '');
}

// The frontend URL for a sub-album's display path (e.g. "/Photos/Lego"), carrying
// the current filters.
function albumHref(displayPath) {
  return photosUrl(displayPath.split('/').filter(Boolean), filters());
}

// The target href for rating star K: set the threshold to K, or clear it when K
// is already the active threshold (toggle off). Keeps the media filter.
function ratingHref(k) {
  return photosUrl(state.album, filters({ minRating: state.minRating === k ? 0 : k }));
}

// Build a segmented control (horizontal radio) into `host`: each option is
// either the active, inert <span class="on"> or an <a> link to its target.
// Shared by the media / aspect / recursive filters. opts: [{label, title?,
// active, href}].
function segmented(host, opts) {
  var frag = document.createDocumentFragment();
  opts.forEach(function (o) {
    var el;
    if (o.active) {
      el = document.createElement('span');
      el.className = 'on';
    } else {
      el = document.createElement('a');
      el.href = o.href;
    }
    el.textContent = o.label;
    if (o.title) el.title = o.title;
    frag.appendChild(el);
  });
  host.replaceChildren(frag);
}

// The media-type filter as a 3-state horizontal radio (segmented control):
// "📷 🎥" (all media), "📷" (images only), "🎥" (videos only). The option matching
// the current {includeImages, includeVideo} pair is the active one (an inert
// <span>); the other two are links that switch to that pair. (The underlying
// filter stays two booleans — this only changes how they're presented.)
var MEDIA_OPTIONS = [
  { label: '📷 🎥', images: true, video: true, title: 'All media' },
  { label: '📷', images: true, video: false, title: 'Images only' },
  { label: '🎥', images: false, video: true, title: 'Videos only' }
];
function renderMedia(host) {
  segmented(host, MEDIA_OPTIONS.map(function (o) {
    return {
      label: o.label,
      title: o.title,
      active: state.includeImages === o.images && state.includeVideo === o.video,
      href: photosUrl(state.album, filters({ includeImages: o.images, includeVideo: o.video }))
    };
  }));
}

// The aspect-ratio filter as a 3-state radio (segmented control), same style as
// the media one: "▯ ▭" (all), "▯" (portrait), "▭" (landscape). The option whose
// value matches state.aspect is the active inert <span>; the others are links.
var ASPECT_OPTIONS = [
  { label: '▯ ▭', value: 'all', title: 'All aspect ratios' },
  { label: '▯', value: 'portrait', title: 'Portrait (height ≥ width)' },
  { label: '▭', value: 'landscape', title: 'Landscape (width ≥ height)' }
];
function renderAspect(host) {
  segmented(host, ASPECT_OPTIONS.map(function (o) {
    return {
      label: o.label,
      title: o.title,
      active: state.aspect === o.value,
      href: photosUrl(state.album, filters({ aspect: o.value }))
    };
  }));
}

// The sort order as a 3-state radio (segmented control), same style as the media
// / aspect ones: Modified (default) / Created / Name. The option matching
// state.sort is the active inert <span>; the others are links. `name` also
// switches the grid to a flat (ungrouped) A–Z list (see buildGrid).
var SORT_OPTIONS = [
  { label: 'Modified', value: 'modified', title: 'Sort by modification date (newest first)' },
  { label: 'Created', value: 'created', title: 'Sort by creation date (newest first)' },
  { label: 'Name', value: 'name', title: 'Sort by file name (A–Z)' }
];
function renderSort(host) {
  segmented(host, SORT_OPTIONS.map(function (o) {
    return {
      label: o.label,
      title: o.title,
      active: state.sort === o.value,
      href: photosUrl(state.album, filters({ sort: o.value }))
    };
  }));
}

function filtersActive() {
  return state.minRating || !state.includeImages || !state.includeVideo || state.recursive
    || state.aspect !== 'all' || state.tags.length || state.sort !== 'modified';
}

// The shared query for both API fetches: the album display path (empty for the
// root) plus the active filters.
function apiParams() {
  var p = new URLSearchParams();
  p.set('album', state.album.length ? '/' + state.album.join('/') : '');
  // `state` carries the same field names as a filter object. `recursive` is
  // sent to /api/photos (extends the grid to all sub-albums); /api/subalbums
  // ignores it (its counts are already recursive).
  setFilterParams(p, state);
  return p;
}

