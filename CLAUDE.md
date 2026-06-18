# digikam-web

A **read-only** web backend (Rust) that serves the photos in a [Digikam](https://www.digikam.org/)
SQLite database over an HTTP/JSON API. A web frontend will be added later.

## Build & run

Everything goes through Nix (flakes). nixpkgs is pinned to **26.05**; the build
uses [crane](https://github.com/ipetkov/crane) + [rust-overlay](https://github.com/oxalica/rust-overlay).

```bash
nix run                              # build + run with defaults
nix develop --command cargo run      # iterate inside the dev shell
nix develop --command cargo test     # unit tests
nix build                            # produce ./result/bin/digikam-web
nix flake check                      # build + clippy (-D warnings)
```

> **Always run `cargo fmt` and `cargo clippy` before committing** (e.g.
> `nix develop --command cargo fmt` and `nix develop --command cargo clippy --all-targets`).
> Keep both clean — `nix flake check` treats clippy warnings as errors (`-D warnings`).

Config (CLI flags or env vars):
- `--database` / `DIGIKAM_DB` — path to `digikam4.db` (default `~/.local/share/digikam/db/digikam4.db`).
- `--listen` / `LISTEN_ADDR` — bind address (default `127.0.0.1:8080`). Plain HTTP/1.1
  (`axum::serve`); terminate TLS in a reverse proxy (e.g. nginx) in front of it.
- `--thumbnail-database` / `THUMBNAIL_DB` — path to `thumbnails-digikam.db` (default:
  alongside `--database`). Optional; if missing, `/thumbnail` returns `404`.
- `--trace-sql` / `TRACE_SQL` — log every executed SQL statement (with bound values
  inlined) at `info` under the `digikam_web::sql` target. Off by default.
- `--web-database` / `WEB_DB` — path to the **writable** bookmarks DB (`web.sql`, default:
  alongside `--database`; created if missing). This is the *only* DB we write to.

> Nix flakes only see git-tracked files. After adding/renaming a file, `git add` it
> before `nix build`/`nix develop`, or Nix won't find it (and crane needs `Cargo.lock` tracked).

## API

All endpoints are served under the `/api` prefix.

| Route | Notes |
|-------|-------|
| `GET /api/photos?album=&tags=&recursive=&min_rating=&images=&video=&aspect=&limit=&offset=` | Filtered, paginated list. `Page<PhotoSummary>` = `{incomplete, limit, offset, items}` (`incomplete` = more rows exist beyond this page — one extra row is fetched to detect it). `PhotoSummary.is_video` is true for videos (Digikam `category=2`). `images`/`video` are the media-type filter (both default `true`; `=false` excludes that type). `aspect` is `all` (default) / `portrait` (`height>=width`) / `landscape` (`width>=height`); squares match both. An empty/absent `album` (non-recursive) returns `items: []`. |
| `GET /api/photos/:id` | `PhotoDetail` = the `PhotoSummary` fields plus `file_path`, `creation_date`, `description`, `latitude`/`longitude`, and `tags`. `file_path` is the **absolute path of the original on the server** (album-root base + `relativePath` + name; `null` if the root is unknown) — the info panel's copy-path button copies it. `creation_date` is `ImageInformation.creationDate` (Digikam's import/EXIF time — distinct from the `modificationDate` the app sorts/groups by); `description` is the image's `ImageComments` (caption/title/headline/imported EXIF-JFIF comments) concatenated with newlines (ordered by `type, language, id` via a `group_concat` subselect in the one query; `null` when none); `latitude`/`longitude` are `ImagePositions.latitudeNumber`/`longitudeNumber` (null when absent). `tags` are **absolute paths** (`/local/blender/todo`, built by walking the `pid` chain), sorted `COLLATE NOCASE`, with Digikam's internal tags (the `_Digikam_Internal_Tags_` subtree — Color/Pick labels, version history) excluded. The lightbox info panel fetches this lazily (only while open) and caches it per id. |
| `GET /api/photos/:id/file` | Original bytes, range-aware (via `tower_http::services::ServeFile`). Sends a strong `ETag` from the image's `uniqueHash`; a matching `If-None-Match` (or `*`) returns `304`. `Content-Disposition: inline` carries the original filename (+ RFC 5987 `filename*`) so saving from the browser keeps the real name. |
| `GET /api/photos/:id/reverse-search?engine=yandex` | Reverse-image-search the original on Yandex; **302-redirects** to the results page. The **server** does the upload (not the browser): the image URLs may not be world-readable, so a `?url=` search Yandex would have to fetch back is unreliable (must send the **bytes**), and Yandex sends no CORS headers + returns only a transitional "candidate" page, so the browser can't read the CBIR id. The handler POSTs the file as multipart `upfile` to Yandex's JSON endpoint (`reqwest`, rustls), reads `blocks[0].params.cbirId`, and redirects to `…/search?rpt=imageview&cbir_id=…&cbir_page=similar`. The only outbound network call this app makes. `engine` defaults to `yandex` (only value supported → else `400`); unknown id `404`; Yandex failure `502`. |
| `GET /api/photos/:id/thumbnail` | Digikam's stored thumbnail as-is: the **raw PGF blob** from `thumbnails-digikam.db` (looked up by `uniqueHash`+`fileSize`), for the client to decode in wasm (see [nix/webpgf.nix](nix/webpgf.nix)). Strong `ETag` (+ `If-None-Match`→`304`) and a 1-year `immutable` `Cache-Control`; `X-Orientation` header carries Digikam's `orientationHint` (EXIF orientation) for client-side rotation. `404` when the thumbnails DB is absent / the image has no cached thumbnail → client falls back to `/file`. |
| `GET /api/albums` | Flat list of all albums (`{id, path, root}`). |
| `GET /api/subalbums?album=/Root/rel&min_rating=&images=&video=&aspect=&tags=` | Direct sub-albums of an album as `[{name, path, photo_count, cover: {id, name} \| null}]`, sorted by most recent photo (newest first). An absent/empty `album` lists the album roots. Cover = newest item (image **or** video — videos have stored thumbnails the client renders) in the sub-album's whole subtree; `Cover.is_video` flags a video cover (the client then omits its `data-full`). `photo_count` is the recursive count incl. videos. `min_rating` (0..=5), the `images`/`video` media-type filter, the `aspect` filter, and `tags` (same hierarchical semantics as `/photos`) constrain the cover, count, and which sub-albums appear alike. One query; albums with no matching photos anywhere are omitted. |
| `GET /api/tags` | Tag **tree** (`{id, name, children}`), internal tags excluded. |
| `GET /api/bookmarks` | Saved bookmarks `[{name, album, recursive, min_rating, include_images, include_video, aspect, tags}]`, sorted by name (`COLLATE NOCASE`). `[]` if the bookmarks DB is unavailable. Each bookmark is a named album + filter snapshot (the filter fields are the flattened [`Filters`](src/models.rs), which now includes `recursive`). |
| `POST /api/bookmarks` | Create a bookmark from the same JSON shape (+ optional `overwrite`). Empty/over-long name → `400`; bad `min_rating`/`aspect` → `422` (typed body validation); duplicate name without `overwrite` → `409`; `overwrite:true` does `INSERT OR REPLACE`. |
| `DELETE /api/bookmarks/:name` | Remove a bookmark (idempotent → `204`). |
| `GET /api/health` | Liveness. |

### Query semantics
- **`album=/Root/rel`** — the first path segment is the `AlbumRoots.label`; the
  remainder is a `relativePath`. By default it matches **only that album**
  (photos directly in it). `/Photos` alone means the root album (`relativePath = "/"`).
  An **absent/empty `album`** (the virtual root) has no photos of its own, so
  `/api/photos` returns an **empty** list — unless `recursive=true` (below).
- **`recursive`** — a boolean: `?recursive=true` also includes all sub-albums;
  `?recursive=false` or absence keeps the default non-recursive behavior. With
  `?recursive=true`, `/Photos` selects the whole collection — and an empty `album`
  with `recursive=true` selects **all** photos (every root).
- **`tags=a,b`** — comma-separated tokens, **AND'd** (a photo must match every token;
  an unmatched token yields an empty result). Each token matches a tag **and all its
  subtags** — **no substring match** (`foo` ≠ `foobar`). A token starting with `/` is an
  **absolute path** (`/local/fashion` ⇒ that node + its subtree), matched **case-sensitively**,
  tag-only. Any other token is a **name**, matched **case-insensitively**, and matches either
  (OR): **(a)** any tag with that name at any level (+ subtree), **or (b)** photos in an
  **album named that token (or a sub-album thereof)** — any `/`-delimited segment of the
  album's `relativePath` equals the token (so `fashion` ⇒ the `/local/fashion` tag tree **and**
  a `…/Fashion/…` album tree). Resolution = `resolve_tag_filter` in [src/query.rs](src/query.rs)
  (recursive `pid`-path CTE for `/`-tokens, `tag_ids_subquery` + `TagsTree` for the descendant
  closure, an album-segment `LIKE` for name tokens); per token it emits one `EXISTS`/`OR`
  predicate plus its **bound `?` parameters** (the token value + LIKE pattern), returned
  alongside the SQL like `build_filter` and spliced into the single main query (no per-token
  round-trips). Also a saved [`Filters`] field, so it applies to `/subalbums` and persists in
  bookmarks.
- **`min_rating=N`** — minimum rating, `0..=5` (else `400`). Unrated images
  (Digikam stores `-1`) count as `0`, so `min_rating=0` includes everything and
  `min_rating>=1` excludes the unrated. Implemented as `max(ifnull(ii.rating,0),0) >= N`.
- **`images=` / `video=`** — the media-type filter, two independent booleans, **both
  default `true`** (`=false` excludes that type; stock bool parsing, so the value is
  `true`/`false`). `video=false` → only images (`category != 2`); `images=false` → only
  videos (`category = 2`); both false → empty. Like `min_rating`, it constrains the photo
  grid and the sub-album count/cover/visibility alike.
- **`aspect=`** — aspect-ratio filter, an enum (so it can grow to exact ratios like `16:9`):
  `all` (default, no constraint) / `portrait` (`ii.height >= ii.width`) / `landscape`
  (`ii.width >= ii.height`); a **square** matches both (inclusive `>=`), an invalid value is a
  `400`. Items with NULL dimensions are excluded from `portrait`/`landscape` (the comparison is
  NULL) but kept under `all`. Constrains the grid and the sub-album count/cover/visibility alike.
- **Ordering / dates** — newest first by **`Images.modificationDate`** (`ORDER BY
  i.modificationDate DESC, i.id DESC`); the same column drives the day-grouping and the
  sub-album cover/sort. We deliberately use the file modification date, **not**
  `ImageInformation.creationDate` (which is Digikam's import time, rarely what you want).
- **Paging** — `limit` defaults to 25000, capped at 100000; `offset` defaults to 0.

## Frontend (HTML)

The `/photos` page is a **client-side SPA**. [src/web.rs](src/web.rs) serves a single
**static shell** — byte-identical for every URL — rendered by `render` with no DB or
album/filter logic: an empty navbar (`<span class="menu">` for the `☰` bookmarks menu,
`<span class="crumb">` for the breadcrumb, `<span class="filter-menu">` for the funnel
filters menu) plus empty `#subalbums` / `#photos` containers, the lightbox, and the
inlined CSS/JS.
[web.js](src/web.js) drives everything from in-memory **state** (`{album: segments[],
minRating}`), initialized from the URL by `readUrl()` and updated on each navigation. It
builds the navbar, sub-album tiles, and photo grid by fetching `/api/subalbums` +
`/api/photos`, and **navigates in place**: clicking a breadcrumb / sub-album tile / `⌂` /
`★` re-fetches and rebuilds the DOM (no page load) and updates the URL via
`history.pushState`, so bookmarking + Back/Forward work. (Planned to grow into Leptos later.)

| Route | Notes |
|-------|-------|
| `GET /photos`, `GET /photos/<album path>`, `GET /` | All serve the same static SPA shell. The client reads the album from the path (`/photos/Photos/Lego` → `["Photos","Lego"]`; `/photos` = the virtual root) and filters from the query string, then renders the navbar + sub-album tiles + (for a real album) the day-grouped photo grid. See [The album page](#the-album-page). |

The shell is sent with `Cache-Control: private, max-age=3600` on success: cached an hour
for navigations / back-forward, while a force-reload (Ctrl/Cmd+Shift+R) bypasses it. (Since
the shell is now identical for every URL, this caches the one document across all albums.)

### The album page

Everything below is built **client-side** by [web.js](src/web.js) from `state`; in-page
navigation re-renders without a page load. A single persistent runtime — the thumbnail
worker pool, the lightbox listeners, and the nav/popstate handlers — is created once and
reused across navigations; only the DOM is rebuilt (`render()` per navigation). A
`renderToken` guard drops a fetch that resolves after a newer navigation.

- **Navbar (sticky** — pinned to the top, the page scrolls underneath**)**: deliberately
  minimal (so it doesn't crowd on mobile) — the `☰` bookmarks button (far left), a
  client-built breadcrumb starting with a `⌂` home icon (→ the root) then
  `› Photos › Lego › Porsche911` (each segment a link to that ancestor album), and the
  funnel filters button (far right). **Alt+↑** navigates to the parent album.
- **Two dropdown menus**, each `wireDropdown`-wired and built once into its static shell span
  (so they survive in-place re-renders). Their controls are the same state-reflecting
  `/photos` links as the rest of the UI, so `initNav` does the navigation and **clicks leave
  the menu open** (a panel — tweak several filters, or jump between bookmarks, in a row).
  Each closes via its button, Esc, or an outside click (tested with `e.composedPath()`, not
  `contains(target)`, since a navigation re-render detaches the clicked control before the
  outside-click handler runs). Only one is effectively open at a time (opening/clicking one
  is an outside-click for the other).
  - **`☰` bookmarks menu** (far left, `.menu`, `initMenu`): a **Bookmarks** header with a `+`
    add (`+` prompts for a name, snapshots the current album + filters via `state`, `POST`s it;
    if the name exists it `confirm()`s and sends `overwrite`), then one row per bookmark — a
    name link (built with `photosUrl`) + a `✕` delete (`confirm` → `DELETE`). Sorted by name;
    `.menu-bookmarks` is (re)fetched from `/api/bookmarks` when opened / after a create/delete.
    (Bookmarks-only for now; other things may move in here later.)
  - **Funnel filters menu** (far right, `.filter-menu`, `initFilterMenu`): an inline-SVG funnel
    `.filter-btn` **highlighted gold when any filter is active** (`filtersActive()`, toggled by
    `renderMenuFilters` each render) — at-a-glance feedback that filtering is in effect. Its
    `.menu-filters` panel is rebuilt every render from `state`: a **Filters** header carrying
    the `↺` clear-all (links to the album with **every** filter reset; dimmed + inert when none
    active), then `Recursive` `[On|Off]` (extends the grid to all sub-albums' items,
    `?recursive=true`; sub-album tiles/counts are already recursive and `/api/subalbums` ignores
    it), `Stars` (five `★`; star K → `?min_rating=K`, clicking the active threshold clears it),
    `Media` (3-state segmented `📷🎥`/`📷`/`🎥` ⇄ `{includeImages, includeVideo}` ⇄
    `images=/video=false`), `Aspect ratio` (3-state segmented `▯▭`/`▯`/`▭` ⇄ `state.aspect` ⇄
    `aspect=portrait|landscape`), and `Tags` (a free-text comma-separated `<input>` ⇄
    `state.tags` (array) ⇄ `tags=a,b`; commits on Enter/blur, navigating when changed). The
    active segment is an inert highlighted `<span>`; the others are links.
- **Filters / state**: the album (path) + `min_rating` + media toggles + `aspect` + `recursive` + `tags` (query) are
  the SPA's state, read from the URL on load and written back on each navigation. Every client-built
  breadcrumb / sub-album / star / toggle link carries the current filters so they persist while
  browsing; they also constrain the sub-album tile covers/counts. The server-side `Filters`
  struct ([src/models.rs](src/models.rs)) is used by the JSON API handlers and embedded in
  saved bookmarks.
- **Sub-album grid** (below the breadcrumb): direct sub-albums (newest-first, from
  `/api/subalbums`); each tile is the cover image with the bold sub-album name and
  `(count)` centered on top, linking to that sub-album. Covers use the same lazy
  thumbnail pipeline as the grid (below).
- **Photo grid**: grouped by day (newest first), fixed-height tiles wrapping
  left-to-right. Image tiles are `<img class="thumb">` rendered **src-less** (the
  day's tiles reserve their width from the photo's aspect ratio so the layout
  doesn't reflow as they decode in); an `IntersectionObserver` then loads each
  `/api/photos/:id/thumbnail` (raw PGF), decodes it in a webpgf **wasm Web Worker**,
  and paints it — rotated per `X-Orientation` — via a canvas→blob URL. A `404` or any
  decode failure falls back to the full-size `/file` (`data-full`); that URL is also
  what the lightbox opens. Videos (`is_video`) are a `<button class="vtile">` with a ▶
  badge and an **inner poster** `<img class="thumb">` fed by the same pipeline (no
  `data-full`, so a missing thumbnail just leaves the ▶ placeholder; the video itself
  isn't fetched until opened). The lightbox enumerates only *direct* grid children
  (`.grid > img, .grid > .vtile`), so a poster isn't its own item. See [Thumbnails](#thumbnails).
- **Keyboard navigation** (`initGridNav` in [web.js](src/web.js)): the **arrow keys** move a
  highlighted selection (`.selected`, an inset gold outline) across **both** grids in one
  sequence — `.albums > a.album` then `.grid > img.thumb, .grid > .vtile`. Left/Right step in
  DOM (reading) order; Up/Down are *geometric* (nearest row above/below by tile center, then
  closest column — the grids wrap with a variable column count); **Home/End** jump to the
  first/last tile, and **PageUp/PageDown** move by about a viewport (row-by-row in the same
  column). **Enter** activates the
  selection via `selected.click()` (so it reuses the existing delegated handlers: open the
  lightbox for a photo/video, SPA-navigate into a sub-album). The selection is mirrored to the
  **URL fragment** — `#item-<photoid>` for photos, `#item-<encoded name>` for sub-albums (each
  tile carries that `id`) — via `replaceState` (no history spam), and `restoreSelection()`
  re-applies it after every render, so it survives reload / Back/Forward. Guards: inert while
  the lightbox is open or a modifier is held (so **Alt+↑** parent-nav still works). The
  **lightbox tracks the selection too**: every `show()` (arrows / Home/End / wheel / swipe /
  random / slideshow) calls `setSelected(tiles[i])`, and `dismiss()` writes that last-viewed
  item to the grid selection + fragment — so closing the lightbox lands on the item you were viewing.

### Lightbox

Click a photo/video to open it full-page over a dimmed grid, requesting **fullscreen**
(Fullscreen API; guarded/no-op where unsupported, e.g. iPhone Safari). The media is scaled to
fill the viewport (up or down, preserving aspect).

- **Videos**: auto-play, looping, with **native `controls`** (play/pause/seek/volume; mp4/webm
  only); Space toggles play/pause, `m` toggles mute. On **touch**, gestures take over from the
  native controls (which stay mouse-usable on desktop): tap a video to pause/play.
- **Navigation**: keyboard ←/→ (`preventDefault` stops a focused video from also seeking),
  Home/End → first/last, `r` → a random item, the on-screen ‹ › chevrons, the **mouse wheel**
  (down = next; throttled to one item per notch), and **touch** swipe left/right (anywhere, incl.
  over a video); swipe up → random. All navigation stops at the ends. `r` and the slideshow walk a
  **shuffled permutation** (a bag of indices popped one at a time, reshuffled only once exhausted,
  so every item is seen once before any repeat).
- **Zoom (images, 1×–4×)**: touch two-finger pinch (toward the pinch point), one-finger pan while
  zoomed, double-tap toggles 2×/fit; desktop **Ctrl+wheel** zooms toward the pointer, **+/-** toward
  the viewport center, **double-click** toggles 2×/fit at the click point, and **drag** pans (a drag
  that moved suppresses the trailing click so it doesn't close). All share one `zoomTo(s, fx, fy)`
  (keeps the focal point fixed) + `clampPan`; navigation is suppressed while zoomed (a plain wheel is
  inert) and zoom resets on navigate/close. The lightbox is `touch-action: none` so the browser
  doesn't fight the touch gestures; the image carries the `translate()+scale()` transform
  (origin `0 0`) and shows a `grab`/`grabbing` cursor while zoomed.
- **Controls & auto-hide**: the close/`‹ ›` controls (and the mouse cursor) **start hidden**
  (web.js `.idle` class), revealed by a **mouse/pen move or a tap** — *not* by keyboard navigation
  or swipes — then auto-hide again after 2s of inactivity; a tap that only reveals them is consumed
  so it doesn't also dismiss/navigate. **While the info panel is open the controls stay pinned**.
- **🔍 reverse-image-search** (top-left, just below the info button; **images only**, hidden for
  videos via the lightbox's `.is-video` class): opens `/api/photos/:id/reverse-search?engine=yandex`
  in a new tab after a `confirm()` (it uploads the image to a third party) — the server does the
  upload + 302.
- **ⓘ info panel** (the ⓘ button or the `i` key): a metadata overlay (`#lb-info`) — file name,
  album path (a **link** that jumps to that album), format, size, resolution, rating, modification
  date, MIME — built client-side from the tile's `PhotoSummary` (stashed as `_photo`, no extra
  fetch), updating as you navigate. A **⧉ copy-path button** next to the file name copies the
  absolute server path (`file_path`) to the clipboard (async Clipboard API, hidden-textarea
  fallback; ✓ flash). The **creation date**, **description** (the image's `ImageComments`, newlines
  preserved via CSS `white-space: pre-wrap`), **location** (GPS → a Google Maps link in a new tab,
  shown only when present), and **tags** (absolute paths, one per line, internal tags excluded) come
  from `GET /api/photos/:id` (`PhotoDetail`), fetched lazily only while the panel is open and cached
  per id. The album link and tag links `replaceState` the lightbox's URL-less history entry as the
  target view, close the lightbox, and re-render in place (so Back still returns to the originating
  album); the external maps link (`target=_blank`) opens normally. Each **tag** is a link that
  filters the current album by just that tag (replacing the current tag filter, keeping the others).
- **Slideshow** (`s` or the ▶/⏸ button, bottom-left): auto-advances to a **random** item — an image
  after **5s**, a video after it **plays in full** (its `loop` is turned off so `ended` fires; an
  unplayable one advances after 1.5s). Dismissing the lightbox stops it.
- **Dismiss**: click the letterbox / Esc / the X / the device Back button, or exit fullscreen.
  Opening pushes a history entry **carrying no URL** (so the album URL is preserved); the single
  shared `popstate` handler dismisses the lightbox when open (leaving the album in place) and
  otherwise treats the pop as album Back/Forward (re-render). On dismiss, the grid scrolls the
  last-viewed tile into view if browsing left it off-screen (`scrollIntoView({block:'nearest'})` with
  `scroll-margin-top` = the sticky navbar height, so it isn't tucked underneath).
- **Perf**: preloads the prev/next images, `decoding="async"`, and `touch-action: manipulation` to
  cut mobile tap latency.

### Installable PWA
The app is a Progressive Web App, so it can be "installed" (Android home screen,
desktop, etc.). Embedded + served like the other static assets:
`GET /manifest.webmanifest` (the manifest: `digiKam Browse`, `display: standalone`,
`start_url: /photos`, theme/background `#1a1a1a`/`#111`), `GET /icon-192.png` &
`GET /icon-512.png` (rasterized from digiKam's `digikam_oxygen.svg`), and
`GET /sw.js` (the service worker). The `<head>` carries `<link rel="manifest">`,
`<meta name="theme-color">`, and an `apple-touch-icon`; [web.js](src/web.js) registers the
service worker on `load`. The SW is **deliberately a no-op for fetches** (empty `fetch`
handler): a response served from a service worker **bypasses the browser's HTTP cache**,
which would defeat our `Cache-Control` headers (immutable assets, the `/photos` `max-age`),
so every request is left to the browser. It exists only to satisfy the PWA installability
requirement (and as the place to add real offline support later, if its caching is made to
respect those headers). The manifest and `sw.js` are served `no-cache` (revalidated via
content-hash `ETag`) so updates propagate; icons are `immutable`.

> **Installation needs a secure context.** Service workers only register over **HTTPS**
> (or `localhost`). Reaching the server from a phone over plain `http://<lan-ip>:8080`
> is **not** a secure context, so the SW won't register and the browser won't offer
> "Install". Put it behind TLS (an nginx reverse proxy / `tailscale serve` / a tunnel)
> for a trusted cert and a secure context.

## Architecture & design choices

- **Stack**: `axum` + `tokio`; `rusqlite` (feature `bundled`, so SQLite is compiled
  in — no system lib / pkg-config) behind an `r2d2` connection pool. rusqlite is
  blocking, so every DB call runs inside `tokio::task::spawn_blocking` (see
  `run_blocking` in [src/handlers.rs](src/handlers.rs)). The app is otherwise
  network-isolated except for **one outbound call**: the Yandex reverse-search upload
  (`reqwest` with `rustls-tls` + bundled webpki roots, so no system TLS/OpenSSL dep),
  used only by `/api/photos/:id/reverse-search`.
- **HTML rendering**: the page **shell** uses [`maud`](https://maud.lang.rs/)
  (compile-time `html!` templates with automatic escaping). `album_page` returns
  `maud::Markup` (its axum feature makes it `IntoResponse`). The shell is static — all
  album/filter rendering moved client-side ([web.js](src/web.js)), so maud now just emits
  the fixed navbar/container scaffolding. The `include_str!`'d `web.css`/`web.js` are
  emitted inside `<style>`/`<script>` via `PreEscaped` (trusted, must not be escaped).
- **Read-only & safe alongside running Digikam**: connections open with
  `SQLITE_OPEN_READ_ONLY`, set `PRAGMA query_only=ON`, and a 5s `busy_timeout` so
  reads don't fail while Digikam writes. We deliberately do **not** use `immutable=1`
  (Digikam may be modifying the file concurrently). See `build_pool` in [src/db.rs](src/db.rs).
- **One writable DB — `web.sql`** (bookmarks): the sole exception to read-only.
  `build_web_pool` in [src/db.rs](src/db.rs) opens *our own* `web.sql` with
  `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_CREATE` and **no** `query_only`, then runs a
  `CREATE TABLE IF NOT EXISTS bookmarks(...)` migration. It's optional (`AppState.web:
  Option<Pool>`, graceful like `thumbs`); the bookmark handlers run via a `run_web`
  helper. Never points at a Digikam DB.
- **Path resolution** ([src/db.rs](src/db.rs)): an image's absolute path is
  `AlbumRoots` base + `Albums.relativePath` + `/` + `Images.name`. The root base is
  parsed from the album-root identifier (percent-decoded), joined with `specificPath`:
  local volumes use `volumeid:?path=…&fileuuid=…`, network shares use
  `networkshareid:?mountpath=…&fileuuid=…` — we accept either `path=` or `mountpath=`
  (a root whose identifier has neither is skipped with a warning). The root album has
  `relativePath == "/"`.
- **Visibility filter**: only `Images.status = 1` (visible) is returned; 3 (trashed)
  and 4 (obsolete) are excluded.
- **Ratings/dimensions**: `rating`, `width`, `height`, `file_size`, `id` are `u64`.
  Digikam stores `-1` for "unrated"; that (and any negative) maps to JSON `null`.
- **Tags tree** ([src/handlers.rs](src/handlers.rs)): built in memory from
  `Tags(id, pid, name)`; top-level nodes have `pid = 0`. The internal
  `_Digikam_Internal_Tags_` subtree (id `1`, which holds Color/Pick-label tags) is
  excluded from `/tags`.
- **Request logging**: a `tower_http` `TraceLayer` logs every HTTP request
  (method + URI) and its response (status + latency) at `info`. `--trace-sql`
  additionally logs the SQL each request runs.
- **No CORS layer**: the frontend is served same-origin by this server, so CORS is
  unneeded. It was removed because `CorsLayer::permissive()` emits
  `Vary: origin, …`, which made the browser refuse to reuse the cached (immutable)
  thumbnails and webpgf assets — it re-`GET`s them every page load. (Re-add a
  scoped CORS layer only if a *separate-origin* frontend ever consumes `/api`.)

### Relevant Digikam schema
- `AlbumRoots(id, label, identifier, specificPath)` — collection roots.
- `Albums(id, albumRoot, relativePath)` — directories; unique `(albumRoot, relativePath)`.
- `Images(id, album, name, status, fileSize, uniqueHash, modificationDate)` — we order
  and day-group by `modificationDate`.
- `ImageInformation(imageid, rating, creationDate, width, height, format, …)` —
  `creationDate` is the import time; unused for ordering (see above).
- `Tags(id, pid, name)`; `TagsTree(id, pid)` is the ancestor transitive closure
  (`SELECT id FROM TagsTree WHERE pid = T` gives descendants of `T` — currently unused
  because tag matching is exact).
- `ImageTags(imageid, tagid)`, `ImagePositions(imageid, latitudeNumber, longitudeNumber)`.

### Thumbnails
Digikam's `thumbnails-digikam.db` blobs are **PGF** (a wavelet format browsers can't
decode natively) and its `FilePaths` are stale (`/mm/Images/…` vs the real
`/home/eelco/Images/…`) — so we key on `uniqueHash`+`fileSize`, not paths. Approach:
`/api/photos/:id/thumbnail` streams the raw PGF blob untouched; the **client decodes it
in wasm** via [`webpgf`](https://github.com/haplo/webpgf) (built by [nix/webpgf.nix](nix/webpgf.nix),
`nix build .#webpgf`). webpgf already maps libpgf's BGRA → RGBA and yields an `ImageData`;
it does **not** apply orientation, so the client must rotate per the `X-Orientation`
header. Thumbnails are ≤256 px, ~19 KB avg, with near-full coverage.

The webpgf module is **embedded into the binary** (`include_bytes!`, like the CSS/JS) and
served at `GET /webpgf.js` (`text/javascript`) and `GET /webpgf.wasm` (`application/wasm`,
so the browser can stream-compile). Both carry a content-addressed `ETag` (the webpgf nix
store hash) honoring `If-None-Match`→`304`, plus a 1-year `immutable` `Cache-Control`
(`public, max-age=31536000, immutable`, shared with the thumbnails — `IMMUTABLE_CACHE_CONTROL`)
so the browser stops re-requesting them every page load.
The embed path comes from the `WEBPGF_PATH` env var, which the flake sets to the `webpgf`
derivation output for **both** `nix build` (`commonArgs`) and the dev shell — so plain
`cargo build` inside `nix develop` embeds them too.

The frontend ([web.js](src/web.js)) wires this up. An `IntersectionObserver` with a wide,
viewport-relative `rootMargin` (≈1 screen above, ≈2.5 below) triggers a `/thumbnail` fetch
per `img.thumb` tile **well before** it scrolls in, so paging down lands on already-decoded
images. Fetch (network) and decode (CPU) are **separate stages**: each finished PGF blob
queues for the next idle worker in a small **Blob Web Worker pool** (`min(hardwareConcurrency, 6)`).

First-paint latency was dominated by **Firefox network behavior** (full write-up in
[docs/thumbnail-loading-performance.md](docs/thumbnail-loading-performance.md)), fixed three
ways (see [web.js](src/web.js) — verified to take first paint from ~500ms to ~120ms):

1. **Cap concurrent fetches** at 6 — firing a screenful at once makes Firefox's request pacer
   hold the *whole burst* for hundreds of ms.
2. **`priority: 'high'`** on every fetch — Firefox otherwise deprioritises `fetch()` for ~150ms
   during page load.
3. **Kick off the first ~24 tiles synchronously** at script start rather than from the observer
   callback — requests issued during initial parse are dispatched promptly, later ones are held
   (the observer handles the rest, skipping the eager ones).

To make the *first* paint snappy, the decoder assets are fetched **once** (not once per worker):
`/webpgf.js` is inlined into the worker body and `/webpgf.wasm` is fetched once, then the pool is
**pre-warmed** — each worker instantiates the module at page load (via an init message carrying the
shared wasm bytes), overlapping with the thumbnail fetches, so blobs decode the instant they arrive
rather than waiting on a cold module. Each worker returns an `ImageData` whose buffer is transferred
back. The main thread draws each result — applying the EXIF `X-Orientation` (2..8; 0/1/junk = no
rotation) — to a canvas, then sets the `<img>` to the canvas's blob URL. The worker URLs are made
**absolute** (`location.origin` baked in) because a `blob:` worker resolves relative paths against
its opaque blob base, not the page origin. A worker that dies (e.g. webpgf failed to load) falls
back its tile to `/file`; once the whole pool is gone, queued/new tiles do too.

### Deliberately out of scope (this milestone)
- Auth, any write operations, and search by date/rating/geo.

## Source layout

```
src/
  main.rs      router, startup, graceful shutdown
  config.rs    clap config (database path, listen addr)
  db.rs        read-only pools + writable web.sql pool, album-root loading, path resolution  (+ unit tests)
  models.rs    serde types (PhotoSummary, PhotoDetail, AlbumNode, SubAlbum, TagNode, Page<T>, Filters, Bookmark)
  query.rs     /photos + /subalbums SQL + param building; Rating/Aspect types (+ unit tests)
  handlers.rs  axum JSON API handlers (incl. bookmarks), run_blocking/run_web DB helpers
  web.rs       static SPA shell (navbar + empty containers) + static asset handlers, maud
  web.css      frontend stylesheet, inlined via include_str!  (STYLE)
  web.js       SPA: state/URL routing, navbar, grid + sub-album tiles, thumbnails, lightbox, SW (SCRIPT)
  favicon.ico  Digikam's site icon, embedded via include_bytes!, served at /favicon.ico
  manifest.webmanifest  PWA manifest (include_str!), served at /manifest.webmanifest
  sw.js        PWA service worker (include_str!), served at /sw.js
  icon-192.png icon-512.png  PWA icons (include_bytes!), served at /icon-*.png
  error.rs     AppError -> JSON HTTP responses
```

> `web.css`/`web.js`/`manifest.webmanifest` are pulled in with `include_str!` and the
> binary assets (`favicon.ico`, `icon-*.png`) with `include_bytes!`. The flake's `src`
> filter keeps `.css`/`.js`/`.ico`/`.png`/`.webmanifest` alongside the Cargo sources
> (plain `cleanCargoSource` would drop them and the build would fail).

## Future frontend
Planned as full-stack Rust (**Leptos** recommended). The JSON API + `/file` endpoint
is framework-agnostic; `limit/offset/total` paging supports grid virtualization /
infinite scroll over the large image set (~225k photos here). Add a thumbnail endpoint
before building the grid.
