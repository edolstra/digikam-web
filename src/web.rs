//! Server-rendered HTML frontend, built with [`maud`] (compile-time templates
//! with automatic escaping). This is the seed of the browsing UI.

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use maud::{html, Markup, PreEscaped, DOCTYPE};
use serde::Deserialize;

use crate::handlers::{if_none_match_matches, IMMUTABLE_CACHE_CONTROL};
use crate::query::{self, Filters, Rating};

/// The webpgf wasm PGF decoder, embedded at build time. `WEBPGF_PATH` is set by
/// the flake (and the dev shell) to the `nix build .#webpgf` output directory.
const WEBPGF_PATH: &str = env!("WEBPGF_PATH");
const WEBPGF_JS: &[u8] = include_bytes!(concat!(env!("WEBPGF_PATH"), "/webpgf.js"));
const WEBPGF_WASM: &[u8] = include_bytes!(concat!(env!("WEBPGF_PATH"), "/webpgf.wasm"));

/// The site favicon (Digikam's), embedded at build time and served at
/// `/favicon.ico`. Its `ETag` is a content hash so it busts the cache if replaced.
const FAVICON: &[u8] = include_bytes!("favicon.ico");

/// PWA assets, embedded and served so the app can be "installed" (Android etc.):
/// the web app manifest, the service worker, and the icons it references.
const MANIFEST: &str = include_str!("manifest.webmanifest");
const SW_JS: &str = include_str!("sw.js");
const ICON_192: &[u8] = include_bytes!("icon-192.png");
const ICON_512: &[u8] = include_bytes!("icon-512.png");

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
const STYLE: &str = include_str!("web.css");

/// Lightbox behavior (inlined into each page's `<script>`). No server data is
/// interpolated; media URLs are read from the grid `<img src>` / `.vtile`
/// `data-src` attributes. Photos use `#lb-img`, videos `#lb-video`.
const SCRIPT: &str = include_str!("web.js");

/// The frontend URL for album path segments, e.g. `["Photos", "Lego"]` ->
/// `/photos/Photos/Lego`, percent-encoding each segment and appending the active
/// filters so they are carried along. `[]` is the root (`/photos`).
fn album_href(album: &[String], filters: &Filters) -> String {
    let mut href = String::from("/photos");
    for segment in album {
        href.push('/');
        href.push_str(&urlencoding::encode(segment));
    }
    href.push_str(&filters.query_string());
    href
}

/// Render album path segments as a clickable breadcrumb
/// `⌂ › Photos › Lego › Porsche911`. The leading house symbol links to `/photos`
/// (the top of the database); each segment links to that album page, carrying the
/// active filters.
fn breadcrumb(album: &[String], filters: &Filters) -> Markup {
    html! {
        a.home href=(album_href(&[], filters)) aria-label="Home" { "⌂" }
        @for i in 0..album.len() {
            span.sep { "›" }
            // `album[..=i]` is the cumulative path up to and including segment i.
            a href=(album_href(&album[..=i], filters)) { (album[i]) }
        }
    }
}

/// Render the navbar's rating selector: five stars where the first `min_rating`
/// are gold. Clicking star K filters to `≥K`; clicking the active threshold again
/// clears it. Links keep the other filters and the current album.
fn rating_selector(album: &[String], filters: &Filters) -> Markup {
    let cur = filters.min_rating.get();
    html! {
        span.rating {
            @for k in 1..=5 {
                // Toggle off (back to Rating(0)) when clicking the active threshold.
                @let target =
                    filters.with_min_rating(Rating::new(if cur == k { 0 } else { k }).unwrap_or_default());
                @let on = k <= cur;
                a.on[on] href=(album_href(album, &target)) title=(format!("≥{k} stars")) {
                    @if on { "★" } @else { "☆" }
                }
            }
        }
    }
}

/// Assemble a full HTML page. `controls` is the right-hand side of the navbar
/// (e.g. the rating selector), or empty.
fn page_html(title: &str, crumb: Markup, controls: Markup, body: Markup) -> Markup {
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
                    span.crumb { (crumb) }
                    (controls)
                }
                (body)
                div.lightbox id="lightbox" {
                    button.close aria-label="Close" { "×" }
                    button.nav.prev aria-label="Previous" { "‹" }
                    img.full id="lb-img" alt="" decoding="async";
                    video.full id="lb-video" playsinline loop controls {}
                    button.nav.next aria-label="Next" { "›" }
                }
                script { (PreEscaped(SCRIPT)) }
            }
        }
    }
}

/// Query parameters parsed from the album page URL into [`Filters`].
#[derive(Debug, Deserialize)]
pub struct AlbumViewParams {
    #[serde(default)]
    min_rating: Rating,
}

/// The album browsing page, serving `/`, `/photos`, and `/photos/<album path>`.
/// An empty/absent path (`/`, `/photos`) is the virtual root (album roots shown
/// as tiles); `/photos/Photos/Lego` -> `["Photos", "Lego"]`.
pub async fn album_page(
    // `None` for the routes without a `*path` capture (`/`, `/photos`).
    path: Option<Path<String>>,
    Query(params): Query<AlbumViewParams>,
) -> impl IntoResponse {
    let filters = Filters {
        min_rating: params.min_rating,
    };
    let path = path.map(|Path(p)| p).unwrap_or_default();
    let album = query::album_segments(&path);
    // Cache the page for an hour (browser-only). Navigations / back-forward reuse
    // it; a force-reload (Ctrl/Cmd+Shift+R) bypasses it.
    (
        [(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=3600"),
        )],
        render(&album, &filters),
    )
}

/// Render the album browsing page **shell**. No DB work happens here: both the
/// sub-album tiles and the photo grid are fetched client-side (`/api/subalbums`
/// and `/api/photos`, album + filters read from the URL by [web.js](web.js)) and
/// fill the empty `#subalbums` / `#photos` containers. Only the navbar (breadcrumb
/// and rating selector) and the title are server-rendered. `album` is empty for
/// the virtual root (no photo grid), or the album's path segments for a real album.
fn render(album: &[String], filters: &Filters) -> Markup {
    let body = html! {
        // Empty containers the client fills from /api/subalbums and /api/photos.
        // The virtual root is just an album with no photos of its own.
        div id="subalbums" {}
        div id="photos" {}
    };
    let title = if album.is_empty() {
        "Photos".to_string()
    } else {
        format!("/{}", album.join("/"))
    };
    page_html(
        &title,
        breadcrumb(album, filters),
        rating_selector(album, filters),
        body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build album segments from string literals.
    fn segs(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn builds_breadcrumb() {
        let html = breadcrumb(
            &segs(&["Photos", "Lego", "Porsche911"]),
            &Filters::default(),
        )
        .into_string();
        assert!(html.contains("<a href=\"/photos/Photos\">Photos</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego\">Lego</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego/Porsche911\">Porsche911</a>"));
    }

    #[test]
    fn breadcrumb_encodes_and_escapes() {
        // Spaces are percent-encoded in the href; the label stays human-readable.
        let html = breadcrumb(&segs(&["My Photos"]), &Filters::default()).into_string();
        assert!(html.contains("href=\"/photos/My%20Photos\""));
        assert!(html.contains(">My Photos</a>"));
    }

    #[test]
    fn filters_propagate_into_links() {
        let f = Filters {
            min_rating: Rating::new(3).unwrap(),
        };
        // Breadcrumb links carry the active filter.
        let html = breadcrumb(&segs(&["Photos", "Lego"]), &f).into_string();
        assert!(html.contains("href=\"/photos/Photos/Lego?min_rating=3\""));
    }

    #[test]
    fn rating_selector_toggles_and_fills() {
        let html = rating_selector(
            &segs(&["Photos", "Lego"]),
            &Filters {
                min_rating: Rating::new(2).unwrap(),
            },
        )
        .into_string();
        // First two stars filled (on), and clicking star 2 again clears the filter.
        assert_eq!(html.matches("class=\"on\"").count(), 2);
        assert!(html.contains("href=\"/photos/Photos/Lego\" title=\"≥2 stars\""));
        // Star 4 raises the threshold.
        assert!(html.contains("href=\"/photos/Photos/Lego?min_rating=4\""));
    }
}
