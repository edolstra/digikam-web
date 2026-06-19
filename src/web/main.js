// ===== Render orchestrator ===================================================
// Re-derive the whole page from `state`: rebuild the navbar synchronously, then
// refetch + rebuild the sub-album tiles and photo grid, and finally re-point the
// thumbnail pipeline and lightbox at the new tiles. Called on initial load, on
// nav clicks, and on Back/Forward.
function render() {
  renderNavbar();
  renderMenuFilters();
  var token = ++renderToken;
  var subsHost = document.getElementById('subalbums');
  var photosHost = document.getElementById('photos');
  return Promise.all([
    buildSubalbums(subsHost, token),
    buildGrid(photosHost, token)
  ]).then(function () {
    if (token !== renderToken) return; // superseded by a newer navigation
    ensureDecoder();
    observeTiles(collectThumbs());
    LB.refresh();
    restoreSelection();
  });
}

// ===== Navigation controller =================================================
// In-page navigation: update the URL, re-read state, scroll to top, re-render.
function navigateTo(target) {
  history.pushState({}, '', target);
  readUrl();
  window.scrollTo(0, 0);
  render();
}

function initNav() {
  // Intercept internal nav links (breadcrumb / rating / sub-album tiles — all
  // /photos hrefs). Grid tiles are <img>/<button>, not <a>, so they fall through
  // to the lightbox. Modified / non-primary clicks fall through to the browser
  // (open-in-new-tab etc.).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var url;
    try { url = new URL(a.href, location.origin); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname !== '/photos' && url.pathname.indexOf('/photos/') !== 0) return;
    e.preventDefault();
    navigateTo(url.pathname + url.search);
  });

  // Back/Forward. While the lightbox is open, the popped entry is its (URL-less)
  // history entry, so just dismiss it — the album URL is unchanged, no re-render.
  // Otherwise the URL changed to another album: re-read state and re-render.
  window.addEventListener('popstate', function () {
    if (LB && LB.isOpen()) { LB.dismiss(); return; }
    readUrl();
    window.scrollTo(0, 0);
    render();
  });

  // Alt+Up navigates to the parent album (in-page). A no-op at the root and while
  // the lightbox is open.
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.key === 'ArrowUp' && !(LB && LB.isOpen()) && state.album.length) {
      e.preventDefault();
      navigateTo(photosUrl(state.album.slice(0, -1), filters()));
    }
  });
}

// ===== Bootstrap =============================================================
(function () {
  // We rebuild the grid asynchronously on Back/Forward, so the browser's own
  // scroll restoration would race our refetch — manage scroll ourselves.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  readUrl();
  initLightbox();
  initNav();
  initMenu();
  initFilterMenu();
  initGridNav();
  render();
})();

// Register the service worker (makes the app installable as a PWA). Deferred to
// `load` so it doesn't compete with the initial thumbnail fetches. Needs a secure
// context — HTTPS, or localhost during development.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
