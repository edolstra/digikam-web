# Thumbnail loading performance — findings

Notes from diagnosing a sluggish first paint on the album grid (the page showed a
screenful of grey placeholder boxes for ~0.5s before thumbnails appeared). Kept
here so the non-obvious conclusions (and *why* the current code is shaped the way
it is) survive.

## TL;DR

The delay was **not** decode or server cost — it was **how Firefox schedules
`fetch()` requests during page load**. Three independent behaviours each added
latency; fixing all three took first paint from **~500ms to ~120ms**. The fixes
live in [`src/web.js`](../src/web.js); see the "Fixes" section.

## How the grid loads a thumbnail

Each grid tile is a `src`-less `<img class="thumb" data-id data-full>`. Per tile:

1. fetch `GET /api/photos/:id/thumbnail` → a raw **PGF** blob (Digikam's stored
   thumbnail, served untouched).
2. decode the PGF off the main thread in a **webpgf** (wasm) Blob-worker pool →
   an `ImageData`, buffer transferred back.
3. on the main thread, draw it (rotated per the `X-Orientation` header) to a
   canvas → `toBlob` → object URL → `img.src`.

A `404` (or any failure) falls back to the full-size `/file`. Video tiles use the
same pipeline for a poster image.

## What it was NOT (measured, ruled out)

Everything here was measured, not assumed:

| Suspected cost | Measurement | Verdict |
|---|---|---|
| webpgf module instantiation | **2.2 ms** (Node, `WebPGF({wasmBinary})`) | negligible |
| PGF decode | **~1.5 ms** per 256px thumbnail | negligible |
| Server response | **<1 ms**/request; **89 ms** for 170 thumbnails 6-way concurrent (curl) | not the bottleneck |
| DOM size | sluggish even on small albums | not it |
| Main-thread block | a 16ms heartbeat showed **no gap >80ms** | main thread was free |
| `localhost` IPv6 (`::1`) fallback | persisted on `http://127.0.0.1` too | not it |

The decisive clue came from in-page `performance.now()` marks plus Firefox's
**Network tab Timing** panel: requests sat **"Queued"** for hundreds of ms before
being dispatched, then completed in ~0 ms. So the responses were available almost
instantly — Firefox just wasn't sending the requests.

## Root causes (all Firefox `fetch()` scheduling)

1. **Request-burst pacing.** The aggressive prefetch fired a whole screenful
   (~170) of `fetch()`s at once. Firefox's request pacer holds the *entire burst*
   — even the 2 trivial in-memory asset requests issued first were delayed ~358ms.
2. **`fetch()` deprioritisation during page load.** Default-priority `fetch()`
   requests are held ~150ms while the page is loading. The webpgf asset fetches,
   marked `priority: 'high'`, dispatched at ~23ms while default-priority thumbnail
   fetches issued at the same time were held to ~160ms.
3. **Async-issued requests are held; parse-time requests are not.** Requests
   issued synchronously during initial script execution dispatch promptly;
   requests issued later from the `IntersectionObserver` callback (a few ms later)
   were held ~130ms — far more than the few-ms difference in issue time.

## Fixes (in `src/web.js`)

1. **Cap concurrent thumbnail fetches at 6** (`MAXFETCH`), matching the HTTP/1.1
   per-host connection limit. A small queue (`waiting`) feeds the next fetch as
   each completes. This keeps the pacer from ever engaging. *(Biggest win:
   ~380ms → ~130ms.)*
2. **`priority: 'high'` on every fetch** — the webpgf assets *and* the thumbnails.
3. **Kick off the first ~24 tiles synchronously** at script start (`EAGER`),
   instead of waiting for the observer callback. The observer handles the rest
   and skips the eager ones (`img.__sched`).

Supporting structure: fetch (network) and decode (CPU) are **separate stages** so
fetches stream concurrently while the worker pool decodes; the decoder assets are
fetched **once** and the pool is **pre-warmed** at load (so a blob decodes the
instant it arrives, not after a cold module init).

## Measured timeline after the fixes (small album)

```
  0ms  first thumbnail fetch started (synchronous, eager batch)
 68ms  assets fetched + first thumbnail blob arrived   (~connection ramp-up)
 81ms  first decode result back
123ms  first img painted
```

## Residual + future levers (not done — not worth it for now)

The remaining ~70ms is **connection ramp-up** for the parallel sockets — about as
good as plain HTTP/1.1 gets. To go lower would need a structural change:

- **Batch thumbnails into fewer requests** (a sprite sheet or multipart endpoint)
  — fewer requests means no pacing and no connection ramp-up, at the cost of a
  framing/parsing protocol on both ends.
- **HTTP/2** — multiplexes all requests over one connection, removing the
  6-connection limit entirely. Browsers require **TLS** for HTTP/2 (no cleartext
  h2c), so this means terminating TLS even for a local app.

## Reproducing / re-measuring

- Temporary in-page timing marks (a `performance.now()`-based `console.log`
  helper) at each pipeline stage, plus a `setInterval` heartbeat to detect
  main-thread blocks. Removed after diagnosis; re-add to `src/web.js` if needed.
- Server-side burst check: fire ~170 concurrent thumbnail requests with
  `curl --parallel --parallel-max 6` and time wall-clock (was ~89ms — proves the
  server isn't the bottleneck).
- Firefox **Network tab → Timing**: the **Queued** vs **Waiting** split is what
  distinguishes "Firefox is holding the request" from "the server is slow".
