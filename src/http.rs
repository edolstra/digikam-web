//! HTTP caching helpers shared by the API handlers and the static-asset handlers:
//! `ETag` revalidation (`If-None-Match` → `304`) and the immutable `Cache-Control`.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;

/// `Cache-Control` for content-addressed, effectively-immutable assets (the PGF
/// thumbnails — keyed by `uniqueHash` — and the embedded webpgf module): cache
/// hard for a year and don't revalidate, so the browser stops re-requesting them
/// on every page load. The strong `ETag` still backs a forced reload / expired
/// entry with a cheap `304`. (A re-edited image keeps its id but gets a new
/// `uniqueHash`/ETag; an `immutable` cache won't notice until a hard refresh.)
pub const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// The `304 Not Modified` to send when the request's `If-None-Match` matches
/// `etag` (or is `*`), carrying the `ETag` and, if given, the `Cache-Control`;
/// `None` when the client's copy is stale (or it sent no `If-None-Match`).
pub fn not_modified(
    headers: &HeaderMap,
    etag: &HeaderValue,
    cache_control: Option<&'static str>,
) -> Option<Response> {
    if !if_none_match_matches(headers, etag) {
        return None;
    }
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NOT_MODIFIED;
    let h = response.headers_mut();
    h.insert(header::ETAG, etag.clone());
    if let Some(cc) = cache_control {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
    }
    Some(response)
}

/// Does the request's `If-None-Match` header match `etag` (or `*`)?
fn if_none_match_matches(headers: &HeaderMap, etag: &HeaderValue) -> bool {
    let Some(value) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let want = strip_weak(etag.to_str().unwrap_or_default());
    value
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == "*" || strip_weak(candidate) == want)
}

/// Strip a weak-validator `W/` prefix for comparison purposes.
fn strip_weak(tag: &str) -> &str {
    tag.strip_prefix("W/").unwrap_or(tag)
}
