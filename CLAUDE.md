# digikam-web

A web frontend for browsing (and, opt-in, lightly editing) the photos in a [Digikam](https://www.digikam.org/) collection: a Rust server reads Digikam's SQLite database and serves an HTTP/JSON API plus a single-page web app. **Read-only by default**: the Digikam DB is only written when the server is started with `--allow-writes`, which enables rating changes, tag editing, and moving photos between albums (a move also renames the file on disk; uploads are planned). Goals: fast browsing of a large collection from any device (desktop, phone, TV), safe to run alongside a running Digikam, and no setup beyond pointing it at the database.

## Build & run

Everything goes through Nix (flakes). nixpkgs is pinned to **26.05**; the build uses [crane](https://github.com/ipetkov/crane) + [rust-overlay](https://github.com/oxalica/rust-overlay).

```bash
nix run                              # build + run with defaults
nix develop --command cargo run      # iterate inside the dev shell
nix develop --command cargo test     # unit + API integration tests (seeded temp SQLite)
nix build                            # produce ./result/bin/digikam-web
nix flake check                      # build + clippy (-D warnings) + Playwright e2e
```

Config (CLI flags or env vars):
- `--database` / `DIGIKAM_DB` — path to `digikam4.db` (default `~/.local/share/digikam/db/digikam4.db`).
- `--listen` / `LISTEN_ADDR` — bind address (default `127.0.0.1:8080`). Plain HTTP; terminate TLS in a reverse proxy in front of it.
- `--thumbnail-database` / `THUMBNAIL_DB` — path to `thumbnails-digikam.db` (default: next to `--database`). Optional; without it the client falls back to full-size images.
- `--web-database` / `WEB_DB` — our own writable DB for bookmarks (`web.sql`, default: next to `--database`; created if missing).
- `--allow-writes` / `ALLOW_WRITES` — opt in to writing the Digikam DB. Off by default (the write endpoint then returns `403`).
- `--trace-sql` / `TRACE_SQL` — log every executed SQL statement.

A NixOS module is exposed as `nixosModules.default` ([nix/nixos-module.nix](nix/nixos-module.nix)).

### Tests

- **API tests** (`cargo test`): in-crate integration tests that seed a synthetic Digikam DB and drive the real router.
- **e2e tests** ([tests/e2e/](tests/e2e/)): Playwright + headless Chromium against the real server, serving the same synthetic fixture ([src/fixture.rs](src/fixture.rs), via the hidden `--seed-fixture` flag) with writes enabled. Runs as the flake's `e2e` check; locally: `nix develop --command sh -c 'cargo build && DIGIKAM_WEB_BIN=$PWD/target/debug/digikam-web playwright test -c tests/e2e'`. The specs also save per-stage screenshots for visual inspection: `nix build .#checks.x86_64-linux.e2e` leaves them in `./result/`; local runs write them to `tests/e2e/test-results/screenshots/`.

> Nix flakes only see git-tracked files. After adding/renaming a file, `git add` it before `nix build`/`nix develop`, or Nix won't find it.

## Coding standards

- **Always run `cargo fmt` and `cargo clippy` before committing** (e.g. `nix develop --command cargo fmt` and `nix develop --command cargo clippy --all-targets`). Keep both clean — `nix flake check` treats clippy warnings as errors (`-D warnings`).
- **Markdown**: don't hard-wrap paragraphs — keep each paragraph (and each list item, blockquote, or table cell) on a single line, letting the editor soft-wrap. Reserve line breaks for actual block boundaries (new paragraphs, list items, etc.).
- **Where documentation goes**: this file describes the high-level design, goals, and the intended user interface (what the user sees and can do). Code-level details — how something is implemented, function and CSS class names, edge-case mechanics — belong in comments next to the code, not here, so there's one copy to keep current.

## Architecture & design choices

- **Stack**: `axum` + `tokio`; `rusqlite` (SQLite compiled in) behind an `r2d2` pool, with DB calls on the blocking thread pool. The page is a static shell rendered with [`maud`](https://maud.lang.rs/); all CSS/JS and the other static assets are embedded in the binary.
- **Safe alongside a running Digikam**: the Digikam DB is opened read-only (and `query_only`) unless `--allow-writes` is given, never with `immutable=1` (Digikam may be changing it), and with a busy timeout so our reads and writes wait politely for Digikam's.
- **Writes** (opt-in) change Digikam's **database only** — not the files' XMP/EXIF, like Digikam with "write metadata to files" off — except that moving a photo also renames its file. A request's changes are applied all-or-nothing. A move is refused rather than papered over when the database and disk disagree (missing directory or source file, name collision), and only works within one filesystem for now. Every actual change is logged. A running Digikam won't notice our changes until it reloads.
- **Our own data** (bookmarks) lives in a separate `web.sql`, never in a Digikam DB.
- **Visibility**: only visible images are served; Digikam's trashed and obsolete ones never appear. Digikam's internal tags (color/pick labels, version history) are hidden everywhere.
- **Thumbnails**: Digikam's stored thumbnails are PGF, which browsers can't decode, so the server sends them untouched and the client decodes them in a WebAssembly worker pool ([webpgf](https://github.com/haplo/webpgf), built by [nix/webpgf.nix](nix/webpgf.nix)), rotating per the EXIF orientation. They're keyed by content hash + size, not path, because the thumbnail DB's paths go stale. Images without a stored thumbnail fall back to the original. First-paint latency was tuned against Firefox's request pacing — see [docs/thumbnail-loading-performance.md](docs/thumbnail-loading-performance.md).
- **Caching**: thumbnails and the decoder assets are content-addressed and cached as immutable; originals revalidate by content hash; the page shell is cached for an hour. The PWA service worker deliberately doesn't intercept fetches, since a service-worker response would bypass these HTTP caching rules.
- **No CORS layer**: the frontend is same-origin. A permissive CORS layer used to add `Vary: origin`, which stopped the browser reusing its cached thumbnails; only add a scoped one if a separate-origin frontend ever needs the API.
- **One outbound network call**: the server-side Yandex reverse-image search (the server uploads the image, because the browser can't read Yandex's response).
- **Frontend architecture**: a client-side SPA. The server sends the same static shell for every page URL; the client reads the album and filters from the URL, fetches the JSON API, renders in place, and keeps the URL in sync (`pushState`) so bookmarks and Back/Forward work. Long-lived pieces (the thumbnail decoder pool, the lightbox) are created once and survive navigations.

### Relevant Digikam schema
- `AlbumRoots(id, label, identifier, specificPath)` — collection roots; the identifier encodes the root's base directory.
- `Albums(id, albumRoot, relativePath)` — directories; the root album has `relativePath = "/"`.
- `Images(id, album, name, status, category, fileSize, uniqueHash, modificationDate)` — `status = 1` is visible; `category = 2` is a video.
- `ImageInformation(imageid, rating, creationDate, width, height, format, …)` — rating `-1` = unrated.
- `Tags(id, pid, name)` (top level: `pid = 0`), `TagsTree(id, pid)` (the ancestor closure), `ImageTags(imageid, tagid)`, `ImageComments`, `ImagePositions`.

## API

All endpoints are under `/api`, except the root-level `/random`. Album paths are display paths: `/<root label>/<relative path>`, e.g. `/Photos/Lego`.

| Route | Purpose |
|-------|---------|
| `GET /api/photos?album=&recursive=&tags=&min_rating=&images=&video=&aspect=&sort=&limit=&offset=` | Filtered, paginated photo/video list: `{incomplete, limit, offset, items: [PhotoSummary]}` (`incomplete` = more beyond this page). See query semantics below. |
| `GET /api/photos/:id` | Full metadata (`PhotoDetail`): the summary fields plus the absolute server path, description (Digikam's comments), GPS position, and tags (as absolute tag paths like `/places/beach`). |
| `PATCH /api/photos/:id` | Partial update (needs `--allow-writes`, else `403`): `rating` (0–5, or `null` = unrated), `tags_add` / `tags_remove` (tag ids), `album` (move to that album id). Absent fields are left alone; all-or-nothing. `422` for invalid values / unknown or internal tags / unknown album, `409` when a move conflicts with the disk, `404` for an unknown photo. |
| `GET /api/photos/:id/file` | The original file (range requests, `ETag` revalidation, original filename for saving). |
| `GET /api/photos/:id/thumbnail` | Digikam's stored thumbnail (raw PGF) with its EXIF orientation; `404` if none. |
| `GET /api/photos/:id/reverse-search?engine=yandex` | Uploads the image to Yandex and redirects to the results. |
| `GET /api/albums` | All albums, flat (`{id, path, root}`). |
| `GET /api/subalbums?album=&…filters…&sort=` | Direct sub-albums of an album (or the album roots, for an empty `album`), each with a recursive item count and a cover. The filters constrain counts, covers, and which sub-albums appear. Ordered newest-first, or A–Z under `sort=name`; the cover is the first item under the same sort. |
| `GET /api/tags` | The tag tree. |
| `GET` / `POST /api/bookmarks`, `DELETE /api/bookmarks/:name` | Saved views: a name + album + filters. `POST` refuses a duplicate name (`409`) unless `overwrite` is set. |
| `GET /api/health` | Liveness. |
| `GET /random?…same params as /api/photos…` | Redirects to a random matching item's original (never cached) — for photo frames and screensavers that just fetch a URL. Pass `video=false` for images only. |

### Query semantics
- **`album=/Root/rel`** — that album only, by default. An empty `album` (the virtual root above all collections) has no items of its own.
- **`recursive=true`** — also include all sub-albums (with an empty `album`: the whole collection).
- **`tags=a,b`** — every token must match (AND). A token matches a tag **and its subtags**, never a substring (`foo` ≠ `foobar`). A token starting with `/` is an absolute tag path, case-sensitive. Any other token is a name, case-insensitive, matching a tag of that name at any level **or** an album of that name (and its sub-albums) — so `vacation` finds both the `/places/vacation` tag and a `…/Vacation/…` folder.
- **`min_rating=N`** (0–5) — unrated counts as 0.
- **`images=false` / `video=false`** — exclude that media type.
- **`aspect=portrait|landscape`** — `height ≥ width` / `width ≥ height` (squares match both).
- **`sort=modified|created|name`** — newest first by file modification date (the default — Digikam's creation date is usually the import time, rarely what "newest" should mean), newest first by creation date, or A–Z by file name with natural number ordering (`9_foo` before `10_bar`).
- **Paging** — `limit` (default 25000, max 100000) and `offset`.

## User interface

The app lives at `/photos/<album path>` (`/` and `/photos` are the root); filters and the slideshow settings are query parameters, so any view can be bookmarked or shared. It's an installable PWA (installing needs HTTPS or `localhost` — e.g. behind a TLS reverse proxy or `tailscale serve`).

### The album page
- **Navbar** (sticky, deliberately minimal for phones): a `☰` bookmarks menu on the left, the breadcrumb (`⌂ › Photos › Lego › …`, each segment a link), and a funnel filters menu on the right. **Alt+↑** goes to the parent album.
- **Bookmarks menu**: saved views (album + filters) by name; `+` saves the current view (confirming before overwriting), `✕` deletes one.
- **Filters menu**: recursive on/off, minimum stars, media type (all / images / videos), aspect ratio (all / portrait / landscape), sort (modified / created / name), and a free-text tag filter, plus a clear-all. The funnel turns gold while any filter is active. The menus stay open while you click through them, so several filters can be adjusted in a row.
- **Sub-albums**: tiles with a cover, the name, and the item count, collapsed to the first two rows (with a "Show all" toggle) when there are photos below to get to.
- **Photo grid**: grouped by day (by the sort's date) — or a flat A–Z grid when sorting by name. Thumbnails load lazily, ahead of scrolling. Videos show a ▶ badge. Middle-click opens the original in a new tab.
- **Keyboard**: the arrow keys move a selection across the sub-albums and the photos (Home/End, PageUp/PageDown too); Enter opens it. The selection is kept in the URL fragment, so it survives reloads and Back/Forward, and closing the lightbox selects the item last viewed.

### Lightbox
Clicking a photo or video opens it full-screen (browser fullscreen where supported), scaled to fit.
- **Navigation**: ←/→, the ‹ › buttons, the mouse wheel, and swipes; Home/End; `r` (or swipe up) for a random item — random navigation shows every item once before repeating. Close with Esc, the ×, a click on the background, or the device's Back button. `f` toggles browser fullscreen without closing.
- **Videos** play automatically, with the browser's own controls; Space plays/pauses, `m` mutes.
- **Zoom** (images, up to 4×): pinch, Ctrl+wheel, `+`/`-`, or double-click/double-tap; drag to pan.
- **Controls** stay out of the way: hidden until the mouse moves or the screen is tapped, then hidden again after a couple of seconds (not shown by keyboard navigation or swipes).
- **Action row** (top left): ⓘ info, ▶ slideshow, 🏷 Tag, 📂 Move, and 🔍 Yandex reverse-image search (images only, with a confirmation since it uploads the image).
- **Info panel** (ⓘ or `i`): file name (with a copy-the-server-path button), album, rating, format, size, resolution, dates, description, location (a map link), and tags. The album and tags are links to that album / tag. The rating stars are editable; **Ctrl+0..5** sets the rating from the keyboard.
- **Tags** (`t`): a checklist of the tag tree with a filter box and the recently used tags on top. Changes are staged and applied together with Enter / Apply; Esc or clicking outside discards them.
- **Move** (`v`): pick a target album from the album tree (filterable, recently used on top); the move happens immediately and also moves the file on disk.
- **Slideshow**: `s` starts/stops it; ▶ opens its settings (seconds per image, shuffle on/off, a "copy slideshow link" button). Images advance after the interval with a crossfade; videos play to the end. The screen is kept awake while it runs. During a shuffled slideshow, next/previous move through the shuffle order.
- **Photo frame URLs**: `autoplay=true` starts a slideshow when the page loads; `interval=<seconds>` and `shuffle=false` set its options. Browsers don't allow fullscreen without a user action, so the first key press or tap enters fullscreen (unless the browser is set up as a kiosk). Browsers may also block a slideshow's videos from playing on their own (they're then skipped), so `video=false` makes for a more reliable photo frame.
- **TV remotes**: a remote's Stop button stops the slideshow and Rewind / Fast-forward step through items (tested on LG webOS). Play/Pause aren't available to web pages there.

### Undo
`u` undoes the last change (rating, tags, or move), anywhere in the app, as many steps back as you like within the session. Changes and undos are confirmed with a short message at the bottom of the screen (or, for a rating changed in the open info panel, by its stars). The undo history isn't saved across reloads.

## Deliberately out of scope (for now)
- Auth, and search by date or location.
- Writes beyond ratings, tags and moves. Planned: uploads, operations on a multi-selection in the grid, and moves across filesystems. New operations should be undoable like the existing ones.

## Source layout

- `src/main.rs` — router + startup; `config.rs` — CLI config; `error.rs` — errors → JSON responses
- `src/db.rs` — DB pools, album roots, path resolution; `query.rs` — the photo / sub-album queries and filter types; `models.rs` — the API's JSON types; `http.rs` — HTTP caching helpers
- `src/handlers/` — the API handlers, by area: `browse.rs` (listings), `detail.rs`, `write.rs` (PATCH), `media.rs` (file / thumbnail / reverse search), `bookmarks.rs`; shared plumbing in `mod.rs`
- `src/web.rs` — the page shell and static assets; `src/web/*.js` — the SPA, concatenated into one script in the order listed in `web.rs`: `state.js` (state + URL model), `undo.js`, `navbar.js`, `thumbnails.js`, `grid.js`, `lightbox.js` (core) + `lightbox-{info,slideshow,picker,gestures}.js`, `gridnav.js`, `main.js` (bootstrap, last)
- `src/assets/` — stylesheet, icons, fixture images; `src/manifest.webmanifest`, `src/sw.js` — PWA
- `src/fixture.rs` — the synthetic test fixture (API tests + e2e); `src/tests/` — the API integration tests
- `tests/e2e/` — the Playwright suite
