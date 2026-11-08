// ===== Photo metadata cache ==================================================
// The PhotoDetail fields not in the PhotoSummary (creation_date, tags as absolute
// paths, lat/long, …) come from /api/photos/:id — fetched lazily (by the info
// panel, and by the tags picker for the items it edits) and cached per id for
// the session. Only successes are cached: a failed fetch (network error,
// non-2xx) rejects, and the next caller retries — caching a fallback would show
// the photo as untagged until a reload. A request already in flight for the id
// is shared rather than repeated. Whoever changes a photo keeps its entry in
// sync (or deletes it, to be refetched).
var metaCache = {};
var metaPending = {};
function loadMeta(id) {
  if (metaCache[id] !== undefined) return Promise.resolve(metaCache[id]);
  if (metaPending[id]) return metaPending[id];
  var req = fetch('/api/photos/' + id)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (m) { metaCache[id] = m; return m; });
  metaPending[id] = req;
  function settle() { delete metaPending[id]; }
  req.then(settle, settle);
  return req;
}
