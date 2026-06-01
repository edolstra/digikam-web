# digikam-browse

A **read-only** web backend (Rust) that serves the photos in a [Digikam](https://www.digikam.org/)
SQLite database over an HTTP/JSON API. A web frontend will be added later.

## Build & run

Everything goes through Nix (flakes). nixpkgs is pinned to **25.11**; the build
uses [crane](https://github.com/ipetkov/crane) + [rust-overlay](https://github.com/oxalica/rust-overlay).

```bash
nix run                              # build + run with defaults
nix develop --command cargo run      # iterate inside the dev shell
nix develop --command cargo test     # unit tests
nix build                            # produce ./result/bin/digikam-browse
nix flake check                      # build + clippy (-D warnings)
```

> **Always run `cargo fmt` and `cargo clippy` before committing** (e.g.
> `nix develop --command cargo fmt` and `nix develop --command cargo clippy --all-targets`).
> Keep both clean — `nix flake check` treats clippy warnings as errors (`-D warnings`).

Config (CLI flags or env vars):
- `--database` / `DIGIKAM_DB` — path to `digikam4.db` (default `~/.local/share/digikam/db/digikam4.db`).
- `--listen` / `LISTEN_ADDR` — bind address (default `127.0.0.1:8080`).
- `--tls` / `TLS` — serve over **HTTPS, enabling HTTP/2** (ALPN `h2`, HTTP/1.1 fallback),
  using a freshly **auto-generated self-signed** cert (rustls + rcgen, served via hyper's
  auto builder). Browsers warn about the untrusted cert (accept once) and the cert changes
  each restart. HTTPS is also what makes the app installable as a PWA. Off by default
  (plain HTTP/1.1 via `axum::serve`).
- `--thumbnail-database` / `THUMBNAIL_DB` — path to `thumbnails-digikam.db` (default:
  alongside `--database`). Optional; if missing, `/thumbnail` returns `404`.
- `--trace-sql` / `TRACE_SQL` — log every executed SQL statement (with bound values
  inlined) at `info` under the `digikam_browse::sql` target. Off by default.

> Nix flakes only see git-tracked files. After adding/renaming a file, `git add` it
> before `nix build`/`nix develop`, or Nix won't find it (and crane needs `Cargo.lock` tracked).

## API

All endpoints are served under the `/api` prefix.

| Route | Notes |
|-------|-------|
| `GET /api/photos?album=&tags=&recursive=&min_rating=&limit=&offset=` | Filtered, paginated list. `Page<PhotoSummary>` = `{total, limit, offset, items}`. `PhotoSummary.is_video` is true for videos (Digikam `category=2`). |
| `GET /api/photos/:id` | `PhotoDetail` (summary + tag names + lat/long). |
| `GET /api/photos/:id/file` | Original bytes, range-aware (via `tower_http::services::ServeFile`). Sends a strong `ETag` from the image's `uniqueHash`; a matching `If-None-Match` (or `*`) returns `304`. |
| `GET /api/photos/:id/thumbnail` | Digikam's stored thumbnail as-is: the **raw PGF blob** from `thumbnails-digikam.db` (looked up by `uniqueHash`+`fileSize`), for the client to decode in wasm (see [nix/webpgf.nix](nix/webpgf.nix)). Strong `ETag` (+ `If-None-Match`→`304`) and a 1-year `immutable` `Cache-Control`; `X-Orientation` header carries Digikam's `orientationHint` (EXIF orientation) for client-side rotation. `404` when the thumbnails DB is absent / the image has no cached thumbnail → client falls back to `/file`. |
| `GET /api/albums` | Flat list of all albums (`{id, path, root}`). |
| `GET /api/subalbums?album=/Root/rel&min_rating=` | Direct sub-albums of an album as `[{name, path, photo_count, cover: {id, name} \| null}]`, sorted by most recent photo (newest first). An absent/empty `album` lists the album roots. Cover = newest **image** in the sub-album's whole subtree (videos, `category=2`, are never covers; a video-only sub-album has `cover: null`); `photo_count` is the recursive count incl. videos. `min_rating` (0..=5) filters the cover, count, and which sub-albums appear alike. One query; albums with no matching photos anywhere are omitted. |
| `GET /api/tags` | Tag **tree** (`{id, name, children}`), internal tags excluded. |
| `GET /api/health` | Liveness. |

### Frontend (HTML)

Server-rendered HTML pages live at the root (outside `/api`), in [src/web.rs](src/web.rs).
This is the seed of the browsing UI (planned to grow into Leptos later).

| Route | Notes |
|-------|-------|
| `GET /photos` | The virtual top of the database: the album roots are shown as sub-album tiles (cover + name + count, newest-first), each linking to `/photos/<Root>`. No photo grid. |
| `GET /photos/<album path>?min_rating=` | e.g. `/photos/Photos/Lego/Porsche911`. The photos directly in that album (non-recursive) as a day-grouped grid, under a breadcrumb navbar, with a sub-album grid and a fullscreen lightbox. See [The album page](#the-album-page) below. No pagination yet. |

Both HTML pages send `Cache-Control: private, max-age=3600` on success (errors aren't
cached): cached an hour for navigations / back-forward, while a force-reload
(Ctrl/Cmd+Shift+R) bypasses it.

#### The album page

- **Navbar (sticky** — pinned to the top, the page scrolls underneath**)**: a
  breadcrumb starting with a `⌂` home icon (→ `/photos`) then `› Photos › Lego ›
  Porsche911`, each segment linking to that ancestor album. **Alt+↑** navigates to
  the parent album (the second-to-last breadcrumb link).
- **Rating selector** (navbar, right side): five `★` links, no JS. Clicking star K
  filters to `?min_rating=K` (≥K stars); clicking the active threshold clears it.
- **Filters** are encoded in the URL via a `Filters` struct ([src/query.rs](src/query.rs))
  and propagated onto every breadcrumb/sub-album link so they persist while browsing;
  they also constrain the sub-album tile covers/counts.
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
- **Lightbox** (click a photo/video): full-page over a dimmed grid, requesting
  **fullscreen** (Fullscreen API; guarded/no-op where unsupported, e.g. iPhone Safari).
  The media is scaled to fill the viewport (up or down, preserving aspect). Videos
  auto-play, looping, with **native `controls`** (play/pause/seek/volume; mp4/webm only);
  Space toggles play/pause and `m` toggles mute. **Touch gestures take over from the
  native controls on touch** (which stay mouse-usable on desktop): tap a video to
  pause/play, swipe left/right (anywhere, incl. over a video) to go prev/next, swipe up
  for a random item. With a keyboard, ←/→ navigate (`preventDefault` stops a focused video
  from also seeking), Home/End jump to first/last, and `r` jumps to a random item; the
  on-screen ‹ › chevrons navigate too, and the **mouse wheel** goes prev/next (scroll
  down = next; throttled to one item per notch). All navigation stops at the ends. Dismiss by
  clicking the letterbox / Esc / the X / the device Back button — opening pushes a
  history entry so Back closes the lightbox instead of leaving the page, and exiting
  fullscreen closes it too. On dismiss, the grid scrolls the last-viewed tile fully into
  view if browsing left it off-screen (`scrollIntoView({block:'nearest'})` with the tile's
  `scroll-margin-top` set to the sticky navbar's height so it isn't tucked underneath). The close/`‹ ›` controls (and the mouse cursor) **start hidden**
  (web.js `.idle` class) and are revealed by a **mouse/pen move or a tap** — *not* by
  keyboard navigation or swipes — then auto-hide again after 2s of inactivity; a tap that
  only reveals them is consumed so it doesn't also dismiss/navigate. Perf: preloads the
  prev/next images, `decoding="async"`, and `touch-action: manipulation` to cut mobile tap latency.

#### Installable PWA
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
> "Install". Run with **`--tls`** (self-signed; accept the cert warning), or put it behind
> real TLS (a reverse proxy / `tailscale serve` / a tunnel) for a trusted cert.

### Query semantics
- **`album=/Root/rel`** — the first path segment is the `AlbumRoots.label`; the
  remainder is a `relativePath`. By default it matches **only that album**
  (photos directly in it). `/Photos` alone means the root album (`relativePath = "/"`).
- **`recursive`** — a boolean: `?recursive=true` also includes all sub-albums;
  `?recursive=false` or absence keeps the default non-recursive behavior. With
  `?recursive=true`, `/Photos` selects the whole collection.
- **`tags=a,b`** — **AND** across the listed names, **exact** match (descendant tags
  do *not* count). A name shared by several tag ids is OR'd within that one name.
  An unknown tag name yields an empty result (correct AND behavior).
- **`min_rating=N`** — minimum rating, `0..=5` (else `400`). Unrated images
  (Digikam stores `-1`) count as `0`, so `min_rating=0` includes everything and
  `min_rating>=1` excludes the unrated. Implemented as `max(ifnull(ii.rating,0),0) >= N`.
- **Ordering / dates** — newest first by **`Images.modificationDate`** (`ORDER BY
  i.modificationDate DESC, i.id DESC`); the same column drives the day-grouping and the
  sub-album cover/sort. We deliberately use the file modification date, **not**
  `ImageInformation.creationDate` (which is Digikam's import time, rarely what you want).
- **Paging** — `limit` defaults to 200, capped at 1000; `offset` defaults to 0.

## Architecture & design choices

- **Stack**: `axum` + `tokio`; `rusqlite` (feature `bundled`, so SQLite is compiled
  in — no system lib / pkg-config) behind an `r2d2` connection pool. rusqlite is
  blocking, so every DB call runs inside `tokio::task::spawn_blocking` (see
  `run_blocking` in [src/handlers.rs](src/handlers.rs)).
- **HTML rendering**: the frontend pages use [`maud`](https://maud.lang.rs/)
  (compile-time `html!` templates with automatic escaping). Handlers return
  `maud::Markup` (its axum feature makes it `IntoResponse`). The `include_str!`'d
  `web.css`/`web.js` are emitted inside `<style>`/`<script>` via `PreEscaped`
  (trusted, must not be escaped).
- **Read-only & safe alongside running Digikam**: connections open with
  `SQLITE_OPEN_READ_ONLY`, set `PRAGMA query_only=ON`, and a 5s `busy_timeout` so
  reads don't fail while Digikam writes. We deliberately do **not** use `immutable=1`
  (Digikam may be modifying the file concurrently). See `build_pool` in [src/db.rs](src/db.rs).
- **Path resolution** ([src/db.rs](src/db.rs)): an image's absolute path is
  `AlbumRoots` base + `Albums.relativePath` + `/` + `Images.name`. The root base is
  parsed from the `path=` field of the `volumeid:?path=…&fileuuid=…` identifier
  (percent-decoded), joined with `specificPath`. The root album has `relativePath == "/"`.
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
(1) **cap concurrent fetches** at 6 — firing a screenful at once makes Firefox's request
pacer hold the *whole burst* for hundreds of ms; (2) **`priority: 'high'`** on every fetch —
Firefox otherwise deprioritises `fetch()` for ~150ms during page load; (3) **kick off the
first ~24 tiles synchronously** at script start rather than from the observer callback —
requests issued during initial parse are dispatched promptly, later ones are held. The
observer handles the rest (skipping the eager ones). To make the *first* paint snappy,
the decoder assets are fetched **once** (not once per worker): `/webpgf.js` is inlined into
the worker body and `/webpgf.wasm` is fetched once, then the pool is **pre-warmed** — each
worker instantiates the module at page load (via an init message carrying the shared wasm
bytes), overlapping with the thumbnail fetches, so blobs decode the instant they arrive
rather than waiting on a cold module. Each worker returns an `ImageData` whose buffer is
transferred back. The main thread draws each result — applying the EXIF `X-Orientation`
(2..8; 0/1/junk = no rotation) — to a canvas, then sets the `<img>` to the canvas's blob URL.
The worker URLs are made **absolute** (`location.origin` baked in) because a `blob:` worker
resolves relative paths against its opaque blob base, not the page origin. A worker that dies
(e.g. webpgf failed to load) falls back its tile to `/file`; once the whole pool is gone,
queued/new tiles do too.

### Deliberately out of scope (this milestone)
- Auth, any write operations, and search by date/rating/geo.

## Source layout

```
src/
  main.rs      router, startup, graceful shutdown
  config.rs    clap config (database path, listen addr)
  db.rs        read-only pool, album-root loading, path resolution  (+ unit tests)
  models.rs    serde response types (PhotoSummary, PhotoDetail, AlbumNode, SubAlbum, TagNode, Page<T>)
  query.rs     /photos + /subalbums SQL + param building              (+ unit tests)
  handlers.rs  axum JSON API handlers, run_blocking DB helper
  web.rs       server-rendered HTML frontend pages (maud)    (+ unit tests)
  web.css      frontend stylesheet, inlined via include_str!  (STYLE)
  web.js       lightbox + thumbnails + SW registration, inlined via include_str! (SCRIPT)
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
