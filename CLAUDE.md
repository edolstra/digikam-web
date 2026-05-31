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

Config (CLI flags or env vars):
- `--database` / `DIGIKAM_DB` — path to `digikam4.db` (default `~/.local/share/digikam/db/digikam4.db`).
- `--listen` / `LISTEN_ADDR` — bind address (default `127.0.0.1:8080`).
- `--trace-sql` / `TRACE_SQL` — log every executed SQL statement (with bound values
  inlined) at `info` under the `digikam_browse::sql` target. Off by default.

> Nix flakes only see git-tracked files. After adding/renaming a file, `git add` it
> before `nix build`/`nix develop`, or Nix won't find it (and crane needs `Cargo.lock` tracked).

## API

All endpoints are served under the `/api` prefix.

| Route | Notes |
|-------|-------|
| `GET /api/photos?album=&tags=&recursive&limit=&offset=` | Filtered, paginated list. `Page<PhotoSummary>` = `{total, limit, offset, items}`. |
| `GET /api/photos/:id` | `PhotoDetail` (summary + tag names + lat/long). |
| `GET /api/photos/:id/file` | Original bytes, range-aware (via `tower_http::services::ServeFile`). Sends a strong `ETag` from the image's `uniqueHash`; a matching `If-None-Match` (or `*`) returns `304`. |
| `GET /api/albums` | Flat list of all albums (`{id, path, root}`). |
| `GET /api/tags` | Tag **tree** (`{id, name, children}`), internal tags excluded. |
| `GET /api/health` | Liveness. |

### Frontend (HTML)

Server-rendered HTML pages live at the root (outside `/api`), in [src/web.rs](src/web.rs).
This is the seed of the browsing UI (planned to grow into Leptos later).

| Route | Notes |
|-------|-------|
| `GET /photos/<album path>` | e.g. `/photos/Photos/Lego/Porsche911`. HTML photo grid of the photos directly in that album (non-recursive), grouped by day (newest first), fixed-height and wrapping left-to-right. Images load from `/api/photos/:id/file` directly (no thumbnails yet) with `loading="lazy"`. Clicking a photo opens an inline lightbox (full-page over a dimmed grid) with prev/next via swipe, ←/→ keys, or on-screen ‹ › chevrons (stops at ends), dismissed by backdrop click / Esc / the X button. No pagination yet. |

### Query semantics
- **`album=/Root/rel`** — the first path segment is the `AlbumRoots.label`; the
  remainder is a `relativePath`. By default it matches **only that album**
  (photos directly in it). `/Photos` alone means the root album (`relativePath = "/"`).
- **`recursive`** — presence (`?recursive`, `?recursive=true`, `?recursive=1`) also
  includes all sub-albums; falsey values (`false`/`0`/`no`) or absence keep the
  default non-recursive behavior. With `recursive`, `/Photos` selects the whole collection.
- **`tags=a,b`** — **AND** across the listed names, **exact** match (descendant tags
  do *not* count). A name shared by several tag ids is OR'd within that one name.
  An unknown tag name yields an empty result (correct AND behavior).
- **Ordering** — newest first (`ORDER BY ii.creationDate DESC, i.id DESC`).
- **Paging** — `limit` defaults to 200, capped at 1000; `offset` defaults to 0.

## Architecture & design choices

- **Stack**: `axum` + `tokio`; `rusqlite` (feature `bundled`, so SQLite is compiled
  in — no system lib / pkg-config) behind an `r2d2` connection pool. rusqlite is
  blocking, so every DB call runs inside `tokio::task::spawn_blocking` (see
  `run_blocking` in [src/handlers.rs](src/handlers.rs)).
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
- **CORS**: permissive (dev convenience) for the future browser frontend.

### Relevant Digikam schema
- `AlbumRoots(id, label, identifier, specificPath)` — collection roots.
- `Albums(id, albumRoot, relativePath)` — directories; unique `(albumRoot, relativePath)`.
- `Images(id, album, name, status, fileSize, uniqueHash)`.
- `ImageInformation(imageid, rating, creationDate, width, height, format, …)`.
- `Tags(id, pid, name)`; `TagsTree(id, pid)` is the ancestor transitive closure
  (`SELECT id FROM TagsTree WHERE pid = T` gives descendants of `T` — currently unused
  because tag matching is exact).
- `ImageTags(imageid, tagid)`, `ImagePositions(imageid, latitudeNumber, longitudeNumber)`.

### Deliberately out of scope (this milestone)
- **Thumbnails** — Digikam's `thumbnails-digikam.db` is *not* reused: its blobs are
  PGF-encoded and its `FilePaths` are stale (`/mm/Images/…` vs the real
  `/home/eelco/Images/…`). On-the-fly generation is the planned approach later.
- Auth, any write operations, and search by date/rating/geo.

## Source layout

```
src/
  main.rs      router, startup, graceful shutdown
  config.rs    clap config (database path, listen addr)
  db.rs        read-only pool, album-root loading, path resolution  (+ unit tests)
  models.rs    serde response types (PhotoSummary, PhotoDetail, AlbumNode, TagNode, Page<T>)
  query.rs     /photos SQL + param building                          (+ unit tests)
  handlers.rs  axum JSON API handlers, run_blocking DB helper
  web.rs       server-rendered HTML frontend pages           (+ unit tests)
  error.rs     AppError -> JSON HTTP responses
```

## Future frontend
Planned as full-stack Rust (**Leptos** recommended). The JSON API + `/file` endpoint
is framework-agnostic; `limit/offset/total` paging supports grid virtualization /
infinite scroll over the large image set (~225k photos here). Add a thumbnail endpoint
before building the grid.
