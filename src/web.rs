//! Server-rendered HTML frontend, built with [`maud`] (compile-time templates
//! with automatic escaping). This is the seed of the browsing UI.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use maud::{html, Markup, PreEscaped, DOCTYPE};

use crate::handlers::{if_none_match_matches, IMMUTABLE_CACHE_CONTROL};

/// The webpgf wasm PGF decoder, embedded at build time. `WEBPGF_PATH` is set by
/// the flake (and the dev shell) to the `nix build .#webpgf` output directory.
const WEBPGF_PATH: &str = env!("WEBPGF_PATH");
const WEBPGF_JS: &[u8] = include_bytes!(concat!(env!("WEBPGF_PATH"), "/webpgf.js"));
const WEBPGF_WASM: &[u8] = include_bytes!(concat!(env!("WEBPGF_PATH"), "/webpgf.wasm"));

/// The site favicon (Digikam's), embedded at build time and served at
/// `/favicon.ico`. Its `ETag` is a content hash so it busts the cache if replaced.
const FAVICON: &[u8] = include_bytes!("assets/favicon.ico");

/// PWA assets, embedded and served so the app can be "installed" (Android etc.):
/// the web app manifest, the service worker, and the icons it references.
const MANIFEST: &str = include_str!("manifest.webmanifest");
const SW_JS: &str = include_str!("sw.js");
const ICON_192: &[u8] = include_bytes!("assets/icon-192.png");
const ICON_512: &[u8] = include_bytes!("assets/icon-512.png");

/// `GET /webpgf.js` — the Emscripten loader for the PGF decoder.
pub async fn webpgf_js(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        WEBPGF_JS,
        "text/javascript; charset=utf-8",
        &format!("{}-js", webpgf_build_id()),
        IMMUTABLE_CACHE_CONTROL,
    )
}

/// `GET /webpgf.wasm` — the decoder module. Served as `application/wasm` so the
/// browser can stream-compile it.
pub async fn webpgf_wasm(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        WEBPGF_WASM,
        "application/wasm",
        &format!("{}-wasm", webpgf_build_id()),
        IMMUTABLE_CACHE_CONTROL,
    )
}

/// `GET /favicon.ico` — the embedded site icon.
pub async fn favicon(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        FAVICON,
        "image/x-icon",
        &format!("favicon-{:x}", fnv1a(FAVICON)),
        IMMUTABLE_CACHE_CONTROL,
    )
}

/// `GET /manifest.webmanifest` — the PWA manifest. `no-cache` (revalidated via
/// its content-hash `ETag`) so manifest tweaks are picked up promptly.
pub async fn manifest(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        MANIFEST.as_bytes(),
        "application/manifest+json",
        &format!("manifest-{:x}", fnv1a(MANIFEST.as_bytes())),
        "no-cache",
    )
}

/// `GET /sw.js` — the service worker. `no-cache` so the browser's update check
/// always revalidates the script (it also byte-compares on its own).
pub async fn service_worker(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        SW_JS.as_bytes(),
        "text/javascript; charset=utf-8",
        &format!("sw-{:x}", fnv1a(SW_JS.as_bytes())),
        "no-cache",
    )
}

/// `GET /icon-192.png` — the PWA icon (192×192).
pub async fn icon_192(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        ICON_192,
        "image/png",
        &format!("icon192-{:x}", fnv1a(ICON_192)),
        IMMUTABLE_CACHE_CONTROL,
    )
}

/// `GET /icon-512.png` — the PWA icon (512×512).
pub async fn icon_512(headers: HeaderMap) -> Response {
    static_asset(
        &headers,
        ICON_512,
        "image/png",
        &format!("icon512-{:x}", fnv1a(ICON_512)),
        IMMUTABLE_CACHE_CONTROL,
    )
}

/// FNV-1a hash — a tiny content hash for `ETag`s, no extra dependency.
const fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut i = 0;
    while i < bytes.len() {
        hash ^= bytes[i] as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        i += 1;
    }
    hash
}

/// Serve an embedded static asset with a strong content-addressed `ETag`
/// (`etag_id`) honoring `If-None-Match` → `304`, plus the given `Cache-Control`.
/// The id changes whenever the bytes change, so the ETag busts the cache then.
fn static_asset(
    headers: &HeaderMap,
    bytes: &'static [u8],
    content_type: &'static str,
    etag_id: &str,
    cache_control: &'static str,
) -> Response {
    let etag = HeaderValue::from_str(&format!("\"{etag_id}\""));
    let cache_control = HeaderValue::from_static(cache_control);
    if let Ok(etag) = &etag {
        if if_none_match_matches(headers, etag) {
            let mut not_modified = Response::new(Body::empty());
            *not_modified.status_mut() = StatusCode::NOT_MODIFIED;
            let h = not_modified.headers_mut();
            h.insert(header::ETAG, etag.clone());
            h.insert(header::CACHE_CONTROL, cache_control);
            return not_modified;
        }
    }
    let mut response = Response::new(Body::from(Bytes::from_static(bytes)));
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(header::CACHE_CONTROL, cache_control);
    if let Ok(etag) = etag {
        h.insert(header::ETAG, etag);
    }
    response
}

/// A stable id for the embedded webpgf build: the basename of its nix store path
/// (`<hash>-webpgf`), which changes only when the bytes do.
fn webpgf_build_id() -> &'static str {
    WEBPGF_PATH.rsplit('/').next().unwrap_or("webpgf")
}

/// Stylesheet for the frontend pages (inlined into each page's `<style>`).
const STYLE: &str = include_str!("assets/style.css");

/// The SPA frontend (inlined into each page's `<script>`). Split across
/// `src/web/*.js` by concern and concatenated here — at runtime it's one script in
/// one shared top-level scope, exactly as before. Order matters only at the ends:
/// `state` first (defines the shared `state`/helpers), `main` last (the bootstrap
/// IIFE); the `"\n"` separators stop a trailing `//`-comment in one fragment from
/// swallowing the next fragment's first line. No server data is interpolated.
const SCRIPT: &str = concat!(
    include_str!("web/state.js"),
    "\n",
    include_str!("web/undo.js"),
    "\n",
    include_str!("web/navbar.js"),
    "\n",
    include_str!("web/thumbnails.js"),
    "\n",
    include_str!("web/grid.js"),
    "\n",
    include_str!("web/lightbox.js"),
    "\n",
    include_str!("web/gridnav.js"),
    "\n",
    include_str!("web/main.js"),
    "\n",
);

/// Assemble the full HTML page shell. The navbar's breadcrumb (`.crumb`) and
/// rating selector (`.rating`) are emitted **empty**; the SPA (`src/web/`) fills them
/// from the URL on load and rebuilds them on each in-page navigation (the page is
/// a client-side SPA, so the shell is identical for every album/filter).
fn page_html(title: &str, body: Markup) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                link rel="icon" href="/favicon.ico" type="image/x-icon";
                // PWA: installable web app (manifest + icons; service worker
                // registered from web.js). theme-color tints the system UI.
                link rel="manifest" href="/manifest.webmanifest";
                meta name="theme-color" content="#1a1a1a";
                link rel="apple-touch-icon" href="/icon-192.png";
                meta name="apple-mobile-web-app-capable" content="yes";
                meta name="apple-mobile-web-app-title" content="digiKam";
                title { (title) }
                style { (PreEscaped(STYLE)) }
            }
            body {
                header.navbar {
                    span.menu {}
                    span.crumb {}
                    span.filter-menu {}
                }
                (body)
                div.lightbox id="lightbox" {
                    button.close aria-label="Close" { "×" }
                    // Top-left action row: the ⓘ info toggle plus the per-photo
                    // operations (same as the t / m keys; Yandex lives only
                    // here, hidden for videos). One uniform row of buttons.
                    div.lb-actions {
                        button.info aria-label="Image info" title="Image info (i)" { "ⓘ" }
                        // Slideshow lives up here (not bottom-left) so it stays
                        // clear of a video's native controls.
                        button.slideshow-btn aria-label="Slideshow" title="Slideshow (s)" { "▶" }
                        button.lb-act.lb-act-tags data-act="tags" title="Edit tags (t)" { "🏷 Tag" }
                        button.lb-act.lb-act-move data-act="move" title="Move to album (m)" { "📂 Move" }
                        button.lb-act.lb-act-yandex data-act="yandex" title="Reverse image search on Yandex" { "🔍 Yandex" }
                    }
                    button.nav.prev aria-label="Previous" { "‹" }
                    img.full id="lb-img" alt="" decoding="async";
                    video.full id="lb-video" playsinline loop controls {}
                    button.nav.next aria-label="Next" { "›" }
                    // Metadata overlay, filled + toggled by web.js (hidden by default).
                    div id="lb-info" {}
                    // Picker modal (`t` = tags, `m` = move to album): quick filter
                    // + MRU + scrollable tree + footer (Cancel always; Apply in
                    // tags mode only — move-mode rows activate directly), filled +
                    // toggled by web.js per mode. Must live inside #lightbox — a
                    // fullscreen element is the only thing the browser paints.
                    div id="lb-picker" {
                        input id="lb-picker-filter" type="text" placeholder="Filter…" aria-label="Filter" autocomplete="off";
                        // Most-recently-used entries (flat, full paths), then the
                        // tree; each under a small grey section label (the tree's
                        // text is set per mode: "Tags" / "Albums").
                        div.picker-label.picker-label-mru { "Recently used" }
                        div.picker-mru {}
                        div.picker-label.picker-label-list {}
                        div.picker-list {}
                        div.picker-actions {
                            button.picker-cancel type="button" { "Cancel" }
                            button.picker-apply type="button" { "Apply" }
                        }
                    }
                }
                script { (PreEscaped(SCRIPT)) }
            }
        }
    }
}

/// The album browsing page, serving `/`, `/photos`, and `/photos/<album path>`.
/// The served HTML is a **static shell** — identical for every URL — that
/// the SPA (`src/web/`) turns into a client-side app: it reads the album + filters
/// from the URL, fetches `/api/subalbums` + `/api/photos`, and renders the navbar,
/// sub-album tiles, and photo grid, re-rendering in place (no page load) as the
/// user navigates. The route captures are therefore ignored here.
pub async fn album_page() -> impl IntoResponse {
    // Cache the shell for an hour (browser-only). Navigations / back-forward reuse
    // it; a force-reload (Ctrl/Cmd+Shift+R) bypasses it.
    (
        [(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=3600"),
        )],
        render(),
    )
}

/// Render the album browsing page **shell**. No DB work and no album/filter logic
/// happens here: the navbar, sub-album tiles, and photo grid are all built
/// client-side (see `src/web/`) into the empty navbar / `#subalbums` /
/// `#photos` containers. The `<title>` is a constant placeholder that web.js
/// replaces with the album path on first render.
fn render() -> Markup {
    let body = html! {
        // Empty containers the client fills from /api/subalbums and /api/photos.
        div id="subalbums" {}
        div id="photos" {}
    };
    page_html("digiKam Browse", body)
}
